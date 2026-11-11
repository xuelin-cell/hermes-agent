"""Summarize one foreground PPT turn from local [ppt-timing] log records."""
import argparse
import json
from collections import defaultdict
from pathlib import Path


def union_ms(intervals):
    total = 0
    end = None
    for left, right in sorted(intervals):
        if right < left:
            continue
        total += max(0, right - max(left, end if end is not None else left))
        end = max(right, end if end is not None else right)
    return round(total * 1000, 2)


def summarize(records, session_id, turn_id=None):
    records = [r for r in records if r.get("session_id") == session_id]
    starts = [r for r in records if r.get("event") == "start"]
    turn_id = turn_id or (starts[-1]["turn_id"] if starts else None)
    rows = [r for r in records if r.get("turn_id") == turn_id]
    if not any(r.get("event") == "start" for r in rows):
        raise ValueError("no foreground PPT start for that session/turn")
    end = next((r for r in reversed(rows) if r.get("event") == "end"), None)
    api = []
    tools = []
    seen = set()
    for row in rows:
        event = row.get("event")
        if event in ("api", "api_error"):
            key = (event, row.get("request_id"), row.get("retry_count"))
            if key not in seen:
                seen.add(key)
                api.append(row)
        elif event == "tool":
            tools.append(row)
    known_waits = [r["first_chunk_wait_ms"] for r in api if r.get("first_chunk_wait_ms") is not None]
    categories = defaultdict(float)
    for row in tools:
        categories[row.get("category", "other")] += row.get("duration_ms") or 0
    intervals = [(r["started_at"], r["ended_at"]) for r in api + tools
                 if isinstance(r.get("started_at"), (int, float)) and isinstance(r.get("ended_at"), (int, float))]
    return {"session_id": session_id, "turn_id": turn_id, "complete": end is not None,
            "wall_ms": end.get("wall_ms") if end else None,
            "api_attempts": len(api), "api_errors": sum(r["event"] == "api_error" for r in api),
            "api_duration_sum_ms": round(sum(r.get("duration_ms") or 0 for r in api), 2),
            "first_chunk_wait_sum_ms": round(sum(known_waits), 2) if known_waits else None,
            "first_chunk_unknown_attempts": len(api) - len(known_waits),
            "tool_category_sum_ms": {k: round(v, 2) for k, v in categories.items()},
            "observed_api_tool_union_ms": union_ms(intervals) if intervals else None,
            "checks": [{k: r.get(k) for k in ("pages", "held", "elapsed_ms")}
                       for r in rows if r.get("event") == "check"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log", required=True)
    parser.add_argument("--session", required=True)
    parser.add_argument("--turn")
    args = parser.parse_args()
    records = []
    with Path(args.log).open(encoding="utf-8", errors="replace") as stream:
        for line in stream:
            if "[ppt-timing] " in line:
                records.append(json.loads(line.split("[ppt-timing] ", 1)[1]))
    print(json.dumps(summarize(records, args.session, args.turn), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
