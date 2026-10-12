"""Regression tests for dashboard profile-scoped skills/toolsets management.

"Set as active" on the Profiles page only flips the sticky ``active_profile``
file (future CLI/gateway runs) — it never retargets the running dashboard
process. Before the ``profile`` parameter existed, toggling a skill after
"activating" a profile silently wrote into the dashboard's own config.
These tests pin the new behavior: reads and writes land in the REQUESTED
profile's HERMES_HOME, and the dashboard's own profile stays untouched.
"""
import pytest
import hermes_yaml as yaml
import hermes_cli.web_server_gateway as _web_server_gateway
import hermes_cli.web_server_profiles as _web_server_profiles


def _write_skill(skills_dir, name, description="test skill"):
    d = skills_dir / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n",
        encoding="utf-8",
    )


def _write_unavailable_skill(skills_dir, name):
    """写入一个当前主机不可提供、但管理页仍应展示的技能。"""
    d = skills_dir / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: unavailable skill\nrequires_apps: [missing-test-app]\n---\n",
        encoding="utf-8",
    )


@pytest.fixture
def isolated_profiles(tmp_path, monkeypatch, _isolate_hermes_home):
    """Isolated default home + one named profile, each with its own skills."""
    from hermes_constants import get_hermes_home
    from hermes_cli import profiles

    default_home = get_hermes_home()
    profiles_root = default_home / "profiles"
    worker_home = profiles_root / "worker_alpha"
    for home in (default_home, worker_home):
        (home / "skills").mkdir(parents=True, exist_ok=True)
        (home / "config.yaml").write_text("{}\n", encoding="utf-8")

    _write_skill(default_home / "skills", "dashboard-skill")
    _write_skill(worker_home / "skills", "worker-skill")
    _write_skill(worker_home / "skills", "hermes-agent")

    monkeypatch.setattr(profiles, "_get_default_hermes_home", lambda: default_home)
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: profiles_root)
    return {"default": default_home, "worker_alpha": worker_home}


@pytest.fixture
def client(monkeypatch, isolated_profiles):
    try:
        from starlette.testclient import TestClient
    except ImportError:
        pytest.skip("fastapi/starlette not installed")

    import hermes_state
    from hermes_constants import get_hermes_home
    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", get_hermes_home() / "state.db")
    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


def _load_cfg(home):
    return yaml.safe_load((home / "config.yaml").read_text()) or {}


class TestProfileScopedSkills:

    def test_internal_hermes_skill_is_hidden_from_installed_list(self, client):
        """核心技能继续存在于磁盘，但不会作为用户技能展示。"""
        response = client.get("/api/skills", params={"profile": "worker_alpha"})

        assert response.status_code == 200
        assert {skill["name"] for skill in response.json()} == {"worker-skill"}

    def test_installed_list_keeps_skills_unavailable_on_current_host(
        self, client, isolated_profiles
    ):
        """安装管理列表不应把缺少外部应用的已安装技能误判成未安装。"""
        _write_unavailable_skill(
            isolated_profiles["worker_alpha"] / "skills", "needs-missing-app"
        )

        response = client.get("/api/skills", params={"profile": "worker_alpha"})

        assert response.status_code == 200
        assert {skill["name"] for skill in response.json()} == {
            "worker-skill",
            "needs-missing-app",
        }


    def test_toggle_writes_into_target_profile_only(self, client, isolated_profiles):
        resp = client.put(
            "/api/skills/toggle",
            json={"name": "worker-skill", "enabled": False, "profile": "worker_alpha"},
        )
        assert resp.status_code == 200
        assert resp.json() == {"ok": True, "name": "worker-skill", "enabled": False}

        worker_cfg = _load_cfg(isolated_profiles["worker_alpha"])
        assert "worker-skill" in worker_cfg.get("skills", {}).get("disabled", [])
        # The dashboard's own config must stay untouched — this was the bug.
        default_cfg = _load_cfg(isolated_profiles["default"])
        assert "worker-skill" not in default_cfg.get("skills", {}).get("disabled", [])



    def test_scope_restores_module_globals(self, client, isolated_profiles):
        """The SKILLS_DIR swap is per-request; the module global must be
        restored even after a scoped call (cron-style locked swap)."""
        import tools.skills_tool as skills_tool

        before = skills_tool.SKILLS_DIR
        client.get("/api/skills", params={"profile": "worker_alpha"})
        assert skills_tool.SKILLS_DIR == before


class TestProfileScopedHubActions:
    def test_market_install_matches_original_clawhub_catalog_identity(
        self, client, isolated_profiles
    ):
        """市场包沿用已安装名称，只有来源可验证的 ClawHub 包获得目录别名。"""
        import json

        hub_dir = isolated_profiles["worker_alpha"] / "skills" / ".hub"
        hub_dir.mkdir()
        (hub_dir / "lock.json").write_text(json.dumps({"installed": {
            "api-gateway": {
                "source": "uniwork", "identifier": "api-gateway",
                "metadata": {"source_url": "https://wry-manatee-359.convex.site/api/v1/download?slug=api-gateway&ownerHandle=byungkyu"},
            },
            "other": {
                "source": "uniwork", "identifier": "other",
                "metadata": {"source_url": "https://example.com/api/v1/download?slug=api-gateway"},
            },
        }}), encoding="utf-8")
        response = client.get("/api/skills/hub/sources", params={"profile": "worker_alpha"})

        assert response.status_code == 200
        installed = response.json()["installed"]
        assert installed["clawhub/api-gateway"]["name"] == "api-gateway"
        assert installed["clawhub/api-gateway"] == installed["api-gateway"]
        assert "clawhub/other" not in installed

    def test_hub_install_spawns_with_profile_flag(
        self, client, isolated_profiles, monkeypatch
    ):
        """Hub installs must go through a fresh ``hermes -p <profile>``
        subprocess — the in-process scope can't reach skills_hub's
        import-time SKILLS_DIR binding."""
        import hermes_cli.web_server as web_server

        calls = []

        class _FakeProc:
            pid = 4242

        def _fake_spawn(subcommand, name):
            calls.append((list(subcommand), name))
            return _FakeProc()

        monkeypatch.setattr(_web_server_gateway, "_spawn_hermes_action", _fake_spawn)
        resp = client.post(
            "/api/skills/hub/install",
            json={"identifier": "official/demo", "profile": "worker_alpha"},
        )
        assert resp.status_code == 200
        assert calls == [
            (
                ["-p", "worker_alpha", "skills", "install", "official/demo", "--yes"],
                _web_server_profiles._hub_action_name("install", "official/demo"),
            )
        ]


    def test_hub_install_unknown_profile_404(self, client, isolated_profiles):
        resp = client.post(
            "/api/skills/hub/install",
            json={"identifier": "official/demo", "profile": "ghost"},
        )
        assert resp.status_code == 404
