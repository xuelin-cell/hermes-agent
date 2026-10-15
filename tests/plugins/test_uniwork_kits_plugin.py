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

try:  # newer Hermes ships ruamel behind hermes_yaml; develop-uni ships PyYAML
    import hermes_yaml as yaml
except ImportError:
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
        "media_slot", "xiaohongshu", "deck_check", "package_hooks", "turns", "delivery", "expert_sync", "experts",
        "host_hooks", "image_landing", "deck_geometry", "expert_cards",
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
        "displayName": {"zh": "小演", "en": "Demo"},
        "profession": {"zh": "演示专家"},
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
    assert "名字是「演示专家」。" in working and "以这个名字为准" in working

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
        "transform_llm_output",
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
    deck = kits.router.on_pre_llm_call(user_message="帮我做一份幻灯片", platform="desktop")
    assert deck and "PPT 配图原则" in deck["context"]
    assert "搜图工具还没有接入" in deck["context"] and "Wikimedia" in deck["context"]
    assert "MEDIA:" in deck["context"]
    assert kits.router.on_pre_llm_call(user_message="今天天气怎么样") is None
    follow = kits.router.on_pre_llm_call(
        user_message="第三页换成真图",
        conversation_history=[{"role": "user", "content": "先做一份幻灯片"}],
        platform="cli",
    )
    assert follow and "PPT 配图原则" in follow["context"] and "MEDIA:" not in follow["context"]

    _write(profile_env / "config.yaml", yaml.safe_dump({"mcp_servers": {"UniAI-Toolkit": {"url": "https://x"}}}))
    named = kits.router.on_pre_llm_call(user_message="做个PPT")
    assert named and "mcp__UniAI_Toolkit__txt2img_generate" in named["context"]
    assert "mcp__UniAI_Toolkit__image_search" in named["context"]
    assert "tool_describe" in named["context"] and "搜图工具还没有接入" not in named["context"]


def test_media_slot_finds_the_uniai_toolkit_by_name_or_address(kits):
    slot = kits.media_slot.load_slot({}, {"yuanjing": {"url": "https://maas/app/mcp-server/mcp?key=${K}"}})
    assert slot.search_tool == "mcp__yuanjing__image_search" and slot.image_tool == "mcp__yuanjing__txt2img_generate"
    renamed = kits.media_slot.load_slot(
        {}, {"maas-tools": {"url": "https://maas.ai-yuanjing.com/app/mcp-server/mcp?key=${K}&client_id=UniWork"}},
    )
    assert renamed.search_tool == "mcp__maas_tools__image_search"
    off = kits.media_slot.load_slot({}, {"UniAI-Toolkit": {"url": "https://x", "enabled": False}})
    assert off.search_tool == "" and off.server == ""
    pinned = kits.media_slot.load_slot({"search_tool": ""}, {"UniAI-Toolkit": {"url": "https://x"}})
    assert pinned.search_tool == "" and pinned.image_tool == "mcp__UniAI_Toolkit__txt2img_generate"
    assert "tool_call" in kits.media_slot.media_note(slot)


def test_media_connect_writes_a_key_reference_and_never_the_key(kits, profile_env, capsys):
    note = kits.media_slot.connect_uniai(profile_env)
    assert "DESKTOP_MT_MAAS_API_KEY" in note
    cfg = yaml.safe_load((profile_env / "config.yaml").read_text(encoding="utf-8"))
    entry = cfg["mcp_servers"]["UniAI-Toolkit"]
    assert "${DESKTOP_MT_MAAS_API_KEY}" in entry["url"] and "client_id=UniWork" in entry["url"]
    assert entry["timeout"] == kits.media_slot.UNIAI_TIMEOUT_S

    cfg["mcp_servers"]["UniAI-Toolkit"]["enabled"] = False
    (profile_env / "config.yaml").write_text(yaml.safe_dump(cfg), encoding="utf-8")
    kits.media_slot.connect_uniai(profile_env)
    kept = yaml.safe_load((profile_env / "config.yaml").read_text(encoding="utf-8"))["mcp_servers"]["UniAI-Toolkit"]
    assert kept["enabled"] is False

    with (profile_env / ".env").open("a", encoding="utf-8") as env:
        env.write("DESKTOP_MT_MAAS_API_KEY=sk-secret-value\n")
    kept["enabled"] = True
    (profile_env / "config.yaml").write_text(yaml.safe_dump({"mcp_servers": {"UniAI-Toolkit": kept}}), encoding="utf-8")
    lines = "\n".join(kits.media_slot.status_lines(profile_env))
    assert "mcp__UniAI_Toolkit__image_search" in lines and "sk-secret-value" not in lines
    assert "缺密钥" not in lines


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


def _pptx(path: Path, png: bytes, box: tuple | None, origin: tuple = (0, 0)) -> None:
    import zipfile

    cx, cy = box or (0, 0)
    picture = ""
    if box is not None:
        picture = (
            "<p:pic><p:nvPicPr><p:cNvPr id=\"2\" name=\"pic\"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>"
            '<p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
            f'<p:spPr><a:xfrm><a:off x="{origin[0]}" y="{origin[1]}"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
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
        'Target="../media/image1.png"/>'
        '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" '
        'Target="../slideLayouts/slideLayout1.xml"/></Relationships>'
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("ppt/presentation.xml", presentation)
        archive.writestr("ppt/slides/slide1.xml", slide)
        archive.writestr("ppt/slides/_rels/slide1.xml.rels", rels)
        archive.writestr("ppt/media/image1.png", png)


def test_builtin_office_skill_is_installed_under_the_kit_name(kits, profile_env, tmp_path):
    root = tmp_path / "pkgs" / "office-kit"
    _write(root / "plugin.json", json.dumps({
        "name": "office-kit", "version": "1.0.0", "description": "办公套件",
    }, ensure_ascii=False))
    _write(root / "skills" / "docx" / "SKILL.md",
           "---\nname: docx\ndescription: 套件里的文档写法。\n---\n按套件步骤写文档。\n")
    receipt = kits.installer.install(root, profile_env, triggers={}, generate_triggers=False)
    assert receipt.ok, receipt.render()
    assert "office-kit--docx" in receipt.skills
    assert receipt.skipped_skills == []
    assert any("office-kit--docx" in note and "docx" in note for note in receipt.notes)
    assert "office-kit--docx" in _index_text(profile_env)


def _turn(kits, session="s1", turn="t1", platform="desktop", deck=True):
    return kits.turns.begin(session, turn, platform=platform, deck=deck)


def _rewrite(path: Path, *args, **kwargs) -> None:
    """Rewrite a deck so its size and mtime both move, the way a rerun script does."""
    import os
    import time

    before = path.stat().st_mtime_ns if path.exists() else 0
    _pptx(path, *args, **kwargs)
    with path.open("ab") as handle:
        handle.write(b"\0" * (int(time.time_ns()) % 7 + 1))
    os.utime(path, ns=(before + 10_000_000, before + 10_000_000))


def test_broken_deck_is_sent_back_twice_per_request_then_released(kits, tmp_path):
    kits.turns.clear()
    turn = _turn(kits)
    path = tmp_path / "bleed.pptx"
    args = {"command": f'node "{tmp_path / "make.js"}"'}
    (tmp_path / "make.js").write_text(f'writeFileSync("{path.as_posix()}", "")\n', encoding="utf-8")
    replies = []
    for _ in range(3):
        _rewrite(path, _png(20, 20), (914400, 914400), origin=(-2 * 914400, 0))
        replies.append(kits.deck_check.annotate("terminal", args, "exit 0", turn))
    assert "没有交付" in replies[0] and "页面外" in replies[0]
    assert "没有交付" in replies[1]
    assert "可以交给用户" in replies[2] and "没有交付" not in replies[2]

    # Mentioning the same, unchanged file again says nothing new.
    assert kits.deck_check.annotate("terminal", {"command": f"dir {path}"}, "listed", turn) is None

    # A new request gets its own two bounces.
    fresh = kits.turns.current("s1", "t2")
    _rewrite(path, _png(20, 20), (914400, 914400), origin=(-2 * 914400, 0))
    assert "没有交付" in kits.deck_check.annotate("terminal", args, "exit 0", fresh)


def test_clean_deck_passes_with_the_desktop_delivery_line(kits, tmp_path):
    kits.turns.clear()
    path = tmp_path / "ok.pptx"
    _pptx(path, _png(100, 50), (2 * 914400, 914400))
    passed = kits.deck_check.annotate("write_file", {"path": str(path)}, "ok", _turn(kits))
    assert "没有发现问题" in passed and "MEDIA:" in passed
    _rewrite(path, _png(100, 50), (2 * 914400, 914400))
    on_cli = kits.deck_check.annotate("write_file", {"path": str(path)}, "ok", _turn(kits, "s2", platform="cli"))
    assert "MEDIA:" not in on_cli and "完整路径" in on_cli


def test_deck_check_flags_a_stretched_picture(kits, tmp_path):
    stretched = tmp_path / "stretched.pptx"
    _pptx(stretched, _png(100, 50), (2 * 914400, 2 * 914400))
    assert any("拉伸" in item for item in kits.deck_check.check_pptx(stretched))


def _deck_with(path: Path, *, slide_extra: str = "", presentation: str = "", parts: dict | None = None) -> None:
    import zipfile

    _pptx(path, _png(20, 20), None)
    with zipfile.ZipFile(path) as archive:
        files = {name: archive.read(name) for name in archive.namelist()}
    slide = files["ppt/slides/slide1.xml"].decode("utf-8")
    files["ppt/slides/slide1.xml"] = slide.replace("</p:spTree>", "</p:spTree>" + slide_extra, 1).encode("utf-8") \
        if slide_extra.startswith("<p:timing") else slide.replace("</p:spTree>", slide_extra + "</p:spTree>", 1).encode("utf-8")
    files["ppt/slides/_rels/slide1.xml.rels"] = (
        b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        b'<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" '
        b'Target="../slideLayouts/slideLayout1.xml"/></Relationships>'
    )
    if presentation:
        files["ppt/presentation.xml"] = presentation.encode("utf-8")
    for name, body in (parts or {}).items():
        files[name] = body.encode("utf-8")
    with zipfile.ZipFile(path, "w") as archive:
        for name, body in files.items():
            archive.writestr(name, body)


def test_deck_check_names_what_powerpoint_refuses_to_open(kits, tmp_path):
    shape = (
        '<p:sp><p:nvSpPr><p:cNvPr id="5" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
        '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>'
        '<a:ln><a:prstDash val="roundDot"/></a:ln></p:spPr>'
        '<p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="90"/><a:t>小字</a:t></a:r></a:p></p:txBody></p:sp>'
    )
    bad_values = tmp_path / "values.pptx"
    _deck_with(bad_values, slide_extra=shape)
    problems = "\n".join(kits.deck_check.check_pptx(bad_values))
    assert "roundDot" in problems and "0.9 磅" in problems and "打不开" in problems

    animation = tmp_path / "animation.pptx"
    _deck_with(animation, slide_extra=(
        '<p:timing><p:tnLst><p:par><p:cTn id="1"><p:childTnLst>'
        '<p:par><p:cTn id="2" presetClass="entr"><p:childTnLst><p:set><p:cBhvr><p:cTn id="3"/>'
        '<p:tgtEl><p:spTgt spid="42"/></p:tgtEl></p:cBhvr></p:set></p:childTnLst></p:cTn></p:par>'
        '</p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'
    ))
    assert any("id=42" in item for item in kits.deck_check.check_pptx(animation))

    notes = tmp_path / "notes.pptx"
    theme_rel = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" '
        'Target="../theme/theme1.xml"/></Relationships>'
    )
    presentation = (
        '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<p:notesMasterIdLst><p:notesMasterId r:id="rId8"/></p:notesMasterIdLst>'
        '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>'
    )
    parts = {
        "ppt/notesMasters/notesMaster1.xml": "<p:notesMaster/>",
        "ppt/notesMasters/_rels/notesMaster1.xml.rels": theme_rel,
        "ppt/slideMasters/slideMaster1.xml": "<p:sldMaster/>",
        "ppt/slideMasters/_rels/slideMaster1.xml.rels": theme_rel,
        "ppt/theme/theme1.xml": "<a:theme/>",
    }
    _deck_with(notes, presentation=presentation, parts=parts)
    assert any("备注母版" in item for item in kits.deck_check.check_pptx(notes))
    # The same deck with notesMasterIdLst out of schema order opens, so it is left alone.
    tolerated = tmp_path / "tolerated.pptx"
    _deck_with(tolerated, presentation=presentation.replace(
        '<p:notesMasterIdLst><p:notesMasterId r:id="rId8"/></p:notesMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>',
        '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId8"/></p:notesMasterIdLst>',
    ), parts=parts)
    assert not any("备注母版" in item for item in kits.deck_check.check_pptx(tolerated))


def test_generated_pictures_are_reviewed_once_per_request(kits, profile_env, tmp_path):
    kits.turns.clear()
    hooks = kits.host_hooks
    kits.router.on_pre_llm_call(user_message="做一份西游记幻灯片", session_id="g1", turn_id="r1", platform="desktop")
    hooks.on_transform_tool_result(
        tool_name="mcp__UniAI_Toolkit__txt2img_generate",
        args={"prompt": "水墨风 孙悟空 腾云"},
        result='{"images": ["https://oss/x.png"]}',
        session_id="g1", turn_id="r1",
    )
    path = tmp_path / "xyj.pptx"
    _pptx(path, _png(100, 50), (2 * 914400, 914400))
    first = hooks.on_transform_tool_result(tool_name="write_file", args={"path": str(path)}, result="ok",
                                           session_id="g1", turn_id="r1")
    assert "先别交付" in first and "孙悟空" in first and "一处「AI 生成」都没有" in first
    _rewrite(path, _png(100, 50), (2 * 914400, 914400))
    second = hooks.on_transform_tool_result(tool_name="write_file", args={"path": str(path)}, result="ok",
                                            session_id="g1", turn_id="r1")
    assert "先别交付" not in second and "MEDIA:" in second


def test_ppt_kit_skill_brings_the_picture_rules_once(kits, profile_env, expert_pkg, monkeypatch):
    kits.turns.clear()
    hooks = kits.host_hooks
    kits.router.on_pre_llm_call(user_message="帮我看看这个", session_id="k1", turn_id="r1", platform="desktop")
    loaded = hooks.on_transform_tool_result(tool_name="skill_view", args={"name": "pptx--pptx"}, result="# PPTX",
                                            session_id="k1", turn_id="r1")
    assert loaded and "PPT 配图原则" in loaded and "MEDIA:" in loaded
    again = hooks.on_transform_tool_result(tool_name="skill_view", args={"name": "ppt-writer--create-ppt"},
                                           result="# create", session_id="k1", turn_id="r1")
    assert again is None
    assert hooks.on_transform_tool_result(tool_name="skill_view", args={"name": "docx--docx"}, result="# docx",
                                          session_id="k1", turn_id="r2") is None

    kits.installer.install(expert_pkg, profile_env, triggers={})
    monkeypatch.setenv("HERMES_HOME", str(_expert_home()))
    assert hooks.on_transform_tool_result(tool_name="skill_view", args={"name": "pptx--pptx"}, result="# PPTX",
                                          session_id="e1", turn_id="r1") is None


_SEARCH_RESULT = (
    "1. 西湖断桥\n原图：https://img.example.com/a.jpg\n缩略图：https://img.example.com/a_s.jpg\n"
    "来源：杭州网 https://www.hangzhou.example/page1\n"
    "2. 西湖全景\n原图：https://img.example.com/b.jpg\n来源：浙江在线 https://zj.example/page2\n"
)


def _jpeg(width: int, height: int) -> bytes:
    import struct

    sof = b"\xff\xc0" + struct.pack(">HBHHB", 17, 8, height, width, 3) + b"\x01\x11\x00\x02\x11\x00\x03\x11\x00"
    return b"\xff\xd8" + sof + b"\x00" * 9000 + b"\xff\xd9"


def test_image_search_lands_pictures_in_a_deck_conversation_only(kits, profile_env, tmp_path, monkeypatch):
    kits.turns.clear()
    monkeypatch.setenv("TERMINAL_CWD", str(tmp_path))
    landing = kits.image_landing
    fetched = []

    def fetcher(url: str) -> bytes:
        fetched.append(url)
        return _jpeg(1600, 900) if "a.jpg" in url else _jpeg(800, 1200)

    plain = _turn(kits, "p1", deck=False)
    assert landing.after_search(plain, {"query": "西湖"}, _SEARCH_RESULT, fetcher=fetcher) is None

    turn = _turn(kits, "d1")
    assert landing.before_search(turn, {"query": "西湖 断桥"}) is None
    landed = landing.after_search(turn, {"query": "西湖 断桥"}, _SEARCH_RESULT, fetcher=fetcher)
    assert "【宿主已落地图片】" in landed and "横图" in landed and "竖图" in landed and "杭州网" in landed
    files = sorted((tmp_path / "assets" / "image-search").rglob("*.jpg"))
    assert len(files) == 2 and any(path.name == "来源.txt" for path in files[0].parent.iterdir())

    repeat = kits.host_hooks.on_pre_tool_call(
        tool_name="mcp__UniAI_Toolkit__image_search", args={"query": "西湖  断桥"}, session_id="d1", turn_id="t1",
    )
    assert repeat and repeat["action"] == "block" and "刚搜过" in repeat["message"]

    for index in range(landing.MAX_SEARCHES - 1):
        assert landing.before_search(turn, {"query": f"关键词{index}"}) is None
        landing.after_search(turn, {"query": f"关键词{index}"}, _SEARCH_RESULT, fetcher=fetcher)
    spent = landing.before_search(turn, {"query": "再来一个"})
    assert "已经用完" in spent and "不要告诉用户它不可用" in spent and "换个关键词再搜" not in spent
    assert all(url.startswith("https://img.example.com/") for url in fetched)


def test_image_download_refuses_private_addresses(kits):
    allowed = kits.image_landing._allowed
    assert allowed("https://img.example.com/a.jpg")
    assert not allowed("http://127.0.0.1/a.jpg")
    assert not allowed("http://10.0.0.8/a.jpg")
    assert not allowed("file:///etc/passwd")
    assert not allowed("http://169.254.169.254/latest/meta-data")


def test_expert_rules_say_how_files_reach_the_chat(kits, profile_env, expert_pkg):
    kits.installer.install(expert_pkg, profile_env, triggers={})
    working = kits.host_rules.SECTIONS[1][1]
    on_desktop = working({"profile_name": "demo-expert", "platform": "desktop"})
    assert "MEDIA:<绝对路径>" in on_desktop and "不要声称已弹出文件卡片" not in on_desktop
    on_cli = working({"profile_name": "demo-expert", "platform": "cli"})
    assert "MEDIA:" not in on_cli and "完整路径" in on_cli


def test_reply_naming_new_files_gets_desktop_cards(kits, tmp_path):
    import os
    import time

    kits.turns.clear()
    started = time.time()
    out = tmp_path / "out dir"
    out.mkdir()
    report = out / "华为首次覆盖报告.docx"
    model = out / "Huawei_Model.xlsx"
    old = out / "旧数据.xlsx"
    for path in (report, model, old):
        path.write_bytes(b"x")
    os.utime(old, (started - 3600, started - 3600))
    deck = tmp_path / "deck.pptx"
    deck.write_bytes(b"x")

    turn = _turn(kits, "c1")
    turn.started = started
    reply = (
        f"已完成。交付目录 `{out}`\n\n| 文件 | 说明 |\n|---|---|\n| **{report.name}** | 报告 |\n| {model.name} | 模型 |\n"
        f"| {old.name} | 去年的 |\n\n另见 {deck.as_posix()} 和 https://example.com/a.png\n\nMEDIA:{deck}"
    )
    carded = kits.delivery.on_transform_llm_output(response_text=reply, session_id="c1", platform="desktop")
    added = carded[len(reply):]
    assert str(report) in added and str(model) in added
    assert old.name not in added and "example.com" not in added
    assert added.count("deck.pptx") == 0  # already carded by the model
    assert "MEDIA:`" in added  # a path with a space is quoted

    assert kits.delivery.on_transform_llm_output(response_text=reply, session_id="c1", platform="cli") is None
    assert kits.delivery.on_transform_llm_output(response_text="没有文件", session_id="c1", platform="desktop") is None


def test_package_hook_blocks_only_on_exit_2_or_an_explicit_deny(kits, profile_env):
    import sys

    root = profile_env / "imported-plugins" / "demo-kit" / "1.0.0"
    root.mkdir(parents=True)

    def install(command: str) -> None:
        kits.store.save_index(profile_env, {"plugins": {"demo-kit": {
            "kind": "kit",
            "enabled": True,
            "source_dir": "imported-plugins/demo-kit/1.0.0",
            "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": command}]}]},
        }}})

    install(f'"{sys.executable}" -c "import sys; sys.exit(3)"')
    assert kits.package_hooks.on_pre_tool_call(tool_name="terminal", args={"command": "ls"}) is None

    install(f'"{sys.executable}" -c "import sys, json; d = json.load(sys.stdin); '
            f'sys.stderr.write(d[\'tool_name\'] + \' \' + d[\'tool_input\'][\'command\']); sys.exit(2)"')
    blocked = kits.package_hooks.on_pre_tool_call(tool_name="terminal", args={"command": "rm -rf x"})
    assert blocked and blocked["action"] == "block" and blocked["message"] == "Bash rm -rf x"
    assert kits.package_hooks.on_pre_tool_call(tool_name="web_search", args={}) is None

    install(f'"{sys.executable}" -c "print(\'{{\\"decision\\": \\"block\\", \\"reason\\": \\"nope\\"}}\')"')
    denied = kits.package_hooks.on_pre_tool_call(tool_name="terminal", args={"command": "ls"})
    assert denied and denied["message"] == "nope"


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


def test_xiaohongshu_stop_never_kills_a_process_it_did_not_start(kits, profile_env):
    import os

    xhs = kits.xiaohongshu
    kits.store.save_index(
        profile_env,
        {"plugins": {xhs.EXPERT_NAME: {"kind": "expert", "self": True, "display_name": "种草草"}}},
    )
    xhs.binary_path(profile_env).parent.mkdir(parents=True, exist_ok=True)
    xhs._write_json(xhs._state_path(profile_env), {"pid": os.getpid(), "running": True})
    note = xhs.stop(profile_env)
    assert "没有结束任何进程" in note
    assert xhs._read_json(xhs._state_path(profile_env))["pid"] == 0


def test_deep_paths_in_tool_output_do_not_stall_the_deck_check(kits, tmp_path):
    """A `find` over node_modules once hung a conversation in the path scan (2026-10-14)."""
    import time

    kits.turns.clear()
    deck = tmp_path / "with space" / "deck.pptx"
    _pptx(deck, _png(100, 50), (2 * 914400, 914400))
    deep = "/".join(f"dir{i}" for i in range(40))
    listing = "\n".join(f"/c/Users/me/AppData/Local/Temp/ppt/node_modules/{deep}/file{i}.js" for i in range(200))
    output = listing + f'\nsaved "{deck}"\n'
    started = time.perf_counter()
    checked = kits.deck_check.annotate("terminal", {"command": "find . -maxdepth 40"}, output, _turn(kits))
    assert time.perf_counter() - started < 2.0
    assert checked and "deck.pptx" in checked


def test_old_expert_chats_get_a_card_correction_on_the_desktop(kits, profile_env, expert_pkg, monkeypatch):
    """A bot keeps one forever-chat whose prompt was frozen with the old 'no cards' rule."""
    from hermes_state import SessionDB

    kits.installer.install(expert_pkg, profile_env, triggers={})
    home = _expert_home()
    db = SessionDB(db_path=home / "state.db")
    db.create_session("old-chat", "desktop")
    db.update_system_prompt("old-chat", "……交付文件写好后在回复里写明文件的完整路径。本应用没有 PresentToUser，不要声称已弹出文件卡片……")
    db.create_session("new-chat", "desktop")
    db.update_system_prompt("new-chat", "……每个文件单独一行写 MEDIA:<绝对路径>……")
    db.close()
    monkeypatch.setenv("HERMES_HOME", str(home))

    old = kits.router.on_pre_llm_call(user_message="写个开头", session_id="old-chat", turn_id="1", platform="desktop")
    assert old and "宿主更正" in old["context"] and "MEDIA:" in old["context"]
    assert kits.router.on_pre_llm_call(user_message="写个开头", session_id="new-chat", turn_id="1", platform="desktop") is None
    assert kits.router.on_pre_llm_call(user_message="写个开头", session_id="old-chat", turn_id="2", platform="cli") is None


def test_deck_written_by_a_script_in_a_cd_directory_is_checked_at_once(kits, tmp_path):
    kits.turns.clear()
    out = tmp_path / "ppt out"
    deck = out / "xihu.pptx"
    _pptx(deck, _png(20, 20), (914400, 914400), origin=(-2 * 914400, 0))
    (out / "gen.js").write_text('pres.writeFile({ fileName: "xihu.pptx" })\n', encoding="utf-8")
    args = {"command": f'cd "{out}" && node gen.js && ls -la xihu.pptx'}
    checked = kits.deck_check.annotate("terminal", args, "OK xihu.pptx\n-rw-r--r-- 1 me 3701461 xihu.pptx", _turn(kits))
    assert checked and "没有交付" in checked and "xihu.pptx" in checked


def test_experts_follow_the_default_profiles_model_key_and_uniai(kits, profile_env, tmp_path):
    """A desktop login rewrites the default profile only; installed experts must keep up."""
    root = _expert_pkg(tmp_path)
    manifest = root / ".codebuddy-plugin" / "plugin.json"
    data = json.loads(manifest.read_text(encoding="utf-8"))
    data["userConfig"] = {"APP_SECRET": {"title": "密钥", "sensitive": True}}
    manifest.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    kits.installer.install(root, profile_env, triggers={})
    home = _expert_home()
    own = kits.installer.env_name("demo-expert", "APP_SECRET")
    with (home / ".env").open("a", encoding="utf-8") as env:
        env.write(f"{own}=mine\n")

    uniai = "https://maas.ai-yuanjing.com/app/mcp-server/mcp?key=${DESKTOP_MT_MAAS_API_KEY}&client_id=UniWork"
    (profile_env / ".env").write_text(
        f"GLM_API_KEY=rotated\nDESKTOP_MT_MAAS_API_KEY=maas-1\nTELEGRAM_BOT_TOKEN=bot\n{own}=default-copy\n",
        encoding="utf-8",
    )
    _write(profile_env / "config.yaml", yaml.safe_dump({
        "model": {"provider": "custom:desktop-mt-maas-abc", "default": "m-1"},
        "providers": {
            "desktop-mt-maas-abc": {"base_url": "https://maas.example/v1", "key_env": "DESKTOP_MT_MAAS_API_KEY"},
            "personal": {"base_url": "https://mine.example/v1"},
        },
        "mcp_servers": {"UniAI-Toolkit": {"url": uniai, "timeout": 600}},
    }))

    assert kits.expert_sync.sync_all(profile_env)
    cfg = _config(home)
    env = kits.expert_sync._read(home)[1]
    assert cfg["model"] == {"provider": "custom:desktop-mt-maas-abc", "default": "m-1"}
    assert "desktop-mt-maas-abc" in cfg["providers"] and "personal" not in cfg["providers"]
    assert cfg["mcp_servers"]["UniAI-Toolkit"] == {"url": uniai, "timeout": 600}
    assert env["DESKTOP_MT_MAAS_API_KEY"] == "maas-1" and env["GLM_API_KEY"] == "rotated"
    assert env[own] == "mine" and "TELEGRAM_BOT_TOKEN" not in env
    assert kits.expert_sync.sync_all(profile_env) == []  # nothing left to change

    # The user turned the toolkit off for this expert and picked another model: both stay.
    cfg["mcp_servers"]["UniAI-Toolkit"]["enabled"] = False
    cfg["model"] = {"provider": "zai", "default": "glm-x"}
    _write(home / "config.yaml", yaml.safe_dump(cfg))
    kits.expert_sync.sync_all(profile_env)
    cfg = _config(home)
    assert cfg["mcp_servers"]["UniAI-Toolkit"]["enabled"] is False
    assert cfg["model"]["default"] == "glm-x"

    # No 套餐 any more: the default drops the toolkit and the expert loses it too.
    _write(profile_env / "config.yaml", yaml.safe_dump({"model": {"provider": "zai", "default": "glm-test"}}))
    kits.expert_sync.sync_all(profile_env)
    assert "UniAI-Toolkit" not in (_config(home).get("mcp_servers") or {})


def test_summon_directory_carries_prompts_recent_and_avatar(kits, profile_env, tmp_path):
    root = _expert_pkg(tmp_path)
    manifest = root / ".codebuddy-plugin" / "plugin.json"
    data = json.loads(manifest.read_text(encoding="utf-8"))
    data.update({
        "displayDescription": {"zh": "演示用的专家", "en": "Demo expert"},
        "defaultInitPrompt": {"zh": "帮我做个演示", "en": "Demo please"},
        "quickPrompts": [{"zh": "演示一"}, {"zh": "演示二"}, "演示三"],
        "tags": [{"zh": "演示"}],
    })
    manifest.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    kits.installer.install(root, profile_env, triggers={})

    listed = kits.experts.directory(profile_env)
    assert listed["recent"] == []
    [expert] = listed["experts"]
    assert expert["profile"] == "demo-expert" and expert["display_name"] == "演示专家"
    assert expert["profession"] == "" and expert["description"] == "演示用的专家"
    assert expert["init_prompt"] == "帮我做个演示"
    assert expert["quick_prompts"] == ["演示一", "演示二", "演示三"] and expert["tags"] == ["演示"]

    assert kits.experts.record_recent(profile_env, "demo-expert") == ["demo-expert"]
    assert kits.experts.directory(profile_env)["recent"] == ["demo-expert"]
    with pytest.raises(kits.installer.KitError):
        kits.experts.record_recent(profile_env, "not-installed")

    assert kits.experts.avatar_data_url(profile_env, "demo-expert").startswith("data:image/png;base64,")
    assert kits.experts.avatar_data_url(profile_env, "not-installed") == ""


def test_experts_are_named_by_their_job(kits, monkeypatch):
    """Users read 「基金诊断专家」, not a character name like 福帮手."""
    name = kits.expert_cards.card_name
    assert name("x", {"displayName": {"zh": "小演"}, "profession": {"zh": "演示专家"}}) == ("演示专家", "")
    # <job>-<maker>: the maker moves to the subtitle so the job is not cut off in lists.
    maker = {"displayName": {"zh": "基金诊断专家-东方财富妙想"}, "profession": {"zh": "基金诊断专家-东方财富妙想"}}
    assert name("x", maker) == ("基金诊断专家", "东方财富妙想")
    assert name("x", {"displayName": {"zh": "插件顾问"}}) == ("插件顾问", "")

    for plugin, card in kits.expert_cards.CARDS.items():
        assert name(plugin, {"displayName": "人设名", "profession": "某职业"})[0].endswith("专家"), plugin
        if "init_prompt" in card:
            shown = kits.expert_cards.intro(plugin, {"defaultInitPrompt": "本次WorkBuddy任务"})
            assert shown["init_prompt"] == shown["quick_prompts"][0]
            assert "WorkBuddy" not in shown["init_prompt"] + "".join(shown["quick_prompts"]), plugin

    # A card can patch the phrase that still calls the expert by its old title, keeping the rest.
    monkeypatch.setitem(kits.expert_cards.CARDS, "renamed", {"name": "新专家", "replace": {"请旧称帮忙": "请帮忙"}})
    shown = kits.expert_cards.intro("renamed", {"defaultInitPrompt": "请旧称帮忙写方案", "quickPrompts": ["请旧称帮忙写方案", "写脚本"]})
    assert shown["init_prompt"] == "请帮忙写方案" and shown["quick_prompts"] == ["请帮忙写方案", "写脚本"]


def test_failed_first_expert_install_takes_its_new_profile_back(kits, profile_env, expert_pkg, monkeypatch):
    """A half-made profile would make every retry refuse it as someone else's."""
    real = kits.installer.install_into_home

    def broken(plan, home, receipt, **kw):
        raise OSError(2, "No such file or directory", str(home / "deep" / "file.md"))

    monkeypatch.setattr(kits.installer, "install_into_home", broken)
    receipt = kits.installer.install(expert_pkg, profile_env, triggers={})
    assert not receipt.ok and "安装失败" in receipt.error
    assert not _expert_home().exists()
    assert "demo-expert" not in (kits.store.load_index(profile_env).get("plugins") or {})

    monkeypatch.setattr(kits.installer, "install_into_home", real)
    assert kits.installer.install(expert_pkg, profile_env, triggers={}).ok
    assert _expert_home().is_dir()


@pytest.mark.windows_only
def test_path_past_windows_limit_says_how_to_fix_it(kits, tmp_path):
    import shutil

    deep = "C:\\" + "x" * 300 + "\a.md"
    exc = shutil.Error([("C:\src\a.md", deep, "[WinError 3] 系统找不到指定的路径。")])
    text = kits.installer._failure_text(exc, tmp_path)
    assert "260" in text and "LongPathsEnabled" in text
    assert kits.installer._failure_text(OSError(2, "gone", "C:\short.md"), tmp_path).startswith("安装失败")


def test_summon_endpoints_over_http(kits, profile_env, expert_pkg, monkeypatch):
    import importlib.util

    from fastapi import FastAPI
    from starlette.testclient import TestClient

    mod_name = "uniwork_kits_dashboard_api_summon_test"
    sys.modules.pop(mod_name, None)
    spec = importlib.util.spec_from_file_location(mod_name, PLUGIN_DIR / "dashboard" / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = module
    spec.loader.exec_module(module)
    app = FastAPI()
    app.include_router(module.router, prefix="/api/plugins/uniwork-kits")
    client = TestClient(app)

    kits.installer.install(expert_pkg, profile_env, triggers={})
    listed = client.get("/api/plugins/uniwork-kits/experts").json()
    assert [row["profile"] for row in listed["experts"]] == ["demo-expert"]
    picked = client.post("/api/plugins/uniwork-kits/experts/recent", json={"name": "demo-expert"})
    assert picked.status_code == 200 and picked.json()["recent"] == ["demo-expert"]
    assert client.post("/api/plugins/uniwork-kits/experts/recent", json={"name": "nope"}).status_code == 400
    face = client.get("/api/plugins/uniwork-kits/experts/demo-expert/avatar").json()
    assert face["data_url"].startswith("data:image/png;base64,")

    # With an expert's chat on screen the desktop routes plugin calls to that
    # expert's backend; the picker and the kits page still see the default
    # profile's experts and kits, not the expert's own registry.
    from_default = client.get("/api/plugins/uniwork-kits/").json()
    expert_home = profile_env / "profiles" / "demo-expert"
    assert expert_home.is_dir()
    monkeypatch.setenv("HERMES_HOME", str(expert_home))
    listed = client.get("/api/plugins/uniwork-kits/experts").json()
    assert [row["profile"] for row in listed["experts"]] == ["demo-expert"]
    assert listed["recent"] == ["demo-expert"]
    assert client.get("/api/plugins/uniwork-kits/").json() == from_default


def test_capabilities_installed_without_generation_get_phrases_later(kits, profile_env, kit_pkg):
    """A seed with --no-generate-triggers must not mark its capabilities as done."""
    kits.installer.install(kit_pkg, profile_env, triggers={}, generate_triggers=False)
    assert not (kits.store.load_index(profile_env)["plugins"]["demo-kit"].get("triggers") or {})

    calls = _fake_llm(kits)
    kits.installer.refresh_triggers(profile_env, "demo-kit")
    assert calls["generate"] == 1
    assert kits.store.load_index(profile_env)["plugins"]["demo-kit"]["triggers"]


def test_xiaohongshu_login_is_asked_in_chat_then_prepared_and_kept_running(kits, profile_env):
    """数字员工's flow: ask in chat, then the host downloads, starts and connects; restarts after a reboot."""
    xhs = kits.xiaohongshu
    kits.store.save_index(
        profile_env,
        {"plugins": {xhs.EXPERT_NAME: {"kind": "expert", "self": True, "display_name": "种草草"}}},
    )
    asking = xhs.turn_context(profile_env, "帮我扫码登录小红书", listening=lambda: False)
    assert "clarify" in asking and "kit xiaohongshu prepare" in asking and "setup_mcp" in asking
    assert "MEDIA:" in asking
    assert xhs.turn_context(profile_env, "帮我想几个选题", listening=lambda: False) == ""

    started = []

    class Proc:
        pid = 7

    note = xhs.prepare(
        profile_env,
        fetch=lambda url: b"fake-binary",
        popen=lambda args, **kw: started.append(args) or Proc(),
        listening=lambda: False,
        wait_s=0,
    )
    assert xhs.consent_accepted(profile_env) and xhs.binary_path(profile_env).is_file()
    assert started and "已下载" in note
    entry = _config(profile_env)["mcp_servers"][xhs.MCP_KEY]
    assert entry["enabled"] is True

    ready = xhs.turn_context(profile_env, "扫码登录", listening=lambda: True)
    assert "check_login_status" in ready and "clarify" not in ready and "prepare" not in ready

    # After a reboot: consent on record, program present, nothing listening → start it again.
    started.clear()
    assert xhs.ensure_running(profile_env, popen=lambda args, **kw: started.append(args) or Proc(), listening=lambda: False)
    assert started
    assert not xhs.ensure_running(profile_env, popen=lambda args, **kw: started.append(args), listening=lambda: True)


def test_chinese_skill_names_each_keep_a_slash_command(kits, profile_env, tmp_path, monkeypatch):
    """ppt-writer's 「PPT视觉设计」 and 「PPT内容生成」 both became /ppt-writer-ppt; one lost its command."""
    root = tmp_path / "pkgs" / "zh-kit"
    _write(root / "plugin.json", json.dumps({"name": "zh-kit", "version": "1.0.0", "description": "中文套件"}))
    _write(root / "skills" / "ppt-design" / "SKILL.md",
           "---\nname: PPT视觉设计\ndescription: 设计幻灯片的版式\n---\n做完交给 `zh-kit:PPT内容生成`。\n")
    _write(root / "skills" / "content-generation" / "SKILL.md",
           "---\nname: PPT内容生成\ndescription: 写幻灯片的内容\n---\n正文\n")
    receipt = kits.installer.install(root, profile_env, triggers={}, generate_triggers=False)
    assert sorted(receipt.skills) == ["zh-kit--content-generation", "zh-kit--ppt-design"]

    import agent.skill_commands as sc
    import tools.skills_tool as st

    monkeypatch.setattr(st, "SKILLS_DIR", profile_env / "skills")
    commands = sc.scan_skill_commands()
    assert "/zh-kit-ppt-design" in commands and "/zh-kit-content-generation" in commands
    design = _skill_md(profile_env, "zh-kit", "ppt-design")
    assert "PPT视觉设计" in design and "zh-kit--content-generation" in design
