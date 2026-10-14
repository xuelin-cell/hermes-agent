"""The skills page's Installed tab lists a skill that was switched off.

GET /api/skills called ``_find_all_skills(skip_disabled=False)``, which drops
disabled skills (``skip_disabled=True`` is the one that skips the disabled
filter). A skill switched off was gone from the list on the next load, with
no row left to switch it back on.
"""
import pytest


@pytest.fixture
def client(monkeypatch):
    try:
        from starlette.testclient import TestClient
    except ImportError:
        pytest.skip("fastapi/starlette not installed")

    import hermes_state
    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app
    from hermes_constants import get_hermes_home

    home = get_hermes_home()
    skill = home / "skills" / "uniwork" / "excel"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        "---\nname: excel\ndescription: Spreadsheets\n---\n\n# excel\n", encoding="utf-8"
    )
    (home / "config.yaml").write_text("{}\n", encoding="utf-8")
    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", home / "state.db")
    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


def _listed(client):
    resp = client.get("/api/skills")
    assert resp.status_code == 200
    return {s["name"]: s["enabled"] for s in resp.json()}


def _toggle(client, enabled):
    resp = client.put("/api/skills/toggle", json={"name": "excel", "enabled": enabled})
    assert resp.status_code == 200


def test_switched_off_skill_stays_listed_and_switches_back_on(client):
    assert _listed(client)["excel"] is True

    _toggle(client, False)
    assert _listed(client)["excel"] is False

    _toggle(client, True)
    assert _listed(client)["excel"] is True
