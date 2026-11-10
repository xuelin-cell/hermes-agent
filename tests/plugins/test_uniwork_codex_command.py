"""Native command dispatch and account-only execution, without live model calls."""

import argparse
import importlib
import hashlib
import json
import pytest
from tests.plugins.test_uniwork_kits_plugin import kits  # noqa: F401


@pytest.fixture
def codex(kits, monkeypatch):
    """加载数字员工插件中的 CLI 包装。"""
    from hermes_cli.plugins_state import PluginState
    from types import SimpleNamespace

    module = importlib.import_module("hermes_plugins.uniwork_kits.codex")
    # 仅隔离测试开启保留实现；生产入口维持关闭。
    monkeypatch.setattr(module, "ENABLED", True)
    module.set_context(SimpleNamespace(state=PluginState("uniwork-kits")))
    return module


def account(tmp_path, name):
    """建立隔离账号配置，不使用开发机凭据。"""
    home = tmp_path / name / "home"
    home.mkdir(parents=True)
    (home.parent / "account-id").write_text(
        "account-" + hashlib.sha256(name.encode()).hexdigest()
    )
    api = "https://example.invalid/" + name
    provider = "desktop-mt-maas-" + hashlib.sha256(api.encode()).hexdigest()
    config = {
        "model": {"provider": "custom:" + provider, "default": name},
        "providers": {
            provider: {
                "api": api,
                "key_env": "DESKTOP_MT_MAAS_API_KEY",
                "transport": "chat_completions",
                "models": {name: {}},
            }
        },
    }
    (home / "config.yaml").write_text(json.dumps(config))
    (home / ".env").write_text('DESKTOP_MT_MAAS_API_KEY="key-' + name + '"\n')
    return home


def session(home, text, model=None, provider=None, session_id="session"):
    """用原生数据库写入用户输入和目录。"""
    from hermes_state import SessionDB

    cwd = home / "work"
    cwd.mkdir(exist_ok=True)
    db = SessionDB(home / "state.db")
    config = json.loads((home / "config.yaml").read_text())
    db.create_session(
        session_id,
        "desktop",
        cwd=str(cwd),
        model=model or config["model"]["default"],
        model_config={"provider": provider or config["model"]["provider"]},
    )
    db.append_message(session_id, "user", text)
    db.close()
    return cwd


def test_account_profile_a_b_a(codex, tmp_path, monkeypatch):
    """Profile 不使用其他账号或继承的个人凭据。"""
    a, b = account(tmp_path, "a"), account(tmp_path, "b")
    profile = a / "profiles" / "expert"
    profile.mkdir(parents=True)
    (profile / "config.yaml").write_text((a / "config.yaml").read_text())
    monkeypatch.setenv("OPENAI_API_KEY", "personal")
    monkeypatch.setenv("DESKTOP_MT_MAAS_API_KEY", "foreign")
    for home in (a, b, profile):
        session(home, "/codex task")
    assert [
        codex.account_model(p, codex.invocation(p, "session", "/codex task")[2])[
            "api_key"
        ]
        for p in (a, b, profile, a)
    ] == [
        "key-a",
        "key-b",
        "key-a",
        "key-a",
    ]


@pytest.mark.parametrize(
    "change", ["personal", "missing_key", "endpoint", "alias", "unowned"]
)
def test_reject_resources(codex, tmp_path, change):
    """资源不匹配时拒绝，不回退。"""
    home = account(tmp_path, "a")
    config = json.loads((home / "config.yaml").read_text())
    provider = next(iter(config["providers"].values()))
    if change == "personal":
        config["model"]["provider"] = "openai"
    if change == "missing_key":
        (home / ".env").write_text("OPENAI_API_KEY=personal\n")
    if change == "endpoint":
        provider["api"] = "https://foreign.invalid"
    if change == "alias":
        provider["api_key"] = "personal"
    if change == "unowned":
        (home.parent / "account-id").unlink()
    (home / "config.yaml").write_text(json.dumps(config))
    with pytest.raises(ValueError):
        session(home, "/codex task")
        codex.account_model(home, codex.invocation(home, "session", "/codex task")[2])


@pytest.mark.parametrize(
    "text", ["写代码", "/codex", "请参考 /codex 修复", "/codexx 修复"]
)
def test_only_explicit_current_user(codex, tmp_path, text):
    """普通输入或裸命令不提供启动资格。"""
    home = account(tmp_path, "a")
    session(home, text)
    with pytest.raises(ValueError):
        codex.invocation(home, "session", text)


def request(codex, home, text="/codex task", turn_id="turn"):
    """经过真实插件接点准备命令，不能从数据库最新消息推断任务。"""
    codex.on_pre_llm_call(session_id="session", turn_id=turn_id, user_message=text)


@pytest.mark.parametrize("queued", ["/codex task-B", "普通消息"])
def test_queued_input_does_not_replace_active_task(
    codex, kits, tmp_path, monkeypatch, queued
):
    """排队Codex/普通消息不改变A；进入普通新轮后旧授权失效。"""
    from hermes_state import SessionDB

    home = account(tmp_path, "a")
    cwd = session(home, "/codex task-A")
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_SESSION_ID", "session")
    codex.on_pre_llm_call(
        session_id="session", turn_id="active", user_message="/codex task-A"
    )
    db = SessionDB(home / "state.db")
    db.append_message("session", "user", queued)
    db.close()
    captured = []
    monkeypatch.setattr(codex, "execute", lambda config: captured.append(config) or 0)
    assert codex.run() == 0
    assert captured[0]["prompt"] == "task-A"
    assert captured[0]["cwd"] == str(cwd)
    codex.on_pre_llm_call(session_id="session", turn_id="next", user_message="普通请求")
    assert codex.run() == 2
    assert len(captured) == 1


def test_command_dispatch_and_cli(codex, kits, tmp_path, monkeypatch):
    """斜杠命令确认任务后，经当前轮次上下文进入原有CLI。"""
    home = account(tmp_path, "a")
    monkeypatch.setenv("HERMES_HOME", str(home))
    assert codex.command("  ") == "用法：/codex <任务内容>"
    text = codex.command("修复测试\n保留  两个空格")
    cwd = session(home, text)
    monkeypatch.setenv("HERMES_SESSION_ID", "session")
    captured = []
    monkeypatch.setattr(codex, "execute", lambda config: captured.append(config) or 0)
    parser = argparse.ArgumentParser()
    kits.root.cli.setup(parser)
    context = codex.on_pre_llm_call(
        session_id="session", turn_id="turn", user_message=text
    )
    assert "hermes kit codex" in context["context"]
    with pytest.raises(SystemExit) as result:
        kits.root.cli.handle(parser.parse_args(["codex"]))
    assert result.value.code == 0
    assert captured[0]["prompt"] == "修复测试\n保留  两个空格"
    assert captured[0]["api_key"] == "key-a"
    assert captured[0]["cwd"] == str(cwd)
    assert (
        codex.on_pre_llm_call(
            session_id="session", turn_id="next", user_message="普通请求"
        )
        is None
    )


@pytest.mark.parametrize("edited", [False, True])
def test_retired_skill_removed_by_native_sync(tmp_path, monkeypatch, edited):
    """原生发行升级删除旧卡片；用户编辑副本移入隐藏归档，其他技能保留。"""
    import shutil
    import tools.skills_sync as sync
    from agent.skill_commands import reload_skills, scan_skill_commands

    home = account(tmp_path, "upgrade")
    monkeypatch.setenv("HERMES_HOME", str(home))
    bundled = tmp_path / "bundle"
    old = bundled / "uniwork/codex"
    old.mkdir(parents=True)
    (old / "SKILL.md").write_text(
        "---\nname: Codex\ndescription: Previous entry.\n---\nLegacy task instructions.\n"
    )
    other = bundled / "uniwork/kept"
    other.mkdir()
    (other / "SKILL.md").write_text(
        "---\nname: Kept\ndescription: Keep this skill.\n---\nPreserve.\n"
    )
    (bundled / "UNIWORK_BUNDLED_ONLY").write_text("enabled")
    monkeypatch.setattr(sync, "_get_bundled_dir", lambda: bundled)
    sync.sync_skills(quiet=True)
    target = home / "skills/uniwork/codex/SKILL.md"
    if edited:
        target.write_text(target.read_text() + "User-owned edit.\n")
    shutil.rmtree(old)
    for _ in range(2):
        sync.sync_skills(quiet=True)
        reload_skills()
        assert not target.exists()
        assert "/codex" not in scan_skill_commands()
        assert (home / "skills/uniwork/kept/SKILL.md").is_file()
    archived = list((home / "skills/.retired-hermes").rglob("SKILL.md"))
    assert len(archived) == int(edited)
    if edited:
        assert "User-owned edit." in archived[0].read_text()


def test_session_model_switches_without_changing_default(codex, tmp_path, monkeypatch):
    """同一会话 A→B→A 跟随选择；其他会话和账号默认值不受影响。"""
    from hermes_state import SessionDB

    home = account(tmp_path, "default")
    config = json.loads((home / "config.yaml").read_text())
    provider_id = config["model"]["provider"]
    next(iter(config["providers"].values()))["models"].update(
        {
            "chosen-a": {},
            "chosen-b": {},
        }
    )
    (home / "config.yaml").write_text(json.dumps(config))
    session(home, "/codex task", model="chosen-a")
    session(home, "/codex other", model="chosen-b", session_id="other")
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_SESSION_ID", "session")
    captured = []
    monkeypatch.setattr(codex, "execute", lambda config: captured.append(config) or 0)
    db = SessionDB(home / "state.db")
    try:
        for model in ("chosen-a", "chosen-b", "chosen-a"):
            db.update_session_model("session", model, provider_id)
            request(codex, home)
            assert codex.run() == 0
        assert codex.account_model(home, db.get_session("other"))["model"] == "chosen-b"
    finally:
        db.close()
    assert [row["model"] for row in captured] == ["chosen-a", "chosen-b", "chosen-a"]
    assert all(row["api_key"] == "key-default" for row in captured)
    assert (
        json.loads((home / "config.yaml").read_text())["model"]["default"] == "default"
    )


def test_profile_provider_and_session_model(codex, tmp_path):
    """没有会话提供方覆盖时沿用Profile提供方，仍使用会话模型。"""
    home = account(tmp_path, "default")
    config = json.loads((home / "config.yaml").read_text())
    next(iter(config["providers"].values()))["models"]["chosen"] = {}
    (home / "config.yaml").write_text(json.dumps(config))
    profile = home / "profiles" / "expert"
    profile.mkdir(parents=True)
    (profile / "config.yaml").write_text(json.dumps(config))
    assert codex.account_model(profile, {"model": "chosen"})["model"] == "chosen"
    # A pinned session remains independent of a later change to the account default.
    provider = config["model"]["provider"]
    config["model"] = {"provider": "openai", "default": "unrelated"}
    (home / "config.yaml").write_text(json.dumps(config))
    assert (
        codex.account_model(
            profile, {"model": "chosen", "model_config": {"provider": provider}}
        )["model"]
        == "chosen"
    )


@pytest.mark.parametrize(
    "change",
    [
        "missing_model",
        "unknown_model",
        "foreign_provider",
        "foreign_endpoint",
        "wrong_api",
    ],
)
def test_selected_model_never_falls_back(codex, tmp_path, monkeypatch, change):
    """当前选择失效即失败，不改用仍然有效的账号默认模型。"""
    from hermes_state import SessionDB

    home = account(tmp_path, "default")
    session(home, "/codex task")
    db = SessionDB(home / "state.db")
    row = db.get_session("session")
    metadata = json.loads(row["model_config"])
    model = {"missing_model": "", "unknown_model": "not-in-plan"}.get(
        change, row["model"]
    )
    if change == "foreign_provider":
        metadata["provider"] = "openai"
    if change == "foreign_endpoint":
        metadata["base_url"] = "https://foreign.invalid"
    if change == "wrong_api":
        metadata["api_mode"] = "responses"
    db.update_session_meta("session", json.dumps(metadata), model)
    db.close()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_SESSION_ID", "session")
    captured = []
    monkeypatch.setattr(codex, "execute", lambda config: captured.append(config) or 0)
    request(codex, home)
    assert codex.run() == 2
    assert captured == []


def test_desktop_route_replaces_stale_gateway_route(codex, tmp_path):
    """桌面切换后的完整路由优先，不拼接旧提供方的地址。"""
    home = account(tmp_path, "chosen")
    provider = json.loads((home / "config.yaml").read_text())["model"]["provider"]
    selected = {
        "model": "chosen",
        "model_config": {
            "provider": provider,
            "gateway_runtime": {
                "provider": "old",
                "base_url": "https://old.invalid",
                "api_mode": "responses",
            },
        },
    }
    assert (
        codex.account_model(home, selected)["base_url"]
        == "https://example.invalid/chosen"
    )


@pytest.mark.parametrize(
    "args,code", [(["codex", "--help"], 0), (["codex", "--request", "old"], 2)]
)
def test_cli_help_and_obsolete_payload(codex, kits, tmp_path, monkeypatch, args, code):
    """帮助不执行任务，旧参数不能绕过当前轮次。"""
    home = account(tmp_path, "a")
    session(home, "/codex task")
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_SESSION_ID", "session")
    request(codex, home)
    calls = []
    monkeypatch.setattr(codex, "execute", lambda config: calls.append(config) or 0)
    parser = argparse.ArgumentParser()
    kits.root.cli.setup(parser)
    with pytest.raises(SystemExit) as result:
        kits.root.cli.handle(parser.parse_args(args))
    assert result.value.code == code
    assert calls == []


def test_turn_end_and_dead_owner_clear_authorization(codex, tmp_path, monkeypatch):
    """轮次完成或宿主消失后，普通命令不能复用残留输入。"""
    home = account(tmp_path, "a")
    session(home, "/codex task")
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_SESSION_ID", "session")
    calls = []
    monkeypatch.setattr(codex, "execute", lambda config: calls.append(config) or 0)
    request(codex, home, turn_id="new")
    codex.on_post_llm_call(session_id="session", turn_id="old")
    assert codex.run() == 0
    codex.on_post_llm_call(session_id="session", turn_id="new")
    assert codex.run() == 2
    request(codex, home)
    state = codex._context.state
    data = state.get(codex.request_key("session"))
    data["owner_started"] = 0
    state.set(codex.request_key("session"), data)
    assert codex.run() == 2
    assert len(calls) == 1


@pytest.mark.parametrize("present", [True, False])
def test_codex_runtime_uses_managed_package(codex, monkeypatch, tmp_path, present):
    """由PM准备并解析组件，不借用PATH上碰巧存在的个人可执行文件。"""
    import pm
    from types import SimpleNamespace
    import threading

    binary = tmp_path / "managed-codex"
    binary.write_text("fixture")
    calls = []
    event = threading.Event()
    monkeypatch.setenv("PATH", str(tmp_path / "foreign"))
    monkeypatch.setattr(pm, "ensure", lambda name, **kw: calls.append((name, kw)))
    monkeypatch.setattr(
        pm,
        "installed_package",
        lambda name: SimpleNamespace(binary=binary) if present else None,
    )
    if present:
        assert codex.runtime_binary(event) == str(binary)
    else:
        with pytest.raises(FileNotFoundError):
            codex.runtime_binary(event)
    assert calls == [("codex", {"pause_event": event})]


def test_runtime_prepare_failure_is_not_model_failure(codex, monkeypatch, capsys):
    """组件准备失败不启动模型代理，不输出含凭据的异常原文。"""
    import agent.transports.codex_chat_proxy as proxy

    def fail(_):
        """模拟下载失败，原始异常中含不可公开内容。"""
        raise RuntimeError("secret-fixture")

    def forbidden(**_):
        """依赖尚未就绪时不得创建模型代理。"""
        pytest.fail("model proxy started before runtime was ready")

    monkeypatch.setattr(codex, "runtime_binary", fail)
    monkeypatch.setattr(proxy, "CodexChatProxy", forbidden)
    monkeypatch.setattr(codex.signal, "signal", lambda *_: None)
    assert codex.execute({}) == 1
    out = capsys.readouterr().out
    assert "runtime_prepare_failed" in out
    assert "secret-fixture" not in out


def test_disabled_product_entry_cannot_start_runtime(kits, monkeypatch):
    """默认关闭时，斜杠、CLI和残留轮次调用均不能启动执行器。"""
    module = kits.root.codex
    assert module.ENABLED is False
    def unexpected(*args, **kwargs):
        """禁用入口不得读取账号、切换运行环境或启动任务。"""
        pytest.fail("disabled Codex entered its execution path")
    monkeypatch.setattr(module, "execute", unexpected)
    monkeypatch.setattr(module, "desktop_runtime", unexpected)
    monkeypatch.setattr(module, "invocation", unexpected)
    assert module.command("task") == module.DISABLED_MESSAGE
    assert module.on_pre_llm_call(session_id="s", turn_id="t", user_message="/codex task") is None
    assert module.run() == 2
    parser = argparse.ArgumentParser()
    kits.root.cli.setup(parser)
    assert "codex" not in parser.format_help()
    assert parser.parse_args(["list"]).kit_command == "list"
    with pytest.raises(SystemExit) as result:
        parser.parse_args(["codex"])
    assert result.value.code == 2
