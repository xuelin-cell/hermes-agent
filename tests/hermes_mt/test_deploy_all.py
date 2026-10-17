"""deploy.sh all 一键部署：缺什么补什么。

桌面版和云端版统一后，前端和 hermes 本体都跟着桌面版走，合一次桌面版往往两样都变：
- 基础镜像（hermes 本体）缺当前指纹的，all 自己先建（以前停下来让人先跑 base）；
- 前端产物不是当前代码构建的，all / up 自己重建（以前只看产物在不在：忘了跑 build-frontend.sh，
  就把旧前端发出去，还不报错）。
前端指纹由 scripts/build-frontend.sh 算，构建成功时写进产物，nginx 镜像不带它。
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEPLOY = REPO / "deploy" / "hermes-mt"
SCRIPT = (DEPLOY / "deploy.sh").read_text(encoding="utf-8")
BUILD = (DEPLOY / "scripts" / "build-frontend.sh").read_text(encoding="utf-8")


def _function(source: str, name: str) -> str:
    start = source.index(f"\n{name}() {{\n")
    return source[start : source.index("\n}\n", start)]


def _steps(body: str) -> list[str]:
    """函数体里按顺序调用的部署步骤（行首的 cmd_* / ensure_* / plan / build_base）。"""
    return re.findall(r"^\s+(cmd_\w+|ensure_\w+|plan|build_base)\b", body, re.M)


def test_all_builds_what_is_missing_before_checking_and_deploying() -> None:
    steps = _steps(_function(SCRIPT, "cmd_all"))
    assert steps.index("plan") < steps.index("ensure_base") < steps.index("ensure_frontend") < steps.index("cmd_check")
    assert steps.index("cmd_check") < steps.index("cmd_image") < steps.index("cmd_template") < steps.index("cmd_up")


def test_only_the_fingerprinted_base_image_is_built_automatically() -> None:
    body = _function(SCRIPT, "ensure_base")
    assert body.index('[ "$BASE_IMAGE" = "$(base_tag)" ]') < body.index("build_base")
    assert "build_base" in _steps(_function(SCRIPT, "cmd_base"))


def test_up_rebuilds_a_stale_frontend_before_building_nginx() -> None:
    body = _function(SCRIPT, "cmd_up")
    assert body.index("ensure_frontend") < body.index("up -d --build")
    # 以前前端产物为空时从外部目录（旧版本的发布目录）拷一份，现在一律从本仓库构建。
    assert "FRONTEND_SRC" not in SCRIPT


def test_frontend_freshness_is_the_fingerprint_written_by_the_build() -> None:
    assert 'build-frontend.sh" --fingerprint' in SCRIPT
    assert "nginx/dist-browser/.source-fingerprint" in SCRIPT
    ensure = _function(SCRIPT, "ensure_frontend")
    assert ensure.index("frontend_want") < ensure.index("build-frontend.sh") < ensure.rindex("frontend_have")


def test_build_frontend_writes_the_fingerprint_only_after_the_new_build_is_in_place() -> None:
    assert BUILD.index('if [ "${1:-}" = --fingerprint ]') < BUILD.index("docker run")
    assert BUILD.index('cp -a "$REPO/apps/desktop/dist-browser" "$OUT"') < BUILD.index('> "$OUT/.source-fingerprint"')


def test_the_fingerprint_covers_what_the_browser_build_reads() -> None:
    body = _function(BUILD, "fingerprint").replace("\\\n", " ")
    for path in ("apps", "package.json", "package-lock.json", ".npmrc",
                 "deploy/hermes-mt/scripts/build-frontend.sh", "deploy/hermes-mt/vendor/npm"):
        assert f" {path}" in body, path
    assert "git -C" not in body  # 部署机的 git 是 1.8


def test_the_renderer_imports_nothing_outside_apps() -> None:
    """前端指纹只算 apps/：正式代码引用了 apps/ 以外的文件，改那个文件就不会触发重建。"""
    src = REPO / "apps" / "desktop" / "src"
    outside = []
    for file in src.rglob("*.ts*"):
        if ".test." in file.name:
            continue
        for target in re.findall(r"""(?:\bfrom|\bimport\(?)\s*['"](\.\.?/[^'"]+)['"]""", file.read_text(encoding="utf-8")):
            resolved = (file.parent / target.split("?")[0]).resolve()
            if REPO / "apps" not in resolved.parents:
                outside.append(f"{file.relative_to(REPO).as_posix()} -> {target}")
    assert not outside, outside


def test_generated_files_stay_out_of_git_and_out_of_the_page() -> None:
    ignored = (DEPLOY / ".gitignore").read_text(encoding="utf-8").splitlines()
    for name in (".frontend-build.log", ".deploy-logs/", ".deploy-running", ".deploy-last-exit"):
        assert name in ignored, name
    assert "dist-browser/.source-fingerprint" in (DEPLOY / "nginx" / ".dockerignore").read_text(encoding="utf-8").splitlines()


# ---- 在终端里敲：后台跑、前台实时看（实际行为在 Linux 的伪终端里验过：Ctrl+C、并发、失败、重定向、log） ----

def test_long_commands_typed_in_a_terminal_run_detached_and_are_followed() -> None:
    main = _function(SCRIPT, "main")
    assert re.search(r'if \[ -z "\$\{MT_DEPLOY_DETACHED:-\}" \] && \[ -t 1 \]; then\s+run_detached', main)
    assert main.index("run_detached") < main.index("register_run") < main.index("load_cfg")
    detached = _function(SCRIPT, "run_detached")
    assert "setsid bash" in detached and "< /dev/null &" in detached
    assert "tail -n +1 -f --pid=" in _function(SCRIPT, "follow_run")


def test_the_relaunch_survives_bash_4_2_with_no_arguments() -> None:
    # 部署机的 bash 4.2：set -u 下 "${args[@]}" 展开空数组会报 unbound variable。
    assert 'run_detached "$cmd" ${args[@]+"${args[@]}"}' in _function(SCRIPT, "main")


def test_one_deploy_at_a_time_and_the_result_is_kept() -> None:
    register = _function(SCRIPT, "register_run")
    assert '[ "$pid" != "$$" ]' in register and "die " in register
    cleanup = _function(SCRIPT, "cleanup")
    assert cleanup.split("\n")[2].strip() == "local rc=$?"  # 第一句就取退出码，后面的命令会改掉 $?
    assert '= "$$" ]' in cleanup and '> "$LAST_EXIT"' in cleanup and 'rm -f "$RUNNING"' in cleanup


def test_the_usage_text_shows_the_whole_header() -> None:
    printed = re.search(r"sed -n '2,(\d+)p' \"\$SCRIPT\"", SCRIPT)
    lines = SCRIPT.splitlines()
    end = int(printed.group(1))
    assert "./deploy.sh log" in "\n".join(lines[1:end])
    assert lines[end] == "#", lines[end]  # 用法说明到空注释行为止，正好打全
