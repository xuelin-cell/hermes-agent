"""真实插件与原生技能工具验证声明名解析、账号隔离和原有冲突保护。"""

import json
from contextlib import contextmanager
from pathlib import Path

from tests.plugins.test_uniwork_kits_plugin import _write, kits, profile_env  # noqa: F401


def _skill(path: Path, name: str, body: str) -> None:
    """在临时账号里创建技能和配套文件，不依赖用户实际目录。"""
    _write(path / "SKILL.md", f"---\nname: {name}\ndescription: Example skill\n---\n{body}\n")
    _write(path / "references" / "guide.md", f"reference:{body}")


def _config(home: Path, **skills) -> None:
    """写入当前用例的插件和技能配置，使用 JSON 兼容的 YAML。"""
    _write(home / "config.yaml", json.dumps({
        "plugins": {"enabled": ["uniwork-kits"]}, "skills": skills,
    }))


def _install(kits, home: Path, package: Path) -> None:
    """用实际安装器装入与公共技能目录同名的套件技能。"""
    _write(package / "plugin.json", json.dumps({"name": "hot-skills", "version": "1.0.0"}))
    _skill(package / "skills" / "video-frames", "video-frames", "kit video")
    assert kits.installer.install(
        package, home, allow_overlap=True, generate_triggers=False, triggers={},
    ).ok


@contextmanager
def _scope(home: Path):
    """同时绑定账号目录和密钥作用域，模拟同一进程切换账号。"""
    from agent.secret_scope import reset_secret_scope, set_secret_scope
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    token = set_hermes_home_override(str(home))
    secret_token = set_secret_scope({}, profile_home=str(home))
    try:
        yield
    finally:
        reset_secret_scope(secret_token)
        reset_hermes_home_override(token)


def _call(name: str, task: str, **extra) -> dict:
    """走模型工具的真实钩子、参数改写、注册表及技能读取链路。"""
    from model_tools import handle_function_call

    return json.loads(handle_function_call("skill_view", {"name": name, **extra}, task_id=task))


def test_declared_names_load_the_right_skill_and_resources_across_accounts(kits, profile_env, tmp_path, monkeypatch):
    """A→B→A 下公共名和套件名精确读取，不借用启动账号目录，PPT 规则仍识别路径。"""
    from agent.secret_scope import is_multiplex_active, set_multiplex_active
    from hermes_cli.plugins import discover_plugins

    monkeypatch.chdir(tmp_path)
    other = tmp_path / "另一个用户 with spaces" / "account-b"
    homes = (profile_env, other)
    public_dirs = ("uniwork/video-frames", "uniwork/category/video-frames")
    for home, relative in zip(homes, public_dirs):
        _config(home)
        _skill(home / "skills" / relative, "video-frames", f"public:{home.name}")
        _install(kits, home, tmp_path / "package")
    discover_plugins(force=True)
    multiplex = is_multiplex_active()
    set_multiplex_active(True)
    try:
        for number, home in enumerate((profile_env, other, profile_env)):
            with _scope(home):
                public = _call("video-frames", f"public-{number}")
                assert public.get("success"), public
                assert public["content"].strip().endswith(f"public:{home.name}")
                assert Path(public["skill_dir"]).is_relative_to(home)
                resource = _call("video-frames", f"public-file-{number}", file_path="references/guide.md")
                assert resource.get("success"), resource
                assert resource["content"] == f"reference:public:{home.name}"
                kit = _call("hot-skills--video-frames", f"kit-{number}")
                assert kit.get("success"), kit
                assert kit["name"] == "hot-skills--video-frames"
                assert kit["content"].strip().endswith("kit video")
                assert Path(kit["skill_dir"]).is_relative_to(home)
                kit_file = _call("hot-skills--video-frames", f"kit-file-{number}", file_path="references/guide.md")
                assert kit_file.get("success"), kit_file
                assert kit_file["content"] == "reference:kit video"
        with _scope(profile_env):
            moved = profile_env / "skills/uniwork/relocated/video-frames"
            moved.parent.mkdir(parents=True)
            (profile_env / "skills" / public_dirs[0]).rename(moved)
            assert _call("video-frames", "after-move")["skill_dir"] == str(moved)
            kits.installer.uninstall(profile_env, "hot-skills")
            assert not _call("hot-skills--video-frames", "after-uninstall").get("success")
        assert kits.host_hooks.is_ppt_skill("skill_view", {"name": "kits/ppt-writer/skills/create-ppt"})
        assert kits.host_hooks.is_ppt_skill("skill_view", {"name": "kits/pptx"})
        assert not kits.host_hooks.is_ppt_skill("skill_view", {"name": "kits/other/skills/create-ppt"})
    finally:
        set_multiplex_active(multiplex)


def test_resolution_preserves_conflicts_disabled_skills_and_explicit_paths(kits, profile_env, tmp_path, monkeypatch):
    """用户、外部与项目候选保留原生规则，停用和配套文件越界检查仍有效。"""
    from hermes_cli.plugins import discover_plugins

    monkeypatch.chdir(tmp_path)
    _config(profile_env)
    public = profile_env / "skills/uniwork/video-frames"
    _skill(public, "video-frames", "public")
    _install(kits, profile_env, tmp_path / "package")
    discover_plugins(force=True)
    with _scope(profile_env):
        original = {"name": "uniwork/video-frames", "file_path": "references/guide.md"}
        assert kits.root.skill_paths.on_pre_tool_call("skill_view", original) is None
        assert _call(original["name"], "explicit", file_path=original["file_path"])["success"]
        assert original == {"name": "uniwork/video-frames", "file_path": "references/guide.md"}
        assert kits.root.skill_paths.on_pre_tool_call("terminal", {"name": "video-frames"}) is None
        assert not _call("video-frames", "escape", file_path="../../outside.txt").get("success")

        duplicate = profile_env / "skills/private/duplicate"
        _skill(duplicate, "video-frames", "user skill")
        conflict = _call("video-frames", "true-conflict")
        assert not conflict.get("success") and "Ambiguous" in conflict["error"]
        (duplicate / "SKILL.md").unlink()

        external = tmp_path / "external"
        _skill(external / "video-frames", "video-frames", "external skill")
        _config(profile_env, external_dirs=[str(external)])
        conflict = _call("video-frames", "external-conflict")
        assert not conflict.get("success") and "Ambiguous" in conflict["error"]

        project = tmp_path / "project"
        (project / ".git").mkdir(parents=True)
        _skill(project / ".hermes/skills/video-frames", "video-frames", "project skill")
        _config(profile_env, trusted_project_dirs=[str(project)])
        monkeypatch.chdir(project)
        assert _call("video-frames", "project-priority")["content"].strip().endswith("project skill")
        monkeypatch.chdir(tmp_path)

        _config(profile_env)
        kits.installer.set_enabled(profile_env, "hot-skills", False)
        assert _call("video-frames", "disabled-kit-public")["success"]
        assert not _call("hot-skills--video-frames", "disabled-kit").get("success")
        kits.installer.set_enabled(profile_env, "hot-skills", True)
        _config(profile_env, disabled=["video-frames", "hot-skills--video-frames"])
        for name in ("video-frames", "hot-skills--video-frames"):
            disabled = _call(name, f"disabled-{name}")
            assert not disabled.get("success") and "disabled" in disabled["error"]
