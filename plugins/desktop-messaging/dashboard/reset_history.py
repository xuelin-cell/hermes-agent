"""Explicit, account-scoped reset of connected messaging transcripts."""
from pathlib import Path


def reset_platform_history(home: Path, platforms: set[str]) -> int:
    from hermes_state import SessionDB

    if not platforms:
        return 0
    db = SessionDB(home / "state.db")
    try:
        ids = []
        offset = 0
        while True:
            rows = db.list_sessions_rich(
                sources=sorted(platforms), limit=1000, offset=offset,
                include_children=True, include_archived=True, include_hidden=True,
                include_subagents=True, project_compression_tips=False,
            )
            ids.extend(row["id"] for row in rows)
            if len(rows) < 1000:
                break
            offset += len(rows)
        skipped = []
        deleted = db.delete_sessions(ids, sessions_dir=home / "sessions",
                                     exclude_active_write_guards=True, skipped_ids=skipped)
        if skipped:
            raise RuntimeError("messaging_history_has_active_writers")
        return deleted
    finally:
        db.close()
