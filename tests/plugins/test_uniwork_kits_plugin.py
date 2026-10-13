"""Behaviour tests for the bundled ``plugins/uniwork-kits`` plugin.

Packages are built in a temp dir; installs go into a temp HERMES_HOME, and
visibility is checked through Hermes' real skill-index and slash-command
builders rather than by reading files back the way the installer wrote them.
"""

import importlib.util
import json
import re
import sys
import types
from pathlib import Path

import pytest
import yaml

PLUGIN_DIR = Path(__file__).resolve().parents[2] / "plugins" / "uniwork-kits"


@pytest.fixture
def profile_env(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    (home / ".env").write_text("GLM_API_KEY=test-key\n", encoding="utf-8")
    (home / "config.yaml").write_text("model:\n  provider: zai\n  default: glm-test\n", encoding="utf-8")
    return home


@pytest.fixture
def kits():
    """The plugin package, imported the way the PluginManager imports it."""
    if "hermes_plugins" not in sys.modules:
        ns = types.ModuleType("hermes_plugins")
        ns.__path__ = []
        sys.modules["hermes_plugins"] = ns
    name = "hermes_plugins.uniwork_kits"
    for mod in [m for m in sys.modules if m == name or m.startswith(name + ".")]:
        del sys.modules[mod]
    spec = importlib.util.spec_from_file_location(
        name, PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)]
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    parts = (
        "installer", "host_rules", "router", "store", "naming", "llm", "triggers",
        "media_slot", "xiaohongshu", "deck_check", "package_hooks",
    )
    for part in parts:
        importlib.import_module(f"{name}.{part}")
    return types.SimpleNamespace(
        root=mod,
        **{part: sys.modules[f"{name}.{part}"] for part in parts},
    )


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


@pytest.fixture
def kit_pkg(tmp_path):
    root = tmp_path / "pkgs" / "demo-kit"
    _write(root / "plugin.json", json.dumps({
        "name": "demo-kit",
        "version": "1.2.0",
        "description": "演示套件，用来测试安装器",
        "userConfig": {"API_KEY": {"title": "演示密钥", "sensitive": True, "required": True}},
        "hooks": {"PreToolUse": [{"command": "echo hi"}]},
    }, ensure_ascii=False))
    _write(root / "README.md", "# demo kit\n")
    _write(root / "skills" / "alpha-probe" / "SKILL.md",
           "---\nname: alpha-probe\ndescription: English only description of alpha probe\n---\n"
           "Read ../../README.md, then run ${CLAUDE_PLUGIN_ROOT}/bin/tool.\n"
           "Afterwards hand over to `demo-kit:launch-probe`.\n")
    _write(root / "skills" / "alpha-probe" / "references" / "ref.md", "data at ${CLAUDE_PLUGIN_ROOT}/data.txt\n")
    _write(root / "commands" / "launch-probe.md",
           "---\ndescription: 启动演示流程\n---\n先做 A，再做 B。\n")
    _write(root / "commands" / "review-probe.md",
           "## Usage\n`/project:review-probe <CODE_SCOPE>`\n\n"
           "## Context\n- Scope: $ARGUMENTS\n\n"
           "## Your Role\nYou coordinate four reviewers and merge their findings.\n\n"
           "## Process\n1. Read the code.\n")
    _write(root / "agents" / "helper-probe.md",
           "---\nname: helper-probe\ndescription: 帮忙排查演示问题\ntools: Read, Grep\nmaxTurns: 7\n---\n你是排查助手。\n")
    _write(root / "rules" / "rule.md", "rule\n")
    _write(root / ".mcp.json", json.dumps({"mcpServers": {
        "remote": {"type": "http", "url": "https://example.invalid/mcp",
                   "headers": {"Authorization": "Bearer ${user_config.API_KEY}"}},
        "socket": {"type": "ws", "url": "wss://example.invalid/ws"},
    }}))
    return root


def _expert_pkg(tmp_path, avatar_name="face.png", avatar_bytes=b"\x89PNG\r\n\x1a\n" + b"0" * 32):
    root = tmp_path / "pkgs" / "demo-expert"
    _write(root / ".codebuddy-plugin" / "plugin.json", json.dumps({
        "name": "demo-expert",
        "version": "2.0.0",
        "description": "演示专家",
        "expertType": "agent",
        "agentName": "lead-probe",
        "displayName": {"zh": "演示专家", "en": "Demo"},
        "profession": {"zh": "演示顾问"},
        "avatar": f"avatars/{avatar_name}",
    }, ensure_ascii=False))
    _write(root / "agents" / "lead-probe.md",
           "---\nname: lead-probe\ndescription: lead\n---\n你是小演。开工前用 AskUserQuestion 问清楚，查资料用 WebSearch。\n"
           "| 职责 | 对应 Skill |\n| 演示 | `demo-expert:beta-probe` |\n")
    _write(root / "agents" / "worker-probe.md",
           "---\nname: worker-probe\ndescription: 演示专家的助手\n---\n你负责整理材料。\n")
    _write(root / "skills" / "beta-probe" / "SKILL.md",
           "---\nname: beta-probe\ndescription: 演示专家自己的技能\n---\n正文\n")
    (root / "avatars").mkdir(parents=True)
    (root / "avatars" / avatar_name).write_bytes(avatar_bytes)
    return root


@pytest.fixture
def expert_pkg(tmp_path):
    return _expert_pkg(tmp_path)


@pytest.fixture
def triggers(tmp_path):
    path = tmp_path / "plugin_index.json"
    path.write_text(json.dumps({"plugins": {"demo-kit": {"triggers": {"skill:alpha-probe": ["阿尔法探测", "做阿尔法分析"]}}}},
                               ensure_ascii=False), encoding="utf-8")
    return path


def _index_text(home: Path) -> str:
    import agent.prompt_builder as pb

    pb._SKILLS_PROMPT_CACHE.clear()
    return pb.build_skills_system_prompt(skills_dir_override=home / "skills")


def _config(home: Path) -> dict:
    return yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8")) or {}


def _skill_md(home: Path, plugin: str, rel: str) -> str:
    return (home / "skills" / "kits" / plugin / "skills" / rel / "SKILL.md").read_text(encoding="utf-8")


def _expert_home():
    from hermes_cli.profiles import get_profile_dir

    return Path(get_profile_dir("demo-expert"))


def test_inspect_writes_nothing(kits, profile_env, kit_pkg):
    receipt = kits.installer.inspect(kit_pkg, triggers={})
    assert receipt.kind == "kit" and receipt.ok
    assert "demo-kit--alpha-probe" in receipt.skills
    assert not (profile_env / "imported-plugins").exists()
    assert not (profile_env / "skills" / "kits").exists()


def test_kit_install_is_visible_and_recorded(kits, profile_env, kit_pkg, triggers):
    receipt = kits.installer.install(kit_pkg, profile_env, triggers=kits.installer.load_triggers(triggers))
    assert receipt.ok, receipt.render()

    index = _index_text(profile_env)
    for name in ("demo-kit--alpha-probe", "demo-kit--launch-probe", "demo-kit--agent-helper-probe"):
        assert name in index
    assert "kits/demo-kit/skills:" in index
    # English-only descriptions lead with imported Chinese triggers in the 60-char index.
    alpha_line = next(l for l in index.splitlines() if "demo-kit--alpha-probe" in l)
    assert "阿尔法探测" in alpha_line

    skill_dir = profile_env / "skills" / "kits" / "demo-kit" / "skills" / "alpha-probe"
    retained = (profile_env / "imported-plugins" / "demo-kit" / "1.2.0").resolve().as_posix()
    assert retained in (skill_dir / "SKILL.md").read_text(encoding="utf-8")
    assert retained in (skill_dir / "references" / "ref.md").read_text(encoding="utf-8")
    assert (profile_env / "skills" / "kits" / "demo-kit" / "README.md").is_file()  # ../../README.md resolves

    servers = _config(profile_env).get("mcp_servers") or {}
    remote = servers["plugin_demo-kit_remote"]
    assert remote["headers"]["Authorization"] == "Bearer ${DEMO_KIT_API_KEY}"
    assert not any("socket" in key for key in servers)
    assert any("DEMO_KIT_API_KEY" in m for m in receipt.env_missing)
    assert any("socket" in f for f in receipt.mcp_failed)
    assert any("rules" in item for item in receipt.dropped)
    assert not any("hooks" in item for item in receipt.dropped)

    entry = kits.store.load_index(profile_env)["plugins"]["demo-kit"]
    assert entry["hooks"]["PreToolUse"][0]["command"] == "echo hi"
    assert entry["kind"] == "kit" and "plugin_demo-kit_remote" in entry["mcp_keys"]
    assert entry["user_config"] == [{
        "key": "API_KEY",
        "env": "DEMO_KIT_API_KEY",
        "title": "演示密钥",
        "sensitive": True,
        "required": True,
        "default": None,
    }]


def test_install_records_user_config_defaults(kits, profile_env, tmp_path):
    root = tmp_path / "pkgs" / "cfg-kit"
    _write(root / "plugin.json", json.dumps({
        "name": "cfg-kit",
        "version": "1.0.0",
        "description": "带配置项的套件",
        "userConfig": {
            "API_KEY": {"title": "接口密钥", "sensitive": True, "required": True},
            "REGION": {"title": "地区", "required": False, "default": "cn"},
        },
    }, ensure_ascii=False))
    _write(root / "SKILL.md", "---\nname: cfg-kit\ndescription: 读取地区配置\n---\n正文\n")
    assert kits.installer.install(root, profile_env, triggers={}).ok
    recorded = kits.store.load_index(profile_env)["plugins"]["cfg-kit"]["user_config"]
    by_key = {item["key"]: item for item in recorded}
    assert by_key["API_KEY"]["sensitive"] is True and by_key["API_KEY"]["default"] is None
    assert by_key["API_KEY"]["env"] == "CFG_KIT_API_KEY"
    region = by_key["REGION"]
    assert region["title"] == "地区" and region["sensitive"] is False
    assert region["required"] is False and region["default"] == "cn"
    assert region["env"] == "CFG_KIT_REGION"


def test_slash_commands_keep_the_package_boundary(kits, profile_env, kit_pkg, monkeypatch):
    kits.installer.install(kit_pkg, profile_env, triggers={})
    import agent.skill_commands as sc
    import tools.skills_tool as st

    monkeypatch.setattr(st, "SKILLS_DIR", profile_env / "skills")
    commands = sc.scan_skill_commands()
    assert "/demo-kit-alpha-probe" in commands
    assert not any(c.startswith("/demo-kitalpha") for c in commands)
    assert kits.naming.slash_command("demo-kit--alpha-probe") == "/demo-kit-alpha-probe"


def test_own_namespace_references_point_at_installed_names(kits, profile_env, kit_pkg, expert_pkg):
    kits.installer.install(kit_pkg, profile_env, triggers={})
    assert "`demo-kit--launch-probe`" in _skill_md(profile_env, "demo-kit", "alpha-probe")

    kits.installer.install(expert_pkg, profile_env, triggers={})
    soul = (_expert_home() / "SOUL.md").read_text(encoding="utf-8")
    assert "`demo-expert--beta-probe`" in soul and "demo-expert:beta-probe" not in soul


def test_usage_only_commands_get_a_real_description(kits, profile_env, kit_pkg):
    kits.installer.install(kit_pkg, profile_env, triggers={})
    text = _skill_md(profile_env, "demo-kit", "review-probe")
    from agent.skill_utils import parse_frontmatter

    fm, body = parse_frontmatter(text)
    assert fm["description"] == "[工作流] You coordinate four reviewers and merge their findings."
    assert "`/demo-kit-review-probe`" in body and "没有斜杠命令入口" not in body


def test_root_level_skill_is_installed_once(kits, profile_env, tmp_path):
    root = tmp_path / "pkgs" / "solo-kit"
    _write(root / "plugin.json", json.dumps({"name": "solo-kit", "version": "1.0.0", "description": "单技能套件"},
                                            ensure_ascii=False))
    _write(root / "SKILL.md", "---\nname: solo-kit\ndescription: 单技能演示\n---\n正文\n")
    _write(root / "NOTES.md", "说明\n")
    assert kits.installer.install(root, profile_env, triggers={}).ok

    index = _index_text(profile_env)
    assert "solo-kit--solo-kit" in index
    assert not re.search(r"^\s+- solo-kit:", index, re.M)        # no second copy under the bare name
    assert (profile_env / "skills" / "kits" / "solo-kit" / "NOTES.md").is_file()
    assert not (profile_env / "skills" / "kits" / "solo-kit" / "SKILL.md").exists()


def test_tagged_descriptions_still_lead_with_triggers(kits, profile_env, kit_pkg, tmp_path):
    path = tmp_path / "idx.json"
    path.write_text(json.dumps({"plugins": {"demo-kit": {"triggers": {"skill:review-probe": ["代码评审", "帮我审代码"]}}}},
                               ensure_ascii=False), encoding="utf-8")
    kits.installer.install(kit_pkg, profile_env, triggers=kits.installer.load_triggers(path))
    line = next(l for l in _index_text(profile_env).splitlines() if "demo-kit--review-probe" in l)
    assert "[工作流] 代码评审、帮我审代码｜" in line


@pytest.mark.parametrize("phrases,message,fires", [
    (("帮我看看这段代码", "审查一下代码质量"), "帮我审查一下这段代码", True),   # two near misses add up
    (("看看K线", "今日资金流向"), "帮我查一下宁德时代最近的K线", True),          # core term "K线"
    (("看K线", "看资金流向"), "帮我查一下宁德时代最近的K线和资金流", True),      # two tails, neither phrase contained
    (("代码审查",), "帮我审查一下这段代码", True),                            # both words present, not as one span
    (("测试一下这段代码",), "帮我审查一下这段代码", False),                    # shared tail must not fire alone
    (("帮我看看代码",), "帮我看看这段话通不通顺", False),                      # UniClaw's measured negative
    (("帮我写个爬虫",), "爬虫是什么动物", False),                              # two-character core never fires alone
    (("制作幻灯片",), "今天天气怎么样", False),
    (("制作幻灯片",), "帮我制作幻灯片", True),
])
def test_router_scoring(kits, phrases, message, fires):
    candidate = kits.router.Candidate("p", "skill", "p--s", tuple(phrases))
    hint = kits.router.build_hint(message, [candidate])
    assert (hint is not None) is fires


def test_shared_tail_does_not_outrank_the_review_skill(kits):
    review = kits.router.Candidate(
        "development-essentials", "skill", "development-essentials--review", ("代码审查",),
    )
    tests = kits.router.Candidate(
        "development-essentials", "skill", "development-essentials--test", ("测试一下这段代码",),
    )
    hint = kits.router.build_hint("帮我审查一下这段代码", [review, tests])
    assert hint is not None
    assert "development-essentials--review" in hint
    assert "development-essentials--test" not in hint


def _fake_llm(kits, score=lambda phrase: 0 if phrase.startswith("坏词") else 2, answer_verify=True):
    """A stand-in for ctx.llm: writes one good and one bad phrase per component, then scores them."""
    calls = {"generate": 0, "verify": 0}

    def complete(messages, **_):
        prompt = messages[0]["content"]
        if prompt.startswith("你在审核"):
            calls["verify"] += 1
            if not answer_verify:
                return types.SimpleNamespace(text="")
            answer = {}
            for m in re.finditer(r"^能力 (\d+) \|.*\n  候选：(.*)$", prompt, re.M):
                candidates = [c.split(") ", 1)[1] for c in m.group(2).split("；")]
                answer[m.group(1)] = [score(c) for c in candidates]
            return types.SimpleNamespace(text=json.dumps(answer))
        calls["generate"] += 1
        answer = {}
        for m in re.finditer(r"^(\d+) \| [^|]+ \| ([^|]+) \|", prompt, re.M):
            bare = m.group(2).strip().split("--")[-1]
            answer[m.group(1)] = [f"跑一遍{bare[:5]}流程", f"坏词{m.group(1)}号"]
        return types.SimpleNamespace(text=json.dumps(answer, ensure_ascii=False))

    kits.llm.set_context(types.SimpleNamespace(llm=types.SimpleNamespace(complete=complete)))
    return calls


def _state(kits, home):
    return kits.store.load_index(home)["plugins"]["demo-kit"]["trigger_state"]


def test_generated_triggers_are_verified_before_use(kits, profile_env, kit_pkg):
    calls = _fake_llm(kits)
    receipt = kits.installer.install(kit_pkg, profile_env, triggers={})
    assert calls["generate"] == 1 and calls["verify"] >= 1
    assert any("已由模型生成并复核" in n and "剔除" in n for n in receipt.notes)

    stored = kits.store.load_index(profile_env)["plugins"]["demo-kit"]["triggers"]
    assert stored["demo-kit--alpha-probe"] == ["跑一遍alpha流程"]          # the 0-scored phrase is gone
    hint = kits.router.on_pre_llm_call(user_message="帮我跑一遍alpha流程")
    assert hint and "demo-kit--alpha-probe" in hint["context"]

    # Same package again: everything is verified, the model is not asked again.
    calls.update(generate=0, verify=0)
    kits.installer.install(kit_pkg, profile_env, triggers={})
    assert calls == {"generate": 0, "verify": 0}


def test_unverified_phrases_stay_unused_until_verified(kits, profile_env, kit_pkg):
    _fake_llm(kits, answer_verify=False)
    receipt = kits.installer.install(kit_pkg, profile_env, triggers={})
    assert _state(kits, profile_env)["unverified"]
    assert "demo-kit--alpha-probe" not in kits.store.load_index(profile_env)["plugins"]["demo-kit"]["triggers"]
    assert kits.router.on_pre_llm_call(user_message="帮我跑一遍alpha流程") is None
    assert any("待复核" in n for n in receipt.notes)

    calls = _fake_llm(kits)
    kits.installer.refresh_triggers(profile_env, "demo-kit")
    assert calls["generate"] == 0 and calls["verify"] >= 1              # only the open verification is retried
    assert not _state(kits, profile_env)["unverified"]
    assert kits.router.on_pre_llm_call(user_message="帮我跑一遍alpha流程") is not None
    line = next(l for l in _index_text(profile_env).splitlines() if "demo-kit--alpha-probe" in l)
    assert "跑一遍alpha流程" in line


def test_rejected_components_are_retried_at_most_three_times(kits, profile_env, kit_pkg):
    calls = _fake_llm(kits, score=lambda phrase: 0)
    kits.installer.install(kit_pkg, profile_env, triggers={})
    assert _state(kits, profile_env)["pending"] and _state(kits, profile_env)["attempts"] == 1

    for _ in range(4):
        kits.installer.refresh_triggers(profile_env, "demo-kit")
    assert _state(kits, profile_env)["attempts"] == kits.triggers.MAX_ATTEMPTS
    assert calls["generate"] == kits.triggers.MAX_ATTEMPTS                # the 4th refresh did not call the model

    calls = _fake_llm(kits)
    kits.installer.refresh_triggers(profile_env, "demo-kit", regenerate=True)
    assert calls["generate"] == 1 and not _state(kits, profile_env)["pending"]


def test_disable_enable_roundtrip(kits, profile_env, kit_pkg):
    kits.installer.install(kit_pkg, profile_env, triggers={})
    kits.installer.set_enabled(profile_env, "demo-kit", False)
    assert "demo-kit--" not in _index_text(profile_env)
    assert _config(profile_env)["mcp_servers"]["plugin_demo-kit_remote"]["enabled"] is False

    kits.installer.set_enabled(profile_env, "demo-kit", True)
    assert "demo-kit--alpha-probe" in _index_text(profile_env)
    assert not [n for n in (_config(profile_env).get("skills") or {}).get("disabled") or [] if n.startswith("demo-kit")]


def test_uninstall_removes_package_files(kits, profile_env, kit_pkg):
    kits.installer.install(kit_pkg, profile_env, triggers={})
    kits.installer.set_config(profile_env, "demo-kit", [("API_KEY", "secret")])
    assert "DEMO_KIT_API_KEY=secret" in (profile_env / ".env").read_text(encoding="utf-8")

    kits.installer.uninstall(profile_env, "demo-kit")
    assert "demo-kit--" not in _index_text(profile_env)
    assert not (profile_env / "skills" / "kits" / "demo-kit").exists()
    assert not (profile_env / "imported-plugins" / "demo-kit").exists()
    assert "plugin_demo-kit_remote" not in (_config(profile_env).get("mcp_servers") or {})
    assert "DEMO_KIT_API_KEY" not in (profile_env / ".env").read_text(encoding="utf-8")
    assert "demo-kit" not in kits.store.load_index(profile_env)["plugins"]


def test_expert_becomes_its_own_profile(kits, profile_env, kit_pkg, expert_pkg, monkeypatch):
    monkeypatch.setitem(kits.host_rules.COMPANION_SKILLS, "demo-expert", ("demo-kit--alpha-probe",))
    kits.installer.install(kit_pkg, profile_env, triggers={})
    receipt = kits.installer.install(expert_pkg, profile_env, triggers={})
    assert receipt.ok and receipt.kind == "expert", receipt.render()

    expert_home = _expert_home()
    soul = (expert_home / "SOUL.md").read_text(encoding="utf-8")
    assert "你是小演" in soul and "clarify" in soul and "AskUserQuestion" not in soul

    meta = yaml.safe_load((expert_home / "profile.yaml").read_text(encoding="utf-8"))
    assert meta["ui_meta"]["hermes-bots"]["title"] == "演示专家"
    assert (expert_home / "assets" / "avatar.png").is_file()
    assert "uniwork-kits" in _config(expert_home)["plugins"]["enabled"]
    assert "GLM_API_KEY=test-key" in (expert_home / ".env").read_text(encoding="utf-8")

    expert_index = _index_text(expert_home)
    assert "demo-expert--beta-probe" in expert_index
    assert "demo-expert--agent-worker-probe" in expert_index
    assert "demo-kit--alpha-probe" in expert_index           # companion
    assert "demo-kit--launch-probe" not in expert_index      # other kit skills stay out
    assert "agent-lead-probe" not in expert_index            # the lead is the persona, not a subagent
    assert "demo-expert--" not in _index_text(profile_env)   # experts never leak into ordinary chat
    assert kits.store.load_index(profile_env)["plugins"]["demo-expert"]["user_config"] == []
    assert kits.store.load_index(expert_home)["plugins"]["demo-expert"]["user_config"] == []


def test_svg_avatar_rides_ui_meta(kits, profile_env, tmp_path):
    svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>'
    pkg = _expert_pkg(tmp_path, avatar_name="face.svg", avatar_bytes=svg)
    receipt = kits.installer.install(pkg, profile_env, triggers={})
    assert receipt.ok, receipt.render()
    bots = yaml.safe_load((_expert_home() / "profile.yaml").read_text(encoding="utf-8"))["ui_meta"]["hermes-bots"]
    assert bots["image"].startswith("data:image/svg+xml;base64,") and bots["imageKind"] == "photo"
    assert not list((_expert_home() / "assets").glob("avatar.*"))


def test_reinstall_keeps_bot_protocol_and_user_edits(kits, profile_env, expert_pkg):
    kits.installer.install(expert_pkg, profile_env, triggers={})
    soul_path = _expert_home() / "SOUL.md"
    protocol = "## Messaging other agents\n\nrun hermes -p <agent> chat ...\n"
    soul_path.write_text(soul_path.read_text(encoding="utf-8") + "\n" + protocol, encoding="utf-8")

    receipt = kits.installer.install(expert_pkg, profile_env, triggers={})
    soul = soul_path.read_text(encoding="utf-8")
    assert "你是小演" in soul and protocol.strip() in soul
    assert not any("SOUL.md" in w for w in receipt.warnings)

    soul_path.write_text("我自己改过的人设\n\n" + protocol, encoding="utf-8")
    receipt = kits.installer.install(expert_pkg, profile_env, triggers={})
    assert soul_path.read_text(encoding="utf-8").startswith("我自己改过的人设")
    assert any("SOUL.md" in w for w in receipt.warnings)


def test_expert_uninstall_requires_explicit_profile_deletion(kits, profile_env, expert_pkg):
    kits.installer.install(expert_pkg, profile_env, triggers={})
    with pytest.raises(kits.installer.KitError):
        kits.installer.uninstall(profile_env, "demo-expert")
    from hermes_cli.profiles import profile_exists

    assert profile_exists("demo-expert")


def test_broken_expert_installs_nothing(kits, profile_env, tmp_path):
    root = tmp_path / "pkgs" / "half-expert"
    _write(root / "plugin.json", json.dumps({"name": "half-expert", "version": "1.0.0", "description": "x",
                                              "expertType": "agent", "agentName": "missing"}))
    _write(root / "skills" / "s" / "SKILL.md", "---\nname: s\ndescription: d\n---\nbody\n")
    receipt = kits.installer.install(root, profile_env, triggers={})
    assert not receipt.ok and "残包" in receipt.error
    assert not (profile_env / "skills" / "kits").exists()
    assert not (profile_env / "profiles" / "half-expert").exists()


def test_prompt_sections_only_render_for_experts(kits, profile_env, expert_pkg, monkeypatch):
    kits.installer.install(expert_pkg, profile_env, triggers={})
    for _, render in kits.host_rules.SECTIONS:
        assert render({"profile_name": "default"}) == ""

    # An expert without host-specific notes still gets its name and the shared rules.
    host, working, delivery = [render({"profile_name": "demo-expert"}) for _, render in kits.host_rules.SECTIONS]
    assert host == "" and delivery
    assert "「演示专家」（演示顾问）" in working and "以这个名字为准" in working

    monkeypatch.setitem(kits.host_rules.HOST_NOTES, "demo-expert", "- 演示专属说明\n")
    host = kits.host_rules.SECTIONS[0][1]({"profile_name": "demo-expert"})
    assert "演示专属说明" in host


def test_expert_rules_fit_hermes_section_budgets(kits, profile_env, monkeypatch):
    """Every known expert's rules must fit Hermes' per-section and total caps, or they are dropped."""
    from hermes_cli.plugins import MAX_SYSTEM_PROMPT_SECTION_CHARS, MAX_SYSTEM_PROMPT_SECTIONS_TOTAL_CHARS

    for plugin in kits.host_rules.HOST_NOTES:
        monkeypatch.setattr(kits.host_rules, "expert_for_session",
                            lambda info, p=plugin: (p, {"display_name": p}))
        texts = [render({"profile_name": plugin}) for _, render in kits.host_rules.SECTIONS]
        assert all(len(t) <= MAX_SYSTEM_PROMPT_SECTION_CHARS for t in texts), plugin
        assert sum(len(t) for t in texts) < MAX_SYSTEM_PROMPT_SECTIONS_TOTAL_CHARS // 2, plugin


def test_router_hints_kits_in_ordinary_profiles_only(kits, profile_env, kit_pkg, expert_pkg, triggers, monkeypatch):
    kits.installer.install(kit_pkg, profile_env, triggers=kits.installer.load_triggers(triggers))
    kits.installer.install(expert_pkg, profile_env, triggers={})

    hint = kits.router.on_pre_llm_call(user_message="帮我做阿尔法分析")
    assert hint and "demo-kit--alpha-probe" in hint["context"] and "skill_view" in hint["context"]
    assert kits.router.on_pre_llm_call(user_message="今天天气怎么样") is None

    monkeypatch.setenv("HERMES_HOME", str(_expert_home()))
    assert kits.router.on_pre_llm_call(user_message="帮我做阿尔法分析") is None


def test_router_follows_the_per_session_home_override(kits, profile_env, kit_pkg, expert_pkg, triggers):
    """The desktop backend scopes HERMES_HOME per turn with an override; the hook must follow it."""
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    kits.installer.install(kit_pkg, profile_env, triggers=kits.installer.load_triggers(triggers))
    kits.installer.install(expert_pkg, profile_env, triggers={})

    token = set_hermes_home_override(str(_expert_home()))
    try:
        assert kits.router.on_pre_llm_call(user_message="帮我做阿尔法分析") is None
    finally:
        reset_hermes_home_override(token)
    assert kits.router.on_pre_llm_call(user_message="帮我做阿尔法分析") is not None


def test_register_wires_cli_sections_and_hook(kits):
    calls = {"cli": [], "sections": [], "hooks": []}

    class Ctx:
        def register_cli_command(self, name, help, setup_fn, handler_fn=None, description=""):
            calls["cli"].append(name)

        def register_system_prompt_section(self, id, content, *, position="after_memory", max_chars=4000):
            calls["sections"].append(id)

        def register_hook(self, name, callback):
            calls["hooks"].append(name)

    kits.root.register(Ctx())
    from hermes_cli.plugins import is_valid_system_prompt_section_id

    assert calls["cli"] == ["kit"]
    assert set(calls["hooks"]) >= {
        "pre_llm_call",
        "pre_tool_call",
        "post_tool_call",
        "on_session_start",
        "on_session_end",
        "transform_tool_result",
    }
    assert calls["sections"] and all(is_valid_system_prompt_section_id(s) for s in calls["sections"])


def _zip_dir(src: Path, dest: Path) -> None:
    import zipfile

    dest.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(dest, "w") as archive:
        for file in sorted(p for p in src.rglob("*") if p.is_file()):
            archive.write(file, file.relative_to(src).as_posix())


def _mod(name: str):
    import importlib

    return importlib.import_module(f"hermes_plugins.uniwork_kits.{name}")


class _Stopped:
    def __init__(self, cmd, **kwargs):
        self.cmd = cmd
        self.pid = 17
        self.kwargs = kwargs

    def poll(self):
        return 0


def test_seed_skips_unchanged_zips_and_keeps_switch_and_secret(kits, profile_env, kit_pkg, monkeypatch):
    seed = _mod("seed")
    directory = profile_env / "seed" / "uniwork-bundled"
    archive = directory / "plugins" / "demo-kit.zip"
    _zip_dir(kit_pkg, archive)
    (directory / "avatars").mkdir()
    seen = {"avatars": None, "installs": 0}
    real_install = kits.installer.install

    def wrapped(path, home, **kwargs):
        seen["installs"] += 1
        seen["avatars"] = kwargs.get("avatars_dir")
        return real_install(path, home, **kwargs)

    def refuse_uninstall(*_args, **_kwargs):
        raise AssertionError("seed must not uninstall")

    monkeypatch.setattr(seed.installer, "install", wrapped)
    monkeypatch.setattr(seed.installer, "uninstall", refuse_uninstall)

    first = seed.seed(profile_env, directory, generate_triggers=False)
    assert [item.status for item in first] == ["installed"]
    assert seen["avatars"] == directory / "avatars"
    kits.installer.set_enabled(profile_env, "demo-kit", False)
    kits.installer.set_config(profile_env, "demo-kit", [("API_KEY", "kept-secret")])

    again = seed.seed(profile_env, directory, generate_triggers=False)
    assert [item.status for item in again] == ["unchanged"]
    assert seen["installs"] == 1
    entry = kits.store.load_index(profile_env)["plugins"]["demo-kit"]
    assert entry["enabled"] is False
    assert "kept-secret" in (profile_env / ".env").read_text(encoding="utf-8")

    (kit_pkg / "README.md").write_text("# demo kit\nchanged\n", encoding="utf-8")
    _zip_dir(kit_pkg, archive)
    third = seed.seed(profile_env, directory, generate_triggers=False)
    assert [item.status for item in third] == ["installed"]
    assert seen["installs"] == 2
    entry = kits.store.load_index(profile_env)["plugins"]["demo-kit"]
    assert entry["enabled"] is False
    assert "kept-secret" in (profile_env / ".env").read_text(encoding="utf-8")


def test_seed_unreadable_or_empty_directory_leaves_installed_kits(kits, profile_env, kit_pkg):
    seed = _mod("seed")
    kits.installer.install(kit_pkg, profile_env, triggers={})
    empty_dir = profile_env / "empty-seed"
    empty_dir.mkdir()
    empty = seed.seed(profile_env, empty_dir, generate_triggers=False)
    assert empty[0].status == "empty"
    assert "demo-kit" in kits.store.load_index(profile_env)["plugins"]

    directory = profile_env / "broken-seed"
    directory.mkdir()
    (directory / "bad.zip").write_text("not a zip", encoding="utf-8")
    items = seed.seed(profile_env, directory, generate_triggers=False)
    assert items[0].status == "unreadable"
    assert "demo-kit" in kits.store.load_index(profile_env)["plugins"]


def test_seed_command_is_registered(kits, tmp_path):
    import argparse

    parser = argparse.ArgumentParser()
    _mod("cli").setup(parser)
    args = parser.parse_args(["seed", str(tmp_path), "--no-generate-triggers"])
    assert args.kit_command == "seed"
    assert args.no_generate_triggers is True


def test_api_lists_toggles_config_and_background_install(kits, profile_env, kit_pkg, monkeypatch):
    import importlib.util

    from fastapi import FastAPI
    from starlette.testclient import TestClient

    jobs = _mod("jobs")
    mod_name = "uniwork_kits_dashboard_api_under_test"
    sys.modules.pop(mod_name, None)
    spec = importlib.util.spec_from_file_location(mod_name, PLUGIN_DIR / "dashboard" / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = module
    spec.loader.exec_module(module)
    app = FastAPI()
    app.include_router(module.router, prefix="/api/plugins/uniwork-kits")
    client = TestClient(app)

    kits.installer.install(kit_pkg, profile_env, triggers={})
    listed = client.get("/api/plugins/uniwork-kits/")
    assert listed.status_code == 200
    body = listed.json()["plugins"]
    demo = next(row for row in body if row["name"] == "demo-kit")
    assert demo["skill_count"] >= 1
    assert "DEMO_KIT_API_KEY" in demo["missing_secrets"]
    assert "kept-secret" not in listed.text

    saved = client.post("/api/plugins/uniwork-kits/config", json={"name": "demo-kit", "values": {"API_KEY": "kept-secret"}})
    assert saved.status_code == 200
    assert saved.json()["written"] == ["DEMO_KIT_API_KEY"]
    assert "kept-secret" not in saved.text
    assert "kept-secret" in (profile_env / ".env").read_text(encoding="utf-8")
    again = client.get("/api/plugins/uniwork-kits/").json()["plugins"]
    demo = next(row for row in again if row["name"] == "demo-kit")
    assert demo["missing_secrets"] == []

    toggled = client.post("/api/plugins/uniwork-kits/toggle", json={"name": "demo-kit", "enabled": False})
    assert toggled.status_code == 200
    assert kits.store.load_index(profile_env)["plugins"]["demo-kit"]["enabled"] is False

    spawned = {}

    def fake_popen(cmd, **kwargs):
        spawned["cmd"] = list(cmd)
        return _Stopped(cmd, **kwargs)

    monkeypatch.setattr(jobs.subprocess, "Popen", fake_popen)
    # The router imported jobs before this patch if it bound the module at exec.
    # Patch the module object the router holds.
    monkeypatch.setattr(module.jobs.subprocess, "Popen", fake_popen)
    uploaded = client.post(
        "/api/plugins/uniwork-kits/install",
        files={"file": ("demo-kit.zip", b"PK\x03\x04unused", "application/zip")},
    )
    assert uploaded.status_code == 200
    job_id = uploaded.json()["job"]["id"]
    assert "kit" in spawned["cmd"] and "install" in spawned["cmd"]
    status = client.get(f"/api/plugins/uniwork-kits/jobs/{job_id}")
    assert status.status_code == 200
    assert status.json()["running"] is False
    assert status.json()["exit_code"] == 0

    receipt = client.get("/api/plugins/uniwork-kits/receipts/demo-kit")
    assert receipt.status_code == 200
    assert "demo-kit" in receipt.json()["text"]
    assert "kept-secret" not in receipt.json()["text"]

    removed = client.post("/api/plugins/uniwork-kits/uninstall", json={"name": "demo-kit"})
    assert removed.status_code == 200
    assert "demo-kit" not in kits.store.load_index(profile_env)["plugins"]


def test_api_only_manifest_is_mounted():
    from hermes_cli.web_server import _get_dashboard_plugins, app

    found = next(row for row in _get_dashboard_plugins(force_rescan=True) if row.get("name") == "uniwork-kits")
    assert found["has_api"] is True
    assert found["tab"].get("hidden") is True
    paths = [getattr(route, "path", "") for route in app.routes]
    assert any(str(path).startswith("/api/plugins/uniwork-kits") for path in paths)


def test_media_slot_rewrites_only_tools_a_colleague_has_named(kits):
    bare = kits.media_slot.MediaSlot("", "", "")
    text, _changes, unmapped = kits.host_rules.rewrite_persona("调用 ImageGen 和 VideoGen", bare)
    assert "ImageGen" in unmapped and "VideoGen" in unmapped
    assert "image_generate" not in text

    wired = kits.media_slot.MediaSlot("image_generate", "txt2vid_generate", "image_search")
    text, _changes, unmapped = kits.host_rules.rewrite_persona("调用 ImageGen 和 VideoGen", wired)
    assert "image_generate" in text and "txt2vid_generate" in text
    assert "ImageGen" not in unmapped and "VideoGen" not in unmapped
    note = kits.media_slot.media_note(wired)
    assert "txt2vid_generate" in note
    assert "生视频还没有接入" in kits.media_slot.media_note(kits.media_slot.MediaSlot())


def test_picture_rules_follow_a_deck_and_name_the_open_slot(kits, profile_env, monkeypatch):
    deck = kits.router.on_pre_llm_call(user_message="帮我做一份幻灯片")
    assert deck and "PPT 配图原则" in deck["context"]
    assert "真图搜索还没有接入" in deck["context"]
    assert "image_generate" in deck["context"]
    assert kits.router.on_pre_llm_call(user_message="今天天气怎么样") is None
    follow = kits.router.on_pre_llm_call(
        user_message="第三页换成真图",
        conversation_history=[{"role": "user", "content": "先做一份幻灯片"}],
    )
    assert follow and "PPT 配图原则" in follow["context"]

    monkeypatch.setattr(
        kits.media_slot,
        "load_slot",
        lambda raw=None: kits.media_slot.MediaSlot("txt2img_generate", "", "image_search"),
    )
    named = kits.router.on_pre_llm_call(user_message="做个PPT")
    assert named and "txt2img_generate" in named["context"] and "image_search" in named["context"]
    assert "真图搜索还没有接入" not in named["context"]


def test_xiaohongshu_attach_writes_only_that_experts_profile_and_does_not_download(kits, profile_env):
    xhs = kits.xiaohongshu
    found = xhs.status(profile_env)
    assert found["present"] is False
    assert found["download_url"].endswith("/" + xhs.binary_name())
    assert xhs.RELEASE in found["download_url"]
    assert not xhs.binary_path(profile_env).exists()

    kits.store.save_index(profile_env, {"plugins": {"equity-research": {"kind": "expert", "self": True}}})
    with pytest.raises(xhs.XiaohongshuError):
        xhs.attach(profile_env)
    cfg = yaml.safe_load((profile_env / "config.yaml").read_text(encoding="utf-8"))
    assert "xiaohongshu-mcp" not in (cfg.get("mcp_servers") or {})

    kits.store.save_index(
        profile_env,
        {"plugins": {xhs.EXPERT_NAME: {"kind": "expert", "self": True, "display_name": "种草草"}}},
    )
    note = xhs.attach(profile_env)
    assert "停用" in note
    cfg = yaml.safe_load((profile_env / "config.yaml").read_text(encoding="utf-8"))
    server = cfg["mcp_servers"]["xiaohongshu-mcp"]
    assert server["url"] == xhs.URL
    assert server["enabled"] is False
    assert not xhs.binary_path(profile_env).exists()


def _png(width: int, height: int) -> bytes:
    import struct
    import zlib

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + b"\x00\x00\x00" * width for _ in range(height))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def _pptx(path: Path, png: bytes, box: tuple | None) -> None:
    import zipfile

    cx, cy = box or (0, 0)
    picture = ""
    if box is not None:
        picture = (
            "<p:pic><p:nvPicPr><p:cNvPr id=\"2\" name=\"pic\"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>"
            '<p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
            f'<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
            '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
        )
    slide = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
        "<p:cSld><p:spTree>"
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
        '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
        '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
        f"{picture}</p:spTree></p:cSld></p:sld>"
    )
    presentation = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>'
        '<p:sldSz cx="12192000" cy="6858000"/></p:presentation>'
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
        'Target="../media/image1.png"/></Relationships>'
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("ppt/presentation.xml", presentation)
        archive.writestr("ppt/slides/slide1.xml", slide)
        archive.writestr("ppt/slides/_rels/slide1.xml.rels", rels)
        archive.writestr("ppt/media/image1.png", png)


def test_deck_check_flags_stretch_and_lands_a_picture_at_its_own_aspect(kits, tmp_path):
    wide = _png(100, 50)
    stretched = tmp_path / "stretched.pptx"
    square = 2 * 914400
    _pptx(stretched, wide, (square, square))
    problems = kits.deck_check.check_pptx(stretched)
    assert any("拉伸" in item for item in problems)

    landed = tmp_path / "landed.pptx"
    _pptx(landed, wide, None)
    note = kits.deck_check.insert_picture(landed, wide)
    assert "第 1 页" in note
    assert not any("拉伸" in item for item in kits.deck_check.check_pptx(landed))
    saved = kits.deck_check.land_image(tmp_path / "pics", "moutai.png", wide, "westock")
    assert (tmp_path / "pics" / "moutai.png").is_file()
    assert "100×50" in saved


def test_package_hook_blocks_a_failing_command(kits, profile_env):
    import sys

    root = profile_env / "imported-plugins" / "demo-kit" / "1.0.0"
    root.mkdir(parents=True)
    command = f'"{sys.executable}" -c "import sys; sys.exit(3)"'
    kits.store.save_index(profile_env, {"plugins": {"demo-kit": {
        "kind": "kit",
        "enabled": True,
        "source_dir": "imported-plugins/demo-kit/1.0.0",
        "hooks": {"PreToolUse": [{"matcher": "Skill", "hooks": [{"type": "command", "command": command}]}]},
    }}})
    blocked = kits.package_hooks.on_pre_tool_call(tool_name="skill_view", args={})
    assert blocked and blocked["action"] == "block"
    assert kits.package_hooks.on_pre_tool_call(tool_name="web_search", args={}) is None


def test_xiaohongshu_download_start_and_login_prompt_use_the_slot(kits, profile_env):
    xhs = kits.xiaohongshu
    kits.store.save_index(
        profile_env,
        {"plugins": {xhs.EXPERT_NAME: {"kind": "expert", "self": True, "display_name": "种草草"}}},
    )
    assert "clarify" in xhs.turn_context(profile_env, "请扫码登录")
    xhs.set_consent(profile_env, "accept")
    path = xhs.install_binary(profile_env, fetch=lambda url: b"fake-binary")
    assert Path(path).is_file()
    seen = {}

    class Proc:
        pid = 42

    def popen(args, **kwargs):
        seen["args"] = list(args)
        return Proc()

    note = xhs.start(profile_env, popen=popen, listening=lambda: False)
    assert seen["args"][1] == "-headless=true"
    assert "扫码登录" in note
    assert "get_login_qrcode" in xhs.turn_context(profile_env, "扫码登录")



