"""Cloud kit preparation runs on deployment hosts without installing agent dependencies."""

import json
import os
from pathlib import Path
import subprocess
import sys
import zipfile

import pytest


REPO = Path(__file__).resolve().parents[2]


@pytest.fixture(params=("native", "python36"))
def build_command(request, tmp_path):
    script = REPO / "deploy/hermes-mt/scripts/build-kits.py"
    if request.param == "native":
        return [sys.executable, str(script)]
    image = "python:3.6.15-slim-buster"
    try:
        available = subprocess.run(["docker", "image", "inspect", image],
                                   capture_output=True, timeout=5)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pytest.skip("Python 3.6 container runtime is unavailable")
    if available.returncode:
        pytest.skip("Pre-pull python:3.6.15-slim-buster to run the legacy deployment check")
    # No network, Docker socket or home-directory mount; only this checkout and test data.
    return ["docker", "run", "--rm", "--network", "none",
            "--mount", f"type=bind,source={REPO},target={REPO},readonly",
            "--mount", f"type=bind,source={tmp_path},target={tmp_path}",
            "-e", "PYTHONDONTWRITEBYTECODE=1", "-e", "UNIWORK_BUNDLED_PLUGINS",
            "-e", "UNIWORK_BUNDLED_PLUGINS_REF", image, "python3", str(script)]


def test_kit_build_preserves_resources_and_fingerprints_content_changes(tmp_path, build_command):
    config = tmp_path / "config"
    source = config / "plugins" / "uniwork-bundled"
    packages = source / "plugins"
    packages.mkdir(parents=True)
    archive = packages / "expert.zip"
    avatar = source / "avatars" / "expert.png"
    avatar.parent.mkdir()
    avatar.write_bytes(b"avatar bytes")
    output = tmp_path / "output"
    env = dict(os.environ, UNIWORK_BUNDLED_PLUGINS=str(config), UNIWORK_BUNDLED_PLUGINS_REF="")

    def package(content):
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr("expert/plugin.json", json.dumps({"name": "expert"}))
            bundle.writestr("expert/README.md", content)

    def stage():
        result = subprocess.run([*build_command, str(output)], env=env,
                                capture_output=True, text=True, timeout=60)
        assert result.returncode == 0, result.stderr
        return (output / ".fingerprint").read_text()

    package("first resource")
    first = stage()
    assert stage() == first
    staged = output / "plugins/uniwork-kits/bundled/uniwork-bundled"
    assert (staged / "plugins/expert.zip").read_bytes() == archive.read_bytes()
    assert (staged / "avatars/expert.png").read_bytes() == avatar.read_bytes()
    package("updated resource")
    assert stage() != first
    assert (staged / "plugins/expert.zip").read_bytes() == archive.read_bytes()


def test_invalid_kits_fail_without_overwriting_a_previous_build(tmp_path, build_command):
    config = tmp_path / "config" / "plugins" / "uniwork-bundled" / "plugins"
    config.mkdir(parents=True)
    (config / "expert.zip").write_text("version https://git-lfs.github.com/spec/v1\n")
    output = tmp_path / "output"
    output.mkdir()
    fingerprint = output / ".fingerprint"
    fingerprint.write_text("previous successful build")
    result = subprocess.run(
        [*build_command, str(output)],
        env=dict(os.environ, UNIWORK_BUNDLED_PLUGINS=str(config.parent), UNIWORK_BUNDLED_PLUGINS_REF=""),
        capture_output=True, text=True, timeout=60,
    )
    assert result.returncode != 0
    assert "no installable" in result.stderr
    assert fingerprint.read_text() == "previous successful build"
