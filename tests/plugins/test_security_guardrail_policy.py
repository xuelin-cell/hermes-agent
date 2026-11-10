"""Profile-scoped settings drive original user/session priority on real writes."""

import importlib
import json

from hermes_constants import hermes_home_key
from hermes_cli.plugins import get_plugin_manager, invoke_hook
from model_tools import handle_function_call
from tests.plugins.test_security_guardrail import profile, write


def test_user_rules_session_allow_and_auto_keep_hard_denies(tmp_path):
    root = tmp_path / "workspace"
    (root / "protected").mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    home = tmp_path / "home"
    with profile(home, root, settings={"user_rules": [{"tool": "Write", "behavior": "deny"}]}) as task_id:
        result = write(root / "ordinary.txt", task_id)
        assert "security-guardrail: user" in result["error"]
        assert not (root / "ordinary.txt").exists()
    with profile(home, root) as task_id:
        # Force one inspection to load the lightweight registration's engine lazily.
        assert not write(root / "inside.txt", task_id).get("error")
        loaded = get_plugin_manager()._plugins["security-guardrail"].module
        policy = importlib.import_module(loaded.__name__ + ".adapters.policy")
        args = {"path": str(outside / "allowed-once.txt"), "content": "session"}
        result = json.loads(handle_function_call("write_file", args, task_id=task_id, session_id="same-session"))
        assert result.get("status") == "blocked"
        policy.allow_session(hermes_home_key(), "other-session", "Write")
        result = json.loads(handle_function_call("write_file", args, task_id=task_id, session_id="same-session"))
        assert result.get("status") == "blocked"
        policy.allow_session(hermes_home_key(), "same-session", "Write")
        result = json.loads(handle_function_call("write_file", args, task_id=task_id, session_id="same-session"))
        assert not result.get("error"), result
        invoke_hook("on_session_end", session_id="same-session")
        assert policy.session_rules(hermes_home_key(), "same-session") == ()
        args["path"] = str(outside / "after-end.txt")
        result = json.loads(handle_function_call("write_file", args, task_id=task_id, session_id="same-session"))
        assert result.get("status") == "blocked"
        assert not (outside / "after-end.txt").exists()
    with profile(home, root, settings={"mode": "auto"}) as task_id:
        assert not write(outside / "auto.txt", task_id).get("error")
        assert write(root / "protected" / "hard-denied.txt", task_id).get("status") == "blocked"
