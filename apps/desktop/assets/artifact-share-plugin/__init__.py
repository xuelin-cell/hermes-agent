"""随 desktop-mt 安装的产物发布工具。"""

from __future__ import annotations

import html
import json
import hashlib
from html.parser import HTMLParser
from pathlib import Path

from .bridge_client import call_bridge
from .provenance import before_turn, before_tool, after_tool, after_turn

SCHEMA = {
    "name": "publish_artifact",
    "description": (
        "Publish a generated HTML or Markdown file as a public link only when the user "
        "explicitly asks to share or update it. Use a file under this conversation's "
        "working directory (including subdirectories); no outputs folder or copy is required. "
        "Only origin-verified model files are eligible. User uploads, derived files and unknown "
        "files cannot be published; copying or renaming them does not remove this restriction. "
        "New links expire after one day by default. Set ttl_days only when the user explicitly asks for a different lifetime (1 to 7 days). A successful result includes the real public URL and expiration."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Path to a generated .html, .htm or .md file"},
            "ttl_days": {"type": "integer", "minimum": 1, "maximum": 7, "description": "Lifetime in days; omit to use the default or preserve an existing link's expiration."},
        },
        "required": ["path"],
    },
}


class _LocalResourceScanner(HTMLParser):
    """找出分享页中无法从公网读取的本机或相对资源。"""

    def __init__(self) -> None:
        """初始化资源扫描结果。"""
        super().__init__()
        self.unsafe = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        """检查资源属性，页内锚点不视为外部依赖。"""
        values = dict(attrs)
        for name in ("src", "href"):
            value = (values.get(name) or "").strip()
            if not value or value.startswith("#"):
                continue
            if value.startswith(("data:", "https://", "http://", "mailto:")):
                continue
            self.unsafe = True


def _render_markdown(source: str, title: str) -> str:
    """将 Markdown 渲染成不执行原始 HTML 的独立静态页面。"""
    from markdown import markdown

    body = markdown(html.escape(source), extensions=["tables", "fenced_code"])
    return (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<title>{html.escape(title)}</title>'
        '<style>body{font:16px/1.65 system-ui,sans-serif;max-width:800px;margin:40px auto;'
        'padding:0 24px;color:#202124}pre{overflow:auto;padding:16px;background:#f5f5f5}'
        'img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px}</style>'
        f'</head><body>{body}</body></html>'
    )


def _handle_publish(args: dict, *, task_id: str | None = None, session_id: str | None = None) -> str:
    """按当前会话工作目录读取产物，并请求桌面主进程执行发布。"""
    if not task_id or not session_id:
        return json.dumps({"error": "无法确定当前会话，未发布产物。"}, ensure_ascii=False)
    ttl_days = args.get("ttl_days")
    if ttl_days is not None and (isinstance(ttl_days, bool) or not isinstance(ttl_days, int) or not 1 <= ttl_days <= 7):
        return json.dumps({"error": "有效期必须为 1～7 天的整数。"}, ensure_ascii=False)
    raw_path = args.get("path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        return json.dumps({"error": "请指定产物文件路径。"}, ensure_ascii=False)

    from tools.terminal_tool import get_session_cwd

    cwd = get_session_cwd(task_id)
    if not cwd:
        return json.dumps({"error": "当前会话没有可验证的工作目录。"}, ensure_ascii=False)
    root = Path(cwd).resolve()
    candidate = (root / raw_path).resolve()
    if root not in candidate.parents or candidate.suffix.lower() not in {".html", ".htm", ".md", ".mdx", ".markdown"}:
        return json.dumps({"error": f"只能发布当前工作目录及其子目录中的 HTML 或 Markdown 文件：{root}"}, ensure_ascii=False)
    if not candidate.is_file() or candidate.stat().st_size > 2 * 1024 * 1024:
        return json.dumps({"error": "产物不存在或超过 2 MB。"}, ensure_ascii=False)
    frozen = candidate.read_bytes()
    source = frozen.decode("utf-8")
    origin_source = {"sessionId": session_id, "path": str(candidate), "hash": hashlib.sha256(frozen).hexdigest()}
    try:
        eligibility = call_bridge("/eligibility", origin_source)
    except Exception as error:
        return json.dumps({"error": f"无法确认产物来源：{error}"}, ensure_ascii=False)
    if not eligibility.get("publishable"):
        return json.dumps({"error": "只能分享来源已确认的模型产物；上传文件及其派生产物不能发布，请勿复制或改名绕过。"}, ensure_ascii=False)
    document = _render_markdown(source, candidate.stem) if candidate.suffix.lower() in {".md", ".mdx", ".markdown"} else source
    if not document.strip():
        return json.dumps({"error": "产物为空。"}, ensure_ascii=False)
    scanner = _LocalResourceScanner()
    scanner.feed(document)
    if scanner.unsafe:
        return json.dumps({"error": "产物引用本机或相对资源，请先整理为自包含网页。"}, ensure_ascii=False)

    key = f"file:{session_id}:{candidate}"
    try:
        record = call_bridge("/publish", {"key": key, "html": document, "title": candidate.name, "source": origin_source, **({"ttlDays": ttl_days} if ttl_days is not None else {})}, timeout=95)
    except Exception as error:
        return json.dumps({"error": f"分享失败：{error}"}, ensure_ascii=False)
    return json.dumps({"share_id": record["shareId"], "url": record["url"], "version": record["version"], "expires_at": record.get("expiresAt")}, ensure_ascii=False)


def register(ctx) -> None:
    """把分享工具放进桌面会话已有的 desktop_ui 工具集。"""
    ctx.register_tool(
        name="publish_artifact", toolset="desktop_ui", schema=SCHEMA,
        handler=_handle_publish, description=SCHEMA["description"],
    )
    ctx.register_hook("pre_llm_call", before_turn)
    ctx.register_hook("pre_tool_call", before_tool)
    ctx.register_hook("post_tool_call", after_tool)
    ctx.register_hook("post_llm_call", after_turn)
