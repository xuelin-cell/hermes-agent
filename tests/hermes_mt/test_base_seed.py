"""基础镜像的预置（deploy/hermes-mt/scripts/base_seed.py）：Dockerfile 副本的插入点、各文件的备用来源。

部署机连 GitHub 极慢、连不上 Playwright 的 CDN，deploy.sh base 靠这个脚本先把大文件备好、再用它生成的
Dockerfile 副本构建。上游一改 Dockerfile 的结构，插入点就找不到——这里先报出来，不要等到部署时。
"""

from __future__ import annotations

import importlib.util
import asyncio
import base64
import hashlib
import io
import json
import os
import re
import shutil
import tarfile
from pathlib import Path

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "deploy" / "hermes-mt" / "scripts" / "base_seed.py"


def _module():
    spec = importlib.util.spec_from_file_location("base_seed", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_dockerfile_copy_adds_the_two_seed_copies_in_place() -> None:
    seed = _module()
    original = (REPO / "Dockerfile").read_text(encoding="utf-8")
    derived = seed.derive_dockerfile(original).splitlines()

    # Remove the intentional injections; other upstream instructions survive unchanged.
    mirror = "".join(seed.APT_MIRROR_LINES).splitlines()
    restored, index = [], 1
    extras = {seed.PYTHON_TIMEOUT_ARG.strip(), seed.NPM_REGISTRY_ARG.strip(), seed.NPM_REGISTRY_ENV.strip(),
              'COPY --from=seed s6/ /tmp/s6-seed/', 'COPY --from=seed pm/ /opt/hermes/tools/'}
    while index < len(derived):
        if derived[index:index + len(mirror)] == mirror:
            index += len(mirror)
            continue
        line = derived[index]
        if line not in extras:
            restored.append(line.replace('npm_config_registry="${NPM_REGISTRY}" npm ci ', 'npm ci ')
                            .replace('--timeout ${PYTHON_BUILD_TIMEOUT} ', ''))
        index += 1
    assert restored == original.splitlines()
    # s6 的包要在下载它们的那段 RUN 之前就位；pm 的要在 ensure 之前
    s6_copy = derived.index("COPY --from=seed s6/ /tmp/s6-seed/")
    pm_copy = derived.index("COPY --from=seed pm/ /opt/hermes/tools/")
    s6_run = next(i for i, line in enumerate(derived) if "s6-overlay-noarch.tar.xz" in line)
    ensure = next(i for i, line in enumerate(derived) if "from pm import ensure" in line)
    assert s6_copy < s6_run and pm_copy < ensure
    # 构建时 S6_OVERLAY_BASE_URL 换成 file:///tmp/s6-seed，下载那段按 ${base}/<文件名> 取
    assert re.search(r'base="\$\{S6_OVERLAY_BASE_URL\}/v\$\{S6_OVERLAY_VERSION\}"', original)


def test_every_debian_stage_switches_the_apt_mirror_before_its_first_apt_get() -> None:
    seed = _module()
    original = (REPO / "Dockerfile").read_text(encoding="utf-8")
    derived = seed.derive_dockerfile(original).splitlines()
    stages = [i for i, line in enumerate(derived) if line.startswith("FROM ")]
    debian = [i for i in stages if derived[i].startswith(seed.DEBIAN_FROM)]
    assert len(debian) == 2  # sqlite_build、runtime_base；其余阶段都从它们派生，继承换好的源
    for start in debian:
        end = next((i for i in stages if i > start), len(derived))
        apt = next(i for i in range(start, end) if "apt-get" in derived[i] and "update" in derived[i])
        switch = next(i for i in range(start, end) if "s|deb.debian.org|${APT_MIRROR}|g" in derived[i])
        assert derived[start + 1] == "ARG APT_MIRROR=mirrors.aliyun.com" and switch < apt


def test_a_dockerfile_without_the_insertion_points_is_refused() -> None:
    seed = _module()
    original = (REPO / "Dockerfile").read_text(encoding="utf-8")
    with pytest.raises(ValueError):
        seed.derive_dockerfile(original.replace("COPY scripts/bundles/payload.py scripts/bundles/payload.py\n", ""))
    with pytest.raises(ValueError, match='npm'):
        seed.derive_dockerfile(original.replace(' AS frontend_build\n', ' AS renamed_frontend\n'))
    with pytest.raises(ValueError, match='npm'):
        seed.derive_dockerfile(original.replace('    npm ci ', '    npm install '))


def test_npm_mirror_covers_build_installs_without_changing_the_runtime_default() -> None:
    seed = _module()
    original = (REPO / 'Dockerfile').read_text(encoding='utf-8')
    derived = seed.derive_dockerfile(original)
    frontend = derived.split(' AS frontend_build\n', 1)[1].split('\nFROM ', 1)[0]
    runtime = derived.split(' AS runtime\n', 1)[1]
    assert frontend.index(seed.NPM_REGISTRY_ARG) < frontend.index(seed.NPM_REGISTRY_ENV) < frontend.index('RUN node scripts/build/node-deps.mjs')
    assert seed.NPM_REGISTRY_ARG in runtime
    assert 'npm_config_registry="${NPM_REGISTRY}" npm ci ' in runtime
    assert seed.NPM_REGISTRY_ENV not in runtime


def test_every_seeded_pm_package_is_pinned_for_linux_x64() -> None:
    seed = _module()
    lock = json.loads((REPO / "pm" / "lock.json").read_text(encoding="utf-8"))
    for name in seed.PM_PACKAGES:
        artifacts = lock["packages"][name]["artifacts"]
        art = artifacts.get("linux-x64") or artifacts.get("any")
        assert art and re.fullmatch(r"[0-9a-f]{64}", art["sha256"]), name


def test_the_repository_carries_the_s6_overlay_packages_the_dockerfile_pins() -> None:
    """部署机连不上 GitHub，s6-overlay 的三个包放在仓库里。上游一升版本，这里先报出来。"""
    seed = _module()
    dockerfile = (REPO / "Dockerfile").read_text(encoding="utf-8")
    version = re.search(r"^ARG S6_OVERLAY_VERSION=(\S+)$", dockerfile, re.M).group(1)
    vendor = REPO / "deploy" / "hermes-mt" / "vendor" / "s6-overlay" / f"v{version}"
    for filename, key in seed.S6_FILES:
        pinned = re.search(rf"^ARG {key}=([0-9a-f]{{64}})$", dockerfile, re.M).group(1)
        path = vendor / filename
        assert path.is_file(), f"仓库里没有 {path.relative_to(REPO)}"
        assert seed.sha256_of(str(path)) == pinned, filename


def test_npmmirror_holds_the_same_paths_for_the_mirrored_hosts() -> None:
    seed = _module()
    assert seed.npmmirror("https://nodejs.org/dist/v26.7.0/node-v26.7.0-linux-x64.tar.xz") == (
        "https://cdn.npmmirror.com/binaries/node/v26.7.0/node-v26.7.0-linux-x64.tar.xz"
    )
    assert seed.npmmirror("https://cdn.playwright.dev/builds/cft/145.0.7632.6/linux64/chrome-linux64.zip") == (
        "https://cdn.npmmirror.com/binaries/chrome-for-testing/145.0.7632.6/linux64/chrome-linux64.zip"
    )
    assert seed.npmmirror("https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/x.tar.gz") is None


@pytest.mark.asyncio
@pytest.mark.platforms('posix')
@pytest.mark.parametrize('corrupt', [False, True])
async def test_npm_uses_the_mirror_for_locked_official_urls_and_keeps_integrity(tmp_path, corrupt):
    npm = shutil.which('npm')
    if not npm:
        pytest.skip('Node/npm unavailable')
    name = 'hermes-mirror-probe'
    def archive(version):
        buffer = io.BytesIO()
        data = json.dumps({'name': name, 'version': version}).encode()
        with tarfile.open(fileobj=buffer, mode='w:gz') as output:
            item = tarfile.TarInfo('package/package.json')
            item.size = len(data)
            output.addfile(item, io.BytesIO(data))
        return buffer.getvalue()
    original = archive('1.0.0')
    payload = archive('1.0.1') if corrupt else original
    integrity = 'sha512-' + base64.b64encode(hashlib.sha512(original).digest()).decode()
    (tmp_path / 'package.json').write_text(json.dumps({'name': 'mirror-test', 'version': '1.0.0', 'dependencies': {name: '1.0.0'}}))
    (tmp_path / 'package-lock.json').write_text(json.dumps({'name': 'mirror-test', 'version': '1.0.0', 'lockfileVersion': 3,
        'packages': {'': {'name': 'mirror-test', 'version': '1.0.0', 'dependencies': {name: '1.0.0'}},
            'node_modules/' + name: {'version': '1.0.0', 'resolved': f'https://registry.npmjs.org/{name}/-/{name}-1.0.0.tgz', 'integrity': integrity}}}))
    requests = []
    async def download(request):
        requests.append(request.path)
        return web.Response(body=payload, content_type='application/octet-stream')
    app = web.Application()
    app.router.add_get('/{tail:.*}', download)
    async with TestServer(app) as server:
        process = await asyncio.create_subprocess_exec(npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund',
            '--fetch-retries=0', '--fetch-timeout=3000', '--cache', str(tmp_path / 'cache'), cwd=tmp_path,
            env={'PATH': os.environ['PATH'], 'npm_config_registry': str(server.make_url('')),
                'npm_config_userconfig': str(tmp_path / 'user.npmrc'), 'npm_config_globalconfig': str(tmp_path / 'global.npmrc'),
                'npm_config_update_notifier': 'false'},
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), 15)
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
    assert f'/{name}/-/{name}-1.0.0.tgz' in requests
    if corrupt:
        assert process.returncode != 0 and b'EINTEGRITY' in stderr
    else:
        assert process.returncode == 0, (stdout + stderr).decode(errors='replace')
        assert json.loads((tmp_path / 'node_modules' / name / 'package.json').read_text())['version'] == '1.0.0'


def test_cloud_python_timeout_changes_only_the_dependency_build_and_keeps_cache() -> None:
    seed = _module()
    original = (REPO / 'Dockerfile').read_text(encoding='utf-8')
    derived = seed.derive_dockerfile(original)
    stage = derived.split(' AS python_deps\n', 1)[1].split('\nFROM ', 1)[0]
    assert stage.index(seed.PYTHON_TIMEOUT_ARG) < stage.index('--timeout ${PYTHON_BUILD_TIMEOUT}')
    assert '--mount=type=cache,id=hermes-python-uv' in stage
    assert '--cache /root/.cache/uv' in stage
    assert derived.count('--timeout ${PYTHON_BUILD_TIMEOUT}') == 1
    with pytest.raises(ValueError, match='Python'):
        seed.derive_dockerfile(original.replace(seed.PYTHON_BUILD, 'python3 -m different_builder '))
