"""Template cleanup requires explicit legacy selection and live reference checks."""

import json
import os
from pathlib import Path
import subprocess


SCRIPT = Path(__file__).resolve().parents[2] / "deploy/hermes-mt/deploy-isolated.sh"


def run_cleanup(tmp_path, command, *, mode="unused", image="old", branch=""):
    tmp_path.mkdir(parents=True, exist_ok=True)
    repo = "hermes-isolated/test-project/cloud-adaptation-fingerprint-cube"
    templates = [
        {"templateID": "tpl-current", "status": "READY", "imageInfo": f"http://registry/{repo}:current"},
        {"templateID": "tpl-old", "status": "READY", "imageInfo": f"http://registry/hermes-isolated/test-project-cube:{image}@sha256:abc"},
        {"templateID": "tpl-foreign", "status": "READY", "imageInfo": "http://registry/hermes-mt/hermes-mt-cube:old"},
    ]
    (tmp_path / "templates.json").write_text(json.dumps(templates))
    suffix = f" branch={branch}" if branch else ""
    (tmp_path / "history").write_text(f"commit=abc image=old template=tpl-old{suffix}\n")
    functions = "branch_templates() {" + SCRIPT.read_text().split("branch_templates() {", 1)[1].split('\ncase "${1:-}" in', 1)[0]
    harness = r'''
set -euo pipefail
PROJECT=test-project
BRANCH=cloud-adaptation
TEMPLATE=tpl-current
HISTORY="$CASE_DIR/history"
REPO_PATH=hermes-isolated/test-project/cloud-adaptation-fingerprint-cube
api() { cat "$CASE_DIR/templates.json"; }
die() { printf '%s\n' "$*" >&2; exit 1; }
say() { :; }
ok() { :; }
warn() { :; }
confirm() { return 0; }
tenant_templates() { if [ "$CHECK_MODE" = db ]; then echo tpl-old; fi; return 0; }
cluster_sandbox_templates() {
    local count=0
    [ ! -f "$CASE_DIR/count" ] || count="$(cat "$CASE_DIR/count")"
    count=$((count + 1))
    printf '%s' "$count" > "$CASE_DIR/count"
    if [ "$CHECK_MODE" = unknown ]; then echo '-'; fi
    if [ "$CHECK_MODE" = late ] && [ "$count" -ge 2 ]; then echo tpl-old; fi
    return 0
}
delete_template() { printf '%s\n' "$1" >> "$CASE_DIR/deleted"; }
'''
    return subprocess.run(
        ["bash", "-c", harness + functions + "\n" + command],
        env={**os.environ, "CASE_DIR": str(tmp_path), "CHECK_MODE": mode},
        text=True, capture_output=True,
    )


def test_legacy_selection_requires_history_and_matching_project_image(tmp_path):
    result = run_cleanup(tmp_path / "default", "branch_templates")
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == ["tpl-current\tREADY"]
    result = run_cleanup(tmp_path / "explicit", "branch_templates tpl-old")
    assert result.returncode == 0, result.stderr
    assert {line.split()[0] for line in result.stdout.splitlines()} == {"tpl-current", "tpl-old"}
    for label, command, options in (
        ("wrong-image", "branch_templates tpl-old", {"image": "different"}),
        ("other-branch", "branch_templates tpl-old", {"branch": "feat/cloud-ch"}),
        ("unrecorded", "branch_templates tpl-foreign", {}),
    ):
        result = run_cleanup(tmp_path / label, command, **options)
        assert result.returncode != 0
        assert not result.stdout


def test_cleanup_keeps_current_and_rechecks_references_before_deleting(tmp_path):
    for mode in ("unused", "db", "unknown", "late"):
        case = tmp_path / mode
        result = run_cleanup(case, "cmd_purge_templates --legacy-template tpl-old", mode=mode)
        if mode == "unknown":
            assert result.returncode != 0
        else:
            assert result.returncode == 0, result.stderr
        deleted = (case / "deleted").read_text().splitlines() if (case / "deleted").exists() else []
        assert deleted == (["tpl-old"] if mode == "unused" else [])
