"""Require the current comparison image to be read before approving a material page."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from . import turns
from .native_ppt_events import context

IMAGE_FIELDS = {"analyze_image": "image_url_or_oss_path", "vision_analyze": "image_url", "desktop_read_image": "path"}


def around_call(*, tool_name="", args=None, original_args=None, next_call, session_id="", turn_id="", task_id="", tool_call_id="", **_):
    """The agent uploads images before pre-tool hooks; retain the original local identity."""
    from .media_slot import leaf

    field = IMAGE_FIELDS.get(leaf(tool_name))
    if not field:
        return next_call(args)
    original = original_args if isinstance(original_args, dict) else args
    turn = turns.current(session_id, turn_id, task_id)
    path = Path(str((original or {}).get(field) or "")) if field else None
    # A resumed turn can read its comparison before invoking any PPT tool.
    # Evidence belongs to this turn's actual read, not to the order of tools.
    if path is None or not path.is_file():
        return next_call(args)
    intent = (str(path.resolve()), hashlib.sha256(path.read_bytes()).hexdigest())
    from .host_hooks import _image_key
    key = _image_key(tool_name, original) if turn.native_ppt else None
    result = turn.native_images[key] if key and key in turn.native_images else next_call(args)
    turn.native_visual_pending[tool_call_id] = intent
    record(turn, tool_name, original, result, tool_call_id)
    if key and len(turn.native_images) < 32 and turn.native_visual_reads.get(intent[0]) == intent[1]:
        turn.native_images[key] = result
    return result


def before(turn, tool_name, args, call_id):
    from .media_slot import leaf

    field = IMAGE_FIELDS.get(leaf(tool_name))
    if not field or not isinstance(args, dict):
        return
    path = Path(str(args.get(field) or ""))
    if path.is_file() and len(turn.native_visual_pending) < 256:
        turn.native_visual_pending[call_id] = (str(path.resolve()), hashlib.sha256(path.read_bytes()).hexdigest())


def record(turn, tool_name, args, result, call_id=""):
    from .media_slot import leaf

    field = IMAGE_FIELDS.get(leaf(tool_name))
    if not field or not isinstance(args, dict):
        return
    intent = turn.native_visual_pending.pop(call_id, None)
    try:
        data = result if isinstance(result, dict) else json.loads(result)
    except (TypeError, ValueError):
        return
    if not isinstance(data, dict) or data.get("error") or data.get("isError") or data.get("ok") is False or data.get("success") is False:
        return
    if leaf(tool_name) == "desktop_read_image" and (
        not data.get("_multimodal") or not any(
            isinstance(part, dict) and part.get("type") == "image_url"
            and isinstance(part.get("image_url"), dict) and part["image_url"].get("url")
            for part in data.get("content", [])
        )
    ):
        return
    if intent is None:
        path = Path(str(args.get(field) or ""))
        if not path.is_file():
            return
        intent = (str(path.resolve()), hashlib.sha256(path.read_bytes()).hexdigest())
    if len(turn.native_visual_reads) < 256:
        turn.native_visual_reads[intent[0]] = intent[1]


def require_reads(receipt, pages):
    if not receipt.get("require_read_evidence") or not pages:
        return
    identity = context.get()
    turn = turns.current(identity.get("session_id", ""), identity.get("turn_id", ""))
    missing = {}
    for index in pages:
        path = Path(receipt.get("review_images", {}).get(str(index), ""))
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() not in turn.native_visual_reads.values():
            page_hash=hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
            batched=any(item.get('pages',{}).get(str(index))==page_hash and item.get('sha256') in turn.native_visual_reads.values()
                        and Path(contact).is_file() and hashlib.sha256(Path(contact).read_bytes()).hexdigest()==item['sha256']
                        for contact,item in receipt.get('review_contacts',{}).items())
            if not batched:missing[index] = str(path)
    if missing:
        raise ValueError(
            f"尚未实际读取本版本核对图：{missing}。支持图片的主模型用desktop_read_image读取；"
            "纯文本模型沿用现有analyze_image或vision_analyze。"
            "逐页比较SOURCE与SAVED PPT的原文、缺失标注、框形、强调和连线，再提交review-material。"
            "不要重做原材料识图、测色或构建；已通过且未改的页不需要重复核对。"
        )
