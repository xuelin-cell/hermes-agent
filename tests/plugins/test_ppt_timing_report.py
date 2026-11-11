import importlib.util
from pathlib import Path


def report_module():
    path = Path(__file__).parents[2] / "plugins/uniwork-kits/pptx_support/timing_report.py"
    spec = importlib.util.spec_from_file_location("ppt_timing_report", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_overlaps_retries_and_background_are_not_mistaken_for_foreground_wall_time():
    api = {"event": "api", "session_id": "s", "turn_id": "user", "request_id": "r", "retry_count": 0,
           "started_at": 1, "ended_at": 4, "duration_ms": 3000, "first_chunk_wait_ms": 1000}
    data = [{"event": "start", "session_id": "s", "turn_id": "user"}, api, api,
            {"event": "tool", "session_id": "s", "turn_id": "user", "category": "build",
             "started_at": 3, "ended_at": 5, "duration_ms": 2000},
            {"event": "api", "session_id": "s", "turn_id": "background", "duration_ms": 90000},
            {"event": "end", "session_id": "s", "turn_id": "user", "wall_ms": 5000}]
    result = report_module().summarize(data, "s")
    assert result["api_attempts"] == 1
    assert result["api_duration_sum_ms"] == 3000
    assert result["observed_api_tool_union_ms"] == 4000
    assert result["observed_api_tool_union_ms"] <= result["wall_ms"]


def test_missing_stream_timing_is_unknown_and_latest_foreground_turn_is_selected():
    data = [{"event": "start", "session_id": "s", "turn_id": "old"},
            {"event": "end", "session_id": "s", "turn_id": "old", "wall_ms": 100},
            {"event": "start", "session_id": "s", "turn_id": "new"},
            {"event": "api_error", "session_id": "s", "turn_id": "new", "request_id": "r", "duration_ms": 50}]
    result = report_module().summarize(data, "s")
    assert result["turn_id"] == "new" and result["complete"] is False
    assert result["first_chunk_wait_sum_ms"] is None
    assert result["first_chunk_unknown_attempts"] == 1 and result["api_errors"] == 1
