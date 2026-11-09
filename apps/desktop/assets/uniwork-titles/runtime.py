"""产品标题扩展：只观察原生钩子，独立队列保存任务，原生数据库保存唯一标题。"""
import json
import logging
import unicodedata
from contextlib import contextmanager
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
import urllib.request

NAME = "uniwork-titles"
_log = logging.getLogger("uniwork.titles")
_lock = threading.Lock()
_workers = set()


def clean(value, limit=24):
    """清理控制字符并按字素截断，保留组合emoji和中文长度。"""
    text = re.sub(r"[\x00-\x1f\x7f-\x9f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069]", " ", str(value or ""))
    text = re.sub(r"\s+", " ", text).strip()
    units = []
    for char in text:
        # Unicode组合符、变体选择符、肤色和ZWJ序列作为一个可见字符。
        continuation = unicodedata.combining(char) or char in "\ufe0f\ufe0e\u200d" or "\U0001f3fb" <= char <= "\U0001f3ff"
        paired_flag = units and len(units[-1]) == 1 and "\U0001f1e6" <= units[-1] <= "\U0001f1ff" and "\U0001f1e6" <= char <= "\U0001f1ff"
        if units and (continuation or units[-1].endswith("\u200d") or paired_flag):
            units[-1] += char
        else:
            units.append(char)
    return text if len(units) <= limit else "".join(units[:limit - 1]) + "…"


@contextmanager
def state(home):
    """每个账号/Profile使用自己的持久任务库，跨进程领取由SQLite事务保护。"""
    directory = Path(home) / "plugin-data" / NAME
    for path in [directory.parent, directory, directory / "jobs.db"]:
        if path.is_symlink():
            raise ValueError("invalid title state")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    db = sqlite3.connect(directory / "jobs.db", timeout=2)
    db.row_factory = sqlite3.Row
    db.execute("CREATE TABLE IF NOT EXISTS jobs (root TEXT PRIMARY KEY, intent TEXT NOT NULL, material TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, checks INTEGER NOT NULL DEFAULT 0, due REAL NOT NULL, lease REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending')")
    db.execute("CREATE TABLE IF NOT EXISTS starts (root TEXT PRIMARY KEY)")
    try:
        with db:
            yield db
    finally:
        db.close()


def session(home, sid):
    """只打开已经持久化的原生会话，按压缩谱系找到当前tip，不制造空会话。"""
    from hermes_state import SessionDB
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", str(sid)) or not (Path(home) / "state.db").is_file():
        return None
    db = SessionDB(db_path=Path(home) / "state.db")
    ids = db.get_compression_lineage(sid)
    row = db.get_session(ids[-1]) if ids else None
    if not row or row.get("source") in {"cron", "subagent"} or row.get("hidden") or row.get("archived"):
        db.close()
        return None
    return db, ids, row


def publish(home, ids, row):
    """落盘后发提示事件；内容以重新读出的原生标题为准，不传模型Key或内部路径。"""
    from hermes_cli.plugin_events import broadcast_plugin_event
    broadcast_plugin_event(NAME, "changed", {"session_id": ids[-1], "ids": ids, "title": row.get("title"),
        "profile": Path(home).name if Path(home).parent.name == "profiles" else "default"})


def write_title(db, ids, title, source):
    """复用原生CAS保证手动优先及一次正式命名；正式标题及冲突后缀最多16字符，临时展示保留24字符。"""
    limit = 16 if source == "llm" else 24
    for index in range(1, 101):
        suffix = "" if index == 1 else " #" + str(index)
        candidate = clean(title, limit - len(suffix)) + suffix
        try:
            return db.set_auto_title(ids[-1], candidate, source=source)
        except ValueError as error:
            if "already in use" not in str(error):
                raise
    return False


def seed(home, sid, temporary, intent="", *, first=False, from_ui=False):
    """创建或补充首轮命名任务；既有正式、手动及业务固定标题保持不变。"""
    found = session(home, sid)
    if not found:
        return False
    db, ids, row = found
    try:
        with state(home) as jobs:
            existing = jobs.execute("SELECT * FROM jobs WHERE root=?", (ids[0],)).fetchone()
            if row.get("title") and db.get_session_title_source(ids[-1]) != "derived":
                return False
            if not existing and not first:
                # 请求只认首次用户消息，不能借刷新批量命名旧会话。
                messages = db.get_messages(ids[0], limit=512)
                if len(messages) >= 512 or sum(message.get("role") == "user" for message in messages) != 1:
                    return False
            temporary = clean(temporary) or "新会话"
            changed = write_title(db, ids, temporary, "derived")
            text = str(intent or "").strip()[:1800]
            jobs.execute("INSERT OR IGNORE INTO jobs(root,intent,due) VALUES(?,?,?)", (ids[0], text, time.time() + .5))
            if existing and from_ui and text and (not existing["intent"] or existing["status"] == "waiting") and existing["attempts"] < 3:
                jobs.execute("UPDATE jobs SET intent=?,status='pending',due=? WHERE root=? AND status!='done'", (text, time.time() + .5, ids[0]))
        if changed:
            publish(home, ids, db.get_session(ids[-1]))
    finally:
        db.close()
    kick(home)
    return True


def text_of(value, limit=2400):
    """只提取现有结果中的文字；不读取图片、重新OCR或发送完整工具历史。"""
    if isinstance(value, str):
        return value[:limit]
    if isinstance(value, list):
        return "\n".join(text_of(part, limit) for part in value[:12])[:limit]
    if isinstance(value, dict):
        if value.get("type") in {"image", "image_url", "input_image"}:
            return ""
        return "\n".join(text_of(value[key], limit) for key in ("text", "content", "description", "result", "output") if key in value)[:limit]
    return ""


def parsed_input(message):
    """剥离附件路径和默认看图提问；文件名只能做临时展示，不能冒充材料主题。"""
    text = text_of(message, 5000)
    names = []
    def attached(match):
        """保留附件basename用于临时标题，不向标题模型传递完整本机路径。"""
        names.append(match.group(1).replace("\\", "/").split("/")[-1])
        return ""
    text = re.sub(r"\[(?:user attached file|attached file|image attached):\s*([^\]]+)\]", attached, text, flags=re.I)
    # 使用已有纯输入清理能力；此函数不调用辅助模型。
    from agent.title_generator import build_title_input
    for match in re.finditer(r"@(?:file|image):(?:`([^`]+)`|\"([^\"]+)\"|'([^']+)'|(\S+))", text):
        names.append(next(value for value in match.groups() if value).replace("\\", "/").split("/")[-1])
    text = build_title_input(text).strip()
    if text == "What do you see in this image?":
        text = ""
    temporary = text or (names[0] + (f" 等{len(names)}个文件" if len(names) > 1 else "") if names else "新会话")
    return temporary, text


def before(*, session_id="", user_message=None, is_first_turn=False, platform="", **kwargs):
    """异步观察首轮，绝不改写主请求正文、系统提示、历史或缓存。"""
    if not session_id or platform == "subagent":
        return
    from hermes_constants import get_hermes_home
    home = Path(get_hermes_home())
    temporary, intent = parsed_input(user_message)
    found = session(home, session_id)
    if found:
        db, ids, _ = found
        try:
            messages = db.get_messages(ids[0], limit=8)
            first_user = next((row for row in messages if row.get("role") == "user"), {})
            preview = (first_user.get("display_metadata") or {}).get("title_preview")
            if isinstance(preview, str) and preview.strip():
                temporary = intent or preview
                intent = (intent + "\n" + preview).strip()[:1800]
        finally:
            db.close()
    # 桌面在提交成功后立即送来原始文本/附件名；钩子稍后兜底，避开自动txt文件名抢占。
    from agent.memory_provider import spawn_context_thread
    def observe():
        """首轮交给提交元数据先命名；仍不等待回答完成。"""
        time.sleep(.8 if platform == "desktop" else .5)
        seed(home, session_id, temporary, intent, first=is_first_turn)
    if platform == "desktop":
        spawn_context_thread(observe, name="uniwork-title-seed").start()
    else:
        # 消息入口/CLI可能随首答结束退出，先持久化元数据，不等待桌面模型服务。
        seed(home, session_id, temporary, intent, first=is_first_turn)


def material(home, sid, value, *, from_response=False):
    """只给尚未获得充分主题的任务补充已读取材料，正式标题不再变动。"""
    found = session(home, sid)
    if not found:
        return
    db, ids, row = found
    db.close()
    text = text_of(value).strip()
    if not text:
        return
    with state(home) as jobs:
        existing = jobs.execute("SELECT * FROM jobs WHERE root=?", (ids[0],)).fetchone()
        if from_response and existing and re.fullmatch(r"(?:你好|您好|谢谢|好的|hi|hello|ok|thanks)[!！。.?？\s]*", existing["intent"].strip(), re.I):
            return
        # 极快的看图/工具结果可能早于首轮异步seed，先保存证据，后续seed补临时名。
        if not jobs.execute("SELECT 1 FROM jobs WHERE root=?", (ids[0],)).fetchone():
            found = session(home, sid)
            if not found:
                return
            check, _, current = found
            try:
                if current.get("title") or sum(m.get("role") == "user" for m in check.get_messages(ids[0])) != 1:
                    return
            finally:
                check.close()
            jobs.execute("INSERT OR IGNORE INTO jobs(root,intent,due) VALUES(?,?,?)", (ids[0], "", time.time() + 1))
        updated = jobs.execute("UPDATE jobs SET material=?,status='pending',due=? WHERE root=? AND status!='done' AND attempts<3 AND material=''", (text, time.time() + .5, ids[0]))
    if updated.rowcount:
        _log.info("material_ready session=%s source=%s chars=%d", sid, "response" if from_response else "tool", len(text))
    kick(home)


def attachment_terminal_text(home, sid, args, result):
    """仅复用明确引用本会话附件的读取结果，不执行命令或额外读取附件。"""
    command = args.get("command", "") if isinstance(args, dict) else ""
    # 只识别已有的读取命令；不把ls、安装依赖、下载或任意终端输出视为材料。
    if not re.search(r"\b(?:cat|head|tail|pdftotext)\s|\b(?:open|read_csv|read_excel|load_workbook)\s*\(", command):
        return ""
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except (ValueError, TypeError):
            return ""
    if not isinstance(result, dict) or result.get("exit_code") != 0 or result.get("error"):
        return ""
    found = session(home, sid)
    if not found:
        return ""
    db, ids, _ = found
    try:
        first = next((m for m in db.get_messages(ids[0], limit=8) if m.get("role") == "user"), {})
        text = text_of(first.get("content"), 10000)
    finally:
        db.close()
    paths = [next(part for part in match if part) for match in re.findall(r"@(?:file|image):(?:`([^`]+)`|\"([^\"]+)\"|'([^']+)'|(\S+))", text)]
    if not any(re.search(r"(?<![\w/])" + re.escape(candidate) + r"(?=$|[\s\'\"`])", command)
               for path in paths for candidate in (path, path.encode("unicode_escape").decode("ascii"))):
        return ""
    output = text_of(result.get("output")).strip()
    for path in paths:
        output = output.replace(path, "<附件>")
    return output


def after_tool(*, session_id="", tool_name="", args=None, result=None, status="", **kwargs):
    """观察读文件、视觉及明确附件读取结果，不改变工具执行或主消息。"""
    if not session_id or status not in {"ok", "success"}:
        return
    from hermes_constants import get_hermes_home
    if tool_name == "terminal":
        home = Path(get_hermes_home())
        material(home, session_id, attachment_terminal_text(home, session_id, args, result))
        return
    known_image_reader = tool_name in {"mcp__UniAI_Toolkit__analyze_image", "mcp__yuanjing__analyze_image", "mcp__1__analyze_image"}
    if not known_image_reader and not re.search(r"read_file|file_read|document.*(?:read|parse)|(?:image|vision).*(?:understand|recogn|analy|describ)|read_image", tool_name, re.I):
        return
    from hermes_constants import get_hermes_home
    material(Path(get_hermes_home()), session_id, result)


def after(*, session_id="", assistant_response=None, **kwargs):
    """纯图片由主模型直接看图时，复用已完成的描述，不追加视觉识别请求。"""
    if not session_id:
        return
    from hermes_constants import get_hermes_home
    material(Path(get_hermes_home()), session_id, assistant_response, from_response=True)


def api_started(*, session_id="", **kwargs):
    """主请求即将进入网络后才放行标题；读取已有模型事件，不改请求参数。"""
    if not session_id:
        return
    from hermes_constants import get_hermes_home
    home = Path(get_hermes_home())
    found = session(home, session_id)
    if not found:
        return
    db, ids, _ = found
    db.close()
    with state(home) as jobs:
        jobs.execute("INSERT OR IGNORE INTO starts(root) VALUES(?)", (ids[0],))
    kick(home)


def call_model(intent, content):
    """只调用主进程提供的本机数字员工桥，不读任何Hermes模型配置或密钥。"""
    from urllib.parse import urlparse
    url = os.environ.get("UNIWORK_TITLE_BRIDGE", "")
    token = os.environ.get("UNIWORK_TITLE_TOKEN", "")
    parsed = urlparse(url)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.path != "/title" or not token:
        return {"status": "unavailable", "reason": "bridge_unavailable", "attempted": False}
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        """拒绝重定向，短期桥凭证不能离开本机端点。"""
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    request = urllib.request.Request(url, data=json.dumps({"intent": intent, "material": content}).encode(),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"}, method="POST")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=10) as response:
        return json.loads(response.read(4096))


def run_one(home, model=call_model):
    """领取一项持久任务，网络在事务外；保存前重新核验原生标题和压缩tip。"""
    now = time.time()
    sent_material = ""
    with state(home) as jobs:
        jobs.execute("BEGIN IMMEDIATE")
        job = jobs.execute("SELECT jobs.* FROM jobs JOIN starts ON starts.root=jobs.root WHERE status='pending' AND due<=? AND lease<=? AND attempts<3 AND checks<12 ORDER BY due LIMIT 1", (now, now)).fetchone()
        if not job:
            return False
        jobs.execute("UPDATE jobs SET lease=?,checks=checks+1 WHERE root=?", (now + 20, job["root"]))
    found = session(home, job["root"])
    if not found:
        result = {"status": "unavailable"}
    else:
        db, ids, row = found
        final = bool(row.get("title")) and db.get_session_title_source(ids[-1]) != "derived"
        db.close()
        if final:
            result = {"status": "done"}
        elif (not job["intent"].strip() or re.fullmatch(r"(?:你好|您好|谢谢|好的|hi|hello|ok|thanks)[!！。.?？\s]*", job["intent"].strip(), re.I)) and not job["material"].strip():
            result = {"status": "insufficient", "reason": "missing_material", "attempted": False}
        else:
            try:
                # 有明确意图时先只发送短问题；纯材料或前次不足才附已读取的有限摘要。
                generic = not job["intent"].strip() or re.fullmatch(r"(?:(?:请|帮我|帮忙|麻烦|一下|这|这些|这个|份|张|个|的|文件|附件|图片|图|内容|文档|材料|总结|分析|看看|查看|识别|解读|处理|比较|对比|翻译|提取|概括)|[\s，。！？,.!?])+", job["intent"].strip())
                sent_material = job["material"] if generic or job["attempts"] > 0 else ""
                result = model(job["intent"], sent_material)
            except Exception:
                result = {"status": "deferred", "reason": "bridge_error", "retryAfter": 10, "attempted": True}
    status = result.get("status", "unavailable")
    attempts = int(result.get("attempted", status in {"ready", "unavailable", "insufficient"}))
    if status == "ready":
        found = session(home, job["root"])
        if found:
            db, ids, row = found
            try:
                title = str(result.get("title") or "").strip()
                if title and title != "NONE":
                    write_title(db, ids, title, "llm")
                    publish(home, ids, db.get_session(ids[-1]))
            finally:
                db.close()
        status = "done"
    next_status = "pending" if status == "deferred" else "waiting" if status == "insufficient" else "done"
    with state(home) as jobs:
        # 真缺材料才等待；已有材料但未形成有效标题，沿用原有预算重试。
        if next_status == "waiting":
            updated = jobs.execute("SELECT intent,material FROM jobs WHERE root=?", (job["root"],)).fetchone()
            if updated and (updated["intent"] != job["intent"] or updated["material"]):
                next_status = "pending"
        exhausted = job["attempts"] + attempts >= 3 or job["checks"] + 1 >= 12
        if next_status == "pending" and exhausted:
            next_status = "done"
        jobs.execute("UPDATE jobs SET lease=0,status=?,attempts=attempts+?,due=? WHERE root=?", (next_status, attempts, time.time() + max(2, min(60, result.get("retryAfter", 2))), job["root"]))
        if next_status == "done":
            jobs.execute("UPDATE jobs SET intent='',material='' WHERE root=?", (job["root"],))
    _log.info("title_result session=%s result=%s reason=%s state=%s attempts=%d checks=%d exhausted=%s elapsed_ms=%d",
        job["root"], result.get("status", status), result.get("reason", result.get("status", status)), next_status, job["attempts"] + attempts,
        job["checks"] + 1, exhausted, int((time.time() - now) * 1000))
    return True


def recover_missing(home):
    """补齐消息已保存但标题任务尚未保存的崩溃窗口；只处理启用新版后创建的无标题会话。"""
    marker = Path(home) / "plugin-data" / NAME / "enabled-at"
    if marker.is_symlink() or not marker.is_file() or not (Path(home) / "state.db").is_file():
        return
    try:
        enabled_at = float(marker.read_text())
    except (ValueError, OSError):
        return
    from hermes_state import SessionDB
    db = SessionDB(db_path=Path(home) / "state.db")
    try:
        offset = 0
        while True:
            rows = db.list_sessions_rich(limit=100, offset=offset, min_message_count=1, project_compression_tips=False)
            for row in rows:
                if row.get("title") or row.get("started_at", 0) < enabled_at:
                    continue
                found = session(home, row["id"])
                if not found:
                    continue
                check, ids, _ = found
                try:
                    first = next((message for message in check.get_messages(ids[0], limit=8) if message.get("role") == "user"), None)
                    if not first or first.get("display_kind") == "hidden":
                        continue
                    temporary, intent = parsed_input(first.get("content", ""))
                    preview = (first.get("display_metadata") or {}).get("title_preview")
                    if isinstance(preview, str) and preview.strip():
                        temporary = intent or preview
                        intent = (intent + "\n" + preview).strip()[:1800]
                    seed(home, ids[0], temporary, intent)
                finally:
                    check.close()
            if not rows or len(rows) < 100 or min(row.get("started_at", 0) for row in rows) < enabled_at:
                break
            offset += len(rows)
    finally:
        db.close()


@contextmanager
def title_scope(home):
    """后台只读取指定Profile元数据，显式空密钥范围阻止意外继承其它Profile的模型资源。"""
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from agent.secret_scope import set_secret_scope, reset_secret_scope
    home_token = set_hermes_home_override(home)
    secret_token = set_secret_scope({}, profile_home=str(home))
    try:
        yield
    finally:
        reset_secret_scope(secret_token)
        reset_hermes_home_override(home_token)


def recover_waiting(home):
    """升级后只恢复已存材料且预算未耗尽的旧等待任务，不清零次数或重读文件。"""
    with state(home) as jobs:
        changed = jobs.execute("UPDATE jobs SET status='pending' WHERE status='waiting' AND material!='' AND attempts<3 AND checks<12").rowcount
    if changed:
        _log.info("resume_material_ready count=%d", changed)


def kick(home):
    """每个Profile最多两个后台任务，复用SQLite领取避免重复命名；桌面统一限制网络并发。"""
    home = Path(home).resolve()
    if not os.environ.get("UNIWORK_TITLE_BRIDGE"):
        return
    with _lock:
        slots = [(home, index) for index in range(2) if (home, index) not in _workers]
        if not slots:
            return
        _workers.update(slots)
    from agent.memory_provider import spawn_context_thread
    def work_unscoped(slot):
        """有待处理任务才轮询；异常只影响标题，主回答不等待本线程。"""
        normal_exit = False
        try:
            if slot[1] == 0:
                recover_missing(home)
                recover_waiting(home)
            while True:
                run_one(home)
                with state(home) as jobs:
                    pending = jobs.execute("SELECT MIN(MAX(due,lease)) FROM jobs JOIN starts ON starts.root=jobs.root WHERE status='pending' AND attempts<3 AND checks<12").fetchone()[0]
                if pending is None:
                    normal_exit = True
                    break
                time.sleep(min(2, max(.2, pending - time.time())))
        finally:
            with _lock:
                _workers.discard(slot)
            if normal_exit:
                with state(home) as jobs:
                    pending = jobs.execute("SELECT 1 FROM jobs JOIN starts ON starts.root=jobs.root WHERE status='pending' AND attempts<3 AND checks<12 LIMIT 1").fetchone()
                if pending:
                    kick(home)
    def work(slot):
        """每个并行线程显式绑定自己的Profile，不继承启动Profile的数据范围。"""
        with title_scope(home):
            work_unscoped(slot)
    for slot in slots:
        spawn_context_thread(work, args=(slot,), name="uniwork-titles").start()


def resume_pending(home):
    """桌面启动恢复当前账号已启用Profile的持久待办；不遍历其它账号、不重置重试预算。"""
    home = Path(home).resolve()
    kick(home)
    directory = home / "profiles"
    if directory.is_symlink() or not directory.is_dir():
        return
    from ruamel.yaml import YAML, YAMLError
    yaml = YAML(typ="safe")
    yaml.version = (1, 1)
    for candidate in directory.iterdir():
        if candidate.is_symlink() or not candidate.is_dir():
            continue
        config = candidate / "config.yaml"
        queued = candidate / "plugin-data" / NAME / "jobs.db"
        if config.is_symlink() or not config.is_file() or queued.is_symlink():
            continue
        if not queued.is_file() and not (candidate / "plugin-data" / NAME / "enabled-at").is_file():
            continue
        try:
            value = yaml.load(config.read_text()) or {}
            plugins = value.get("plugins", {})
            if NAME in plugins.get("enabled", []) and NAME not in plugins.get("disabled", []):
                kick(candidate)
        except (ValueError, OSError, TypeError, AttributeError, YAMLError):
            continue
