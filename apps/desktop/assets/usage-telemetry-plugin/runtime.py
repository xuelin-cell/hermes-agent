"""Thread-safe, bounded observation ingress and profile-scoped background workers."""

from copy import deepcopy
from datetime import datetime
import hashlib
import json
import logging
import os
from queue import Empty, Full, Queue
import threading
import time
from uuid import uuid4

from .bridge_client import bridge_error, call_bridge, transport
from .catalog import Catalog
from .collector import Collector
from .journal import TurnJournal
from .outbox import Outbox, Sender
from .protocol import encode, field, normalized_tokens, raw_tokens, resource, text, timestamp

logger = logging.getLogger("uniwork.telemetry")
NAME = "uniwork-telemetry"
IDS = ("session_id", "turn_id", "task_id", "tool_call_id", "platform", "model", "provider", "base_url", "api_mode")


def managed_credential():
    from agent.secret_scope import get_secret

    value = get_secret("DESKTOP_MT_MAAS_API_KEY")
    return hashlib.sha256(value.encode()).hexdigest() if value else None


def business_error(value, depth=0):
    if depth > 4:
        return False
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return False
    if not isinstance(value, dict):
        return False
    if value.get("error") or value.get("isError") is True or value.get("success") is False:
        return True
    if isinstance(value.get("status"), str) and value["status"] in {"error", "failed", "cancelled", "rejected"}:
        return True
    for block in value.get("content", []) if isinstance(value.get("content"), list) else []:
        if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
            try:
                if business_error(json.loads(block["text"]), depth + 1):
                    return True
            except ValueError:
                continue
    return any(business_error(value.get(key), depth + 1) for key in ("result", "data", "structuredContent"))


def tool_snapshot(payload):
    """Inspect locally; retain no arguments, output content, file body or credentials."""
    name, args, result = payload.get("tool_name", ""), payload.get("args") or {}, payload.get("result")
    parsed = result if isinstance(result, dict) else {}
    if isinstance(result, str):
        if len(result) > 262144:
            return {"tool_name": name, "success": False}
        try:
            parsed = json.loads(result)
        except ValueError:
            parsed = {}
    if not isinstance(parsed, dict):
        parsed = {}
    observation = {"tool_name": name, "success": payload.get("status") == "ok" and not business_error(parsed)}
    if name == "skill_view":
        observation.update(
            body_loaded=parsed.get("success") is True and isinstance(parsed.get("content"), str)
                        and bool(parsed.get("skill_dir")) and not args.get("file_path"),
            skill_name=parsed.get("name") or args.get("name"), skill_dir=parsed.get("skill_dir"),
        )
    return observation


class Runtime:
    def __init__(self, ctx):
        from hermes_constants import get_hermes_home

        self.ctx, self.home = ctx, get_hermes_home()
        self.enabled = ctx.get_config("enabled", True) is not False
        self.queue = Queue(maxsize=1000)
        self.stop_event, self.wake, self.ready = threading.Event(), threading.Event(), threading.Event()
        self.context = deepcopy(getattr(transport, "initial", {}))
        self.account = self.context.get("account")
        self.dropped = 0
        self.generation = 0
        self.counts, self.delivery = {}, None
        self.context_error = self.input_error = None
        self.collector = Collector(Catalog(self.home), self.persist)
        self.writer_box = None
        self.threads = []
        if self.account:
            from agent.memory_provider import spawn_context_thread

            self.threads = [spawn_context_thread(self.write_loop, name="uniwork-usage-writer"),
                            spawn_context_thread(self.send_loop, name="uniwork-usage-sender")]
            for thread in self.threads:
                thread.start()

    def put(self, kind, payload, **extra):
        if not self.enabled or not self.account or self.stop_event.is_set():
            return
        from hermes_constants import get_hermes_home

        # A plugin instance belongs to one profile even in a multiplexed process.
        if get_hermes_home() != self.home:
            return
        observation = {k: payload[k] for k in IDS if k in payload and isinstance(payload[k], str)}
        observation.update(extra, mono=time.monotonic(), time=timestamp(), generation=self.generation)
        if kind == "start":
            observation.update(observed_at=time.time(), writer_pid=os.getpid())
        try:
            self.queue.put_nowait((kind, observation))
        except Full:
            self.dropped += 1
            self.generation += 1  # Incomplete observations must not become a claimed complete turn.
            if self.dropped == 1 or self.dropped % 100 == 0:
                logger.warning("Observation queue full; dropped=%d", self.dropped)

    def persist(self, receipt, events):
        if self.enabled and self.writer_box and events:
            self.writer_box.write(receipt, events)

    def write_loop(self):
        from plugins.plugin_storage import plugin_db

        db = None
        try:
            db = plugin_db(NAME)
            self.writer_box = Outbox(db, self.account, self.context.get("client", {}))
            journal = TurnJournal(db, self.account)
            self.collector = Collector(Catalog(self.home), self.persist, self.writer_box.session_for, journal)
            self.ready.set()
            written = 0
            generation = self.generation
            while not self.stop_event.is_set() or not self.queue.empty():
                try:
                    kind, observation = self.queue.get(timeout=0.2)
                except Empty:
                    continue
                try:
                    if self.enabled and observation["generation"] == self.generation:
                        if generation != self.generation:
                            self.collector = Collector(Catalog(self.home), self.persist, self.writer_box.session_for, journal)
                            generation = self.generation
                        if kind == "start" and observation.get("request_hash") and not observation.get("parent_session_id"):
                            try:
                                value = call_bridge("/input", self.home, encode({
                                    "requestHash": observation["request_hash"], "turnId": observation.get("turn_id"),
                                    "sessionId": observation.get("session_id"), "taskId": observation.get("task_id"),
                                    "observedAt": observation["observed_at"], "writerPid": observation["writer_pid"]
                                }).encode("utf-8"))
                                observation["request_kind"] = value.get("requestKind")
                                observation["resume_from"] = value.get("resumeFrom")
                                observation["execution_id"] = value.get("executionId")
                                observation["input"] = value.get("userInput") if value.get("requestKind") == "user" else None
                                observation["submission_id"] = value.get("submissionId")
                                self.input_error = None
                                if "submissionId" not in value:
                                    self.collector.gaps["input_correlation_unavailable"] += 1
                            except Exception as error:
                                self.input_error = bridge_error("/input", error)
                                self.collector.gaps["input_correlation_unavailable"] += 1
                        self.collector.observe(kind, observation)
                        self.counts = self.writer_box.status()
                        if kind == "tag":
                            self.wake.set()
                        written += 1
                        if written >= 50:
                            written = 0
                            self.writer_box.prune()
                            journal.prune()
                            self.wake.set()
                except Exception as error:
                    self.dropped += 1
                    self.generation += 1
                    logger.warning("Observation skipped (%s)", type(error).__name__)
                finally:
                    self.queue.task_done()
        except Exception as error:
            logger.warning("Persistence unavailable (%s)", type(error).__name__)
        finally:
            if db is not None:
                db.close()

    def send_loop(self):
        from plugins.plugin_storage import plugin_db

        while not self.ready.wait(0.2):
            if self.stop_event.is_set():
                return
        db = None
        try:
            db = plugin_db(NAME)
            outbox = Outbox(db, self.account, self.context.get("client", {}))
            sender = Sender(outbox, lambda body, account: call_bridge("/batch", self.home, body, account))
            while not self.stop_event.is_set():
                if self.enabled:
                    try:
                        current = call_bridge("/context", self.home)
                        self.context_error = None
                        if current.get("account") == self.account:
                            self.context = current
                            if sender.send_once(current):
                                self.wake.set()
                        self.counts, self.delivery = outbox.status(), sender.last_code
                    except Exception as error:
                        self.delivery = "bridge_unavailable"
                        self.context_error = bridge_error("/context", error)
                self.wake.wait(60)
                self.wake.clear()
        except Exception as error:
            logger.warning("Sender unavailable (%s)", type(error).__name__)
        finally:
            if db is not None:
                db.close()

    def start(self, **payload):
        if not self.enabled or not self.account:
            return
        # Snapshot before the provider request; later plan refreshes do not alter this turn.
        message = payload.get("user_message")
        if isinstance(message, list):
            texts = [part.get("text") for part in message if isinstance(part, dict) and part.get("type") == "text"]
            message = texts[0] if len(texts) == 1 else None
        request_hash = hashlib.sha256(message.encode("utf-8")).hexdigest() if isinstance(message, str) else None
        self.put("start", payload, request_hash=request_hash,
                 parent_session_id=payload.get("parent_session_id"), models=deepcopy(self.context.get("models", [])))

    def llm(self, request, next_call, **payload):
        if not self.enabled or not self.account:
            return next_call(request)
        try:
            credential = managed_credential()
        except Exception:
            credential = None
        result = None
        try:
            result = next_call(request)
            return result
        finally:
            # An interrupted/failed call without usage makes totals unknown, never a fabricated zero.
            try:
                self.put("usage", payload, attempt=str(uuid4()), credential=credential,
                         tokens=raw_tokens(field(result, "usage"), payload.get("api_mode", "")))
            except Exception as error:
                logger.warning("Usage observation skipped (%s)", type(error).__name__)

    def auxiliary(self, **payload):
        if not self.enabled or not self.account:
            return
        self.put("aux_usage", payload,
                 attempt=str(payload.get("api_request_id", "")) + ":" + str(payload.get("retry_count", 0)),
                 tokens=normalized_tokens(payload.get("usage")), streaming=payload.get("streaming") is True,
                 credential=managed_credential())

    def after_tool(self, **payload):
        if self.enabled and self.account:
            self.put("tool", payload, **tool_snapshot(payload))

    def request(self, **payload):
        if self.enabled and self.account:
            self.put("request", payload, credential=managed_credential())

    def command(self, raw_args=""):
        action, _, payload = raw_args.strip().partition(" ")
        action = action.lower()
        if action == "tag":
            # Desktop calls this only after prompt.submit accepts the request. No Agent turn is needed.
            try:
                value = json.loads(payload)
                tag = value["tag"]
                subject = resource(tag["id"], tag.get("name"))
                occurred_at = value["occurredAt"]
                if (not subject or not text(value["id"], 128) or not text(occurred_at, 40)
                        or datetime.fromisoformat(occurred_at).tzinfo is None):
                    return ""
            except (ValueError, TypeError, KeyError, AttributeError):
                return ""
            self.put("tag", {}, submission_id=value["id"], tag=subject, occurred_at=occurred_at)
            return ""
        if action in {"on", "off"}:
            self.ctx.set_config("enabled", action == "on")
            self.enabled = action == "on"
            self.generation += 1
            self.wake.set()
            return "办公统计已开启（含本轮输入摘要）。" if self.enabled else "办公统计已关闭。"
        if action == "flush":
            self.wake.set()
            return "已请求发送待上报事件；请稍后查看 status。"
        return json.dumps({"enabled": self.enabled, "bridge": bool(self.account), "queue": self.queue.qsize(),
                           "events": self.counts, "delivery": self.delivery, "dropped": self.dropped,
                           "bridgeError": self.context_error or self.input_error,
                           "coverageGaps": dict(self.collector.gaps)}, ensure_ascii=False)

    def close(self):
        self.stop_event.set()
        self.wake.set()
        deadline = time.monotonic() + 0.5
        for thread in self.threads:
            thread.join(max(0, deadline - time.monotonic()))
