"""会话分享从真实持久化历史读取，完整回复不依赖界面分页与消息索引。"""

import json
import base64

import pytest

from hermes_state import SessionDB
from plugins.conversation_share.snapshot import SnapshotError, build_snapshot


@pytest.mark.parametrize("reasoning", [None, "思考内容"])
def test_response_anchor_survives_process_rows(tmp_path, reasoning):
    """工具或思考起始行仍定位同一整轮回复，过程行不改变回复身份。"""
    db = SessionDB(tmp_path / "state.db")
    try:
        db.create_session("chat", source="desktop")
        question = db.append_message("chat", "user", "私有问题")
        anchor = db.append_message("chat", "assistant", reasoning=reasoning, tool_calls=[{
            "id": "call", "type": "function", "function": {"name": "terminal", "arguments": "{}"}}])
        db.append_message("chat", "tool", "私有结果", tool_name="terminal", tool_call_id="call")
        final = db.append_message("chat", "assistant", "完整结论")
        db.append_message("chat", "user", "下一轮")
        db.append_message("chat", "assistant", "其他结论")
        request = {"sessionId": "chat", "scope": "response"}
        first = build_snapshot(db, {**request, "responseRowId": anchor}, owner=None)
        last = build_snapshot(db, {**request, "responseRowId": final}, owner=None)
        assert first == last
        text = json.dumps(first["document"], ensure_ascii=False)
        assert "完整结论" in text
        assert all(value not in text for value in ("私有问题", "私有结果", "其他结论"))
        assert ("思考内容" in text) == (reasoning is not None)
        with pytest.raises(SnapshotError, match="定位"):
            build_snapshot(db, {**request, "responseRowId": question}, owner=None)
    finally:
        db.close()


def test_full_history_and_response_projection_use_durable_rows(tmp_path, monkeypatch):
    """超过界面分页的历史仍完整，单回复包含工具前后段但不包含问题或其他轮次。"""
    db = SessionDB(tmp_path / "state.db")
    try:
        db.create_session("chat", source="desktop", profile_name="default", cwd=str(tmp_path))
        picture = tmp_path / "figure.png"
        picture.write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="))
        db.set_session_title("chat", "不能作为回复标题的问题")
        db.append_messages_batch("chat", [{"role": role, "content": f"{role}-{i}"}
                                         for i in range(260) for role in ("user", "assistant")])
        db.append_message("chat", "user", "这句问题不要进入单回复\n--- Attached Context ---\nprivate-file-body", display_metadata={"attachments": ["private.pdf"]})
        anchor = db.append_message("chat", "assistant", "第一段\n![图][picture]\n\n[picture]: figure.png\n\n```md\n![代码里的示例](private.png)\n```", reasoning="可见思考",
                                   tool_calls=[{"id": "call", "type": "function", "function": {
                                       "name": "terminal", "arguments": '{"command":"secret-token"}'}}])
        db.append_message("chat", "tool", '{"secret":"private"}', tool_name="terminal", tool_call_id="call")
        db.append_message("chat", "user", "[IMPORTANT: Background process finished: private-output]")
        db.append_message("chat", "assistant", "最后一段")
        db.append_message("chat", "user", "下一轮问题")
        db.append_message("chat", "assistant", codex_message_items=[
            {"type": "message", "role": "assistant", "phase": "analysis", "content": [{"type": "output_text", "text": "internal-not-public"}]},
            {"type": "message", "role": "assistant", "phase": "final_answer", "content": [{"type": "output_text", "text": "其他回复"}]},
        ])
        # 模拟原生原地压缩保留的展示行，完整分享仍必须包含这些历史。
        db._execute_write(lambda connection: connection.execute(
            "UPDATE messages SET active=0, compacted=1 WHERE session_id=? AND id<?", ("chat", anchor - 1)))
        full = build_snapshot(db, {"sessionId": "chat"}, owner="default")
        # 与桌面版一样只有最后一段是答案，工具前的旁白进入折叠过程而不是正文。
        turn = next(item for item in full["document"]["messages"]
                    if any("最后一段" in block.get("text", "") for block in item["blocks"]))
        assert "第一段" not in json.dumps(turn["blocks"], ensure_ascii=False)
        assert "第一段" in json.dumps(turn["process"], ensure_ascii=False)
        assert len(full["document"]["messages"]) > 500
        assert "private-file-body" not in json.dumps(full["document"])
        assert "其他回复" in json.dumps(full["document"], ensure_ascii=False)
        assert "internal-not-public" not in json.dumps(full["document"])
        reply = build_snapshot(db, {"sessionId": "chat", "scope": "response", "responseRowId": anchor}, owner="default")
        serialized = json.dumps(reply["document"], ensure_ascii=False)
        assert all(text in serialized for text in ("第一段", "最后一段", "可见思考", "terminal"))
        assert all(text not in serialized for text in ("这句问题", "下一轮问题", "其他回复", "secret-token", "private.pdf", "private-output"))
        assert reply["document"]["title"] == "分享的回复"
        english = build_snapshot(db, {"sessionId": "chat", "scope": "response", "responseRowId": anchor, "locale": "en"}, owner="default")
        assert english["document"]["title"] == "Shared response"
        assert build_snapshot(db, {"sessionId": "chat"}, owner="default") == full
        assert [asset["reference"] for asset in full["document"]["assets"]] == ["figure.png"]
        picture.write_bytes(picture.read_bytes() + b"changed")
        changed = build_snapshot(db, {"sessionId": "chat"}, owner="default")
        assert changed["document"]["snapshotId"] != full["document"]["snapshotId"]
        full = changed
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from hermes_cli import web_server
        from hermes_cli.web_server_dashboard import _discover_dashboard_plugins, _mount_plugin_api_routes
        from hermes_cli.web_server_profiles import _hermes_home_scope

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        # 测试隔离夹具显式覆盖了默认数据库路径；让真实 REST 读取同一临时数据库。
        monkeypatch.setattr("hermes_state.DEFAULT_DB_PATH", tmp_path / "state.db")
        app = FastAPI()
        discovered = [item for item in _discover_dashboard_plugins() if item["name"] == "conversation-share"]
        assert len(discovered) == 1 and discovered[0]["source"] == "bundled"
        monkeypatch.setattr(web_server, "app", app)
        monkeypatch.setattr(web_server, "_get_dashboard_plugins", lambda: discovered)
        _mount_plugin_api_routes()
        with _hermes_home_scope(tmp_path), TestClient(app) as client:
            result = client.post("/api/plugins/conversation-share/snapshot", json={"sessionId": "chat"})
            assert result.status_code == 200, result.text
            assert result.json()["document"] == full["document"]
            assert client.post("/api/plugins/conversation-share/snapshot", json={
                "sessionId": "chat", "messages": [{"role": "assistant", "text": "伪造"}]
            }).status_code == 422
        with pytest.raises(SnapshotError, match="定位"):
            build_snapshot(db, {"sessionId": "chat", "scope": "response", "responseRowId": 999999}, owner="default")
    finally:
        db.close()


def test_snapshots_isolate_profiles_and_reject_busy_or_changed_history(tmp_path, monkeypatch):
    """A→B→A 的真实数据库互不串用，生成中拒绝读取且内容变更形成新身份。"""
    snapshots = []
    for name in ("a", "b", "a"):
        home = tmp_path / name
        home.mkdir(exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))
        db = SessionDB(home / "state.db")
        try:
            if not db.get_session("same-id"):
                db.create_session("same-id", source="desktop", profile_name=name)
                db.append_message("same-id", "user", "你好")
                db.append_message("same-id", "assistant", name)
            snapshot = build_snapshot(db, {"sessionId": "same-id"}, owner=name)
            snapshots.append(snapshot)
            with pytest.raises(SnapshotError, match="不属于"):
                build_snapshot(db, {"sessionId": "same-id"}, owner="other")
            assert db.try_acquire_session_turn_lease("same-id", "share-test")
            with pytest.raises(SnapshotError, match="正在生成"):
                build_snapshot(db, {"sessionId": "same-id"}, owner=name)
            db.release_session_turn_lease("same-id", "share-test")
        finally:
            db.close()
    assert snapshots[0] == snapshots[2]
    assert snapshots[0]["document"]["snapshotId"] != snapshots[1]["document"]["snapshotId"]
    db = SessionDB(tmp_path / "a/state.db")
    try:
        db.append_message("same-id", "user", "继续")
        changed = build_snapshot(db, {"sessionId": "same-id"}, owner="a")
        assert changed["revision"] != snapshots[0]["revision"]
        assert changed["document"]["snapshotId"] != snapshots[0]["document"]["snapshotId"]
    finally:
        db.close()


def test_unusable_images_do_not_block_snapshot(tmp_path):
    """读不到或格式不支持的正文图片不中止分享，只是不登记，由前端显示占位。"""
    db = SessionDB(tmp_path / "state.db")
    try:
        db.create_session("chat", source="desktop", cwd=str(tmp_path))
        (tmp_path / "ok.png").write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="))
        (tmp_path / "notes.txt").write_text("not an image")
        db.append_message("chat", "user", "看图")
        db.append_message("chat", "assistant", "![可用](ok.png) ![丢失](missing.png) ![文本](notes.txt) ![临时](blob:abc)")
        snapshot = build_snapshot(db, {"sessionId": "chat"}, owner=None)
        assert [asset["reference"] for asset in snapshot["document"]["assets"]] == ["ok.png"]
        assert "丢失" in json.dumps(snapshot["document"], ensure_ascii=False)
    finally:
        db.close()



def test_system_notices_stay_inside_the_turn(tmp_path):
    """后台任务完成等系统通知不是用户提问：不拆分回复，也不把内部提示文字公开。"""
    db = SessionDB(tmp_path / "state.db")
    try:
        db.create_session("chat", source="desktop")
        db.append_message("chat", "user", "帮我生成播客")
        db.append_message("chat", "assistant", "任务已提交后台")
        db.append_message("chat", "user", "[ASYNC DELEGATION BATCH COMPLETE — deleg_1] internal summary",
                          display_kind="async_delegation_complete")
        final = db.append_message("chat", "assistant", "播客已生成")
        messages = build_snapshot(db, {"sessionId": "chat"}, owner=None)["document"]["messages"]
        assert [item["role"] for item in messages] == ["user", "assistant"]
        assert "ASYNC DELEGATION" not in json.dumps(messages, ensure_ascii=False)
        reply = build_snapshot(db, {"sessionId": "chat", "scope": "response", "responseRowId": final}, owner=None)
        assert "任务已提交后台" in json.dumps(reply["document"], ensure_ascii=False)
    finally:
        db.close()
