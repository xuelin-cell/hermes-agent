"""从 Hermes 原生完整展示历史生成只读快照，不读取界面窗口或改写会话。"""

from __future__ import annotations

import hashlib
import json
import re
import time

MAX_MESSAGES = 10000
MAX_SOURCE_BYTES = 8 * 1024 * 1024
_BACKGROUND = re.compile(r"^\[IMPORTANT: Background process [\s\S]*\]$", re.I)


class SnapshotError(ValueError):
    """表示分享准备不可继续的明确状态，不向页面泄露数据库和本机路径。"""


def _digest(value) -> str:
    """对规范 JSON 求摘要，客户端不能自报已验证的会话版本。"""
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _assert_idle(db, sid: str) -> None:
    """读取原生跨进程租约及压缩锁，生成中或状态无法确认时不准备分享。"""
    key = db._session_turn_lease_key(sid)
    lease = db._read_one(
        "SELECT 1 FROM session_turn_leases WHERE conversation_id = ? AND expires_at >= ?", (key, time.time()))
    if lease or db.get_compression_lock_holder(sid):
        raise SnapshotError("会话正在生成或压缩，请完成后再分享。")


def _public_blocks(message: dict) -> list[dict]:
    """只投影明确可展示的正文和过程字段，附件及原始工具参数不进入快照。"""
    role = message.get("role")
    if role == "tool":
        return [{"type": "tool", "name": str(message.get("name") or "tool")[:100]}]
    blocks = []
    text = message.get("display_content", message.get("text"))
    if role == "assistant" and not text and message.get("codex_message_items"):
        items = message["codex_message_items"]
        if isinstance(items, str):
            try:
                items = json.loads(items)
            except json.JSONDecodeError as error:
                raise SnapshotError("回复展示数据不完整，无法准备分享。") from error
        if isinstance(items, list):
            text = "".join(part["text"] for item in items if isinstance(item, dict)
                           and item.get("type") == "message" and item.get("role") == "assistant"
                           and str(item.get("phase", "")).lower() not in {"analysis", "commentary"}
                           for part in item.get("content", []) if isinstance(part, dict)
                           and part.get("type") in {"output_text", "text"} and isinstance(part.get("text"), str))
    if isinstance(text, str) and role == "user":
        text = re.split(r"(?:^|\n)--- (?:Attached Context|Context Warnings) ---", text, maxsplit=1)[0]
        text = re.sub(r"<memory-context>[\s\S]*?(?:</memory-context>|$)", "", text, flags=re.I)
        text = re.sub(r'@(file|image):(?:"[^"\n]+"|\x27[^\x27\n]+\x27|`[^`\n]+`|\S+)', "", text)
        text = re.sub(r"\[(?:Image attached at:|The user attached an image:)[^\]]*\]", "", text, flags=re.I)
    if isinstance(text, str) and text.strip():
        # 原生展示投影在 image_urls=False 时不会携带上传图片或附件 URL。
        blocks.append({"type": "markdown", "text": text})
    if role == "assistant":
        reasoning = message.get("display_reasoning", message.get("reasoning") or message.get("reasoning_content"))
        if isinstance(reasoning, str) and reasoning.strip():
            blocks.insert(0, {"type": "reasoning", "text": reasoning})
    for commentary in message.get("display_commentary") or []:
        if isinstance(commentary, str) and commentary.strip() and commentary not in (text or ""):
            blocks.insert(0, {"type": "markdown", "text": commentary})
    return blocks


_DEFAULT_TITLES = {
    "zh": {"session": "分享的会话", "response": "分享的回复"},
    "zh-hant": {"session": "分享的對話", "response": "分享的回覆"},
    "en": {"session": "Shared conversation", "response": "Shared response"},
}


def _default_title(locale: str, scope: str) -> str:
    """快照没有会话标题或只分享单条回复时，按分享者界面语言给出标题，未覆盖的语言用英文。"""
    titles = _DEFAULT_TITLES.get(str(locale).lower()) or _DEFAULT_TITLES.get(str(locale).split("-")[0].lower())
    return (titles or _DEFAULT_TITLES["en"])[scope]


def _turn_messages(group: list[dict]) -> list[dict]:
    """按桌面版的折叠规则投影一轮：最后一段助手正文是答案，其余旁白、思考和工具都属于过程。"""
    result = []
    user = group[0] if group and group[0]["kind"] == "user" else None
    if user and user["blocks"]:
        result.append({"rows": [user["row"]], "message": {"role": "user", "blocks": user["blocks"]}})
    replies = [entry for entry in group if entry is not user]
    answer_at = next((index for index in range(len(replies) - 1, -1, -1) if replies[index]["kind"] == "assistant"
                      and any(block["type"] == "markdown" for block in replies[index]["blocks"])), None)
    answer, process = [], []
    for index, entry in enumerate(replies):
        if index == answer_at:
            # 桌面版同一消息中最后一段文字之前的评论同样折叠为过程。
            final = [block for block in entry["blocks"] if block["type"] == "markdown"][-1]
            answer = [final]
            process += [block for block in entry["blocks"] if block is not final]
        else:
            process += entry["blocks"]
    message = {"role": "assistant", "blocks": answer}
    if process:
        message["process"] = process
    # 与桌面版重新加载后的「用时」一致：起点是提问；有工具调用时终点是最后一次工具完成，否则是回复本身。
    def stamps(kind: str) -> list[float]:
        return [entry["timestamp"] for entry in replies
                if entry["kind"] == kind and isinstance(entry["timestamp"], (int, float))]

    ends = stamps("tool") or stamps("assistant")
    start = user["timestamp"] if user else None
    if ends and isinstance(start, (int, float)) and max(ends) >= start:
        message["durationS"] = int(max(ends) - start)
    if answer or process:
        result.append({"rows": [entry["row"] for entry in replies], "message": message})
    return result


def build_snapshot(db, request: dict, *, owner: str | None, profile_home=None) -> dict:
    """从完整活动分支构造快照，并以持久行号定位整次回复而非最后一段消息。"""
    # 原生历史 helper 在 server 上绑定运行时命名空间，不能直接调用未绑定的 sibling。
    from tui_gateway.server import _history_to_messages

    requested = request["sessionId"]
    session = db.get_session(requested)
    if not session or (owner is not None and session.get("profile_name") not in (None, "", owner)):
        raise SnapshotError("会话不存在或不属于当前配置。")
    sid = db.resolve_resume_session_id(requested)
    session = db.get_session(sid)
    if not session or (owner is not None and session.get("profile_name") not in (None, "", owner)):
        raise SnapshotError("活动分支不存在或不属于当前配置。")
    _assert_idle(db, sid)
    count = db.get_resume_message_count(sid)
    if count > MAX_MESSAGES:
        raise SnapshotError("会话超过分享大小限制，未发布截断内容。")
    _, history = db.get_resume_conversations(sid)
    if len(json.dumps(history, ensure_ascii=False).encode()) > MAX_SOURCE_BYTES:
        raise SnapshotError("会话超过分享大小限制，未发布截断内容。")
    revision = _digest({"session": sid, "history": history, "title": session.get("title")})
    messages = _history_to_messages(history, profile_home=profile_home, image_urls=False)
    # 回复身份来自持久历史，不能随「包含过程」开关或正文投影的过滤而消失。
    visible_users = {item.get("row_id") for item in messages if item.get("role") == "user"
                     and not _BACKGROUND.match(item.get("text", ""))}
    visible_assistants = {item.get("row_id") for item in messages if item.get("role") == "assistant"}
    anchors = {}
    turn = None
    for raw in history:
        row = raw.get("_row_id")
        if row in visible_users:
            turn = row
        if raw.get("role") == "assistant" and (row in visible_assistants or (
                raw.get("tool_calls") and not raw.get("content") and raw.get("display_kind") != "hidden")):
            anchors[row] = turn
    selected = []
    groups = [selected]
    turns = {None: selected}
    for message in messages:
        role = message.get("role")
        kind = message.get("display_kind")
        background = role == "system" and kind in {"process", "process_notification"}
        background |= role == "user" and bool(_BACKGROUND.match(message.get("text", "")))
        if role == "user" and not background:
            selected = []
            groups.append(selected)
            turns[message.get("row_id")] = selected
        if role not in {"user", "assistant", "tool"} and not background:
            continue
        blocks = [{"type": "tool", "name": "Background process"}] if background else _public_blocks(message)
        selected.append({"row": message.get("row_id"), "kind": "background" if background else role,
                         "timestamp": message.get("timestamp"), "blocks": blocks})
    scope = request.get("scope", "session")
    if scope == "response":
        row_id = request.get("responseRowId")
        if row_id not in anchors:
            raise SnapshotError("无法在完整活动分支中定位该回复，请刷新后重试。")
        selection = [item for item in _turn_messages(turns[anchors[row_id]])
                     if item["message"]["role"] == "assistant"]
    else:
        selection = [item for group in groups for item in _turn_messages(group)]
    if not selection:
        raise SnapshotError("没有可分享的完整内容。")
    document = {
        "schemaVersion": 1, "scope": scope,
        "title": _default_title(request.get("locale", "zh"), "response") if scope == "response"
        else str(session.get("title") or _default_title(request.get("locale", "zh"), "session")),
        "locale": request.get("locale", "zh"), "theme": request.get("theme", "light"),
        "messages": [item["message"] for item in selection], "rendererVersion": 2,
    }
    from plugins.conversation_share.resources import snapshot_images
    document["assets"] = snapshot_images(document["messages"], session.get("cwd"))
    identity = {"session": requested, "scope": scope, "selection": selection, "document": {key: value for key, value in document.items() if key != "rendererVersion"}}
    document["snapshotId"] = _digest(identity)
    if scope == "response":
        document["responseId"] = _digest([row for item in selection for row in item["rows"]])
    _assert_idle(db, sid)
    return {"document": document, "revision": revision, "sessionId": sid}
