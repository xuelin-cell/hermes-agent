"""Expose only confirmed PPT snapshots; keep working files local."""
from pathlib import Path
import json



def observe(turn, tool_name, data, status):
    if tool_name != "TencentPpt":
        return False
    turn.native_ppt = turn.deck = True
    if status != "ok" or not isinstance(data, dict):
        return True
    receipt = data.get("presentation")
    if not isinstance(receipt, dict):
        return True
    if receipt.get("purpose") == "internal" or not receipt.get("written_pages"):
        return True
    source = receipt.get("source_path")
    if source:
        source = Path(source).resolve()
    if source and data.get("ok") is True and receipt.get("status") == "final":
        final = Path(receipt["file_path"]).resolve()
        if final.is_file() and final != source:
            # 修订会生成新快照路径；以工作稿身份替换旧版，不按同名文件误合并其它成品。
            turn.native_finals[source] = final
            turn.owned.add(final)
            turn.paths[final] = None
    return True


def unpublished(turn, path):
    if path.suffix.lower() not in {".ppt", ".pptx"}:
        return False
    receipt = path.parent / ".ppt-state" / (path.name + ".json")
    if receipt.is_file():
        try:
            data = json.loads(receipt.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return True
        if data.get("purpose") == "internal" or not data.get("pages") and not data.get("edit_saved"):
            return True
    return turn.native_ppt and path not in turn.native_finals.values()
