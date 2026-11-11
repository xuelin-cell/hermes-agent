"""Single-writer turn aggregation. All inputs are already whitelisted hook snapshots."""

from collections import Counter, OrderedDict
from contextlib import nullcontext
from dataclasses import dataclass, field

from .protocol import TOKEN_FIELDS, capabilities, completed, event_id, integer


@dataclass
class Turn:
    session: str
    native: str
    started: float
    occurred_at: str
    input_text: str | None
    models: list
    model: dict
    finished: bool = False
    answer: bool = False
    duration_known: bool = True
    pauses: dict = field(default_factory=dict)
    intervals: list = field(default_factory=list)
    usages: dict = field(default_factory=dict)
    seen: set = field(default_factory=set)
    root_id: str = ""
    elapsed_ms: int = 0
    execution_id: str | None = None
    state: str = "running"
    resumed: bool = False
    active_children: set = field(default_factory=set)

    @property
    def logical_id(self):
        return self.root_id or event_id(self.session + ":" + self.native)

    def snapshot(self):
        # Persist business data only, not model credentials, tool results or monotonic clocks.
        fields = ("modelId", "modelName", "provider", "productId", "productName", *TOKEN_FIELDS)
        return {"logical_id": self.logical_id, "session": self.session, "occurred_at": self.occurred_at,
                "input_text": self.input_text, "elapsed_ms": self.elapsed_ms, "duration_known": self.duration_known,
                "model": {key: self.model[key] for key in fields if key in self.model},
                "usages": [{key: row[key] for key in fields if key in row} for row in self.usages.values()]}

    @classmethod
    def restore(cls, snapshot, state, observation, models):
        turn = cls(snapshot["session"], observation["turn_id"], observation["mono"],
                   snapshot["occurred_at"], snapshot["input_text"], models, snapshot["model"],
                   root_id=snapshot["logical_id"], elapsed_ms=snapshot["elapsed_ms"],
                   duration_known=snapshot["duration_known"] and state == "interrupted", resumed=True,
                   execution_id=observation.get("execution_id"))
        turn.usages = {(row.get("provider"), row["modelId"], row.get("productId")): row
                       for row in snapshot["usages"]}
        return turn

    def metadata(self, observation):
        matches = [m for m in self.models if m.get("modelId") == observation.get("model")
                   and m.get("runtimeProvider") == observation.get("provider")
                   and m.get("credential") == observation.get("credential") and bool(observation.get("credential"))
                   and m.get("baseUrl", "").rstrip("/") == (observation.get("base_url") or "").rstrip("/")]
        return matches[0] if len(matches) == 1 else None

    def add_usage(self, observation):
        metadata = self.metadata(observation)
        if not metadata:
            return False
        key = (metadata.get("provider"), metadata["modelId"], metadata.get("productId"))
        row = self.usages.setdefault(key, dict(metadata))
        values = observation.get("tokens", {})
        for name in TOKEN_FIELDS:
            value, previous = values.get(name), row.get(name, 0)
            # Sum confirmed fields only. Missing receipts never erase earlier counts or invent zeros.
            # Keep overflow/legacy unknown totals unknown instead of restarting them from zero.
            if integer(value) and integer(previous):
                total = previous + value
                row[name] = total if integer(total) else None
        return True

    def duration(self, end):
        if not self.duration_known or self.pauses:
            return None
        paused, right = 0.0, self.started
        for begin, finish in sorted(self.intervals):
            begin, finish = max(begin, self.started), min(finish, end)
            paused += max(0.0, finish - max(begin, right))
            right = max(right, finish)
        return self.elapsed_ms + max(0, int((end - self.started - paused) * 1000))


class Collector:
    def __init__(self, catalog, emit, session_for=None, journal=None):
        self.catalog, self.emit = catalog, emit
        self.journal = journal
        self.session_for = session_for or (lambda session, task: session)
        self.turns = OrderedDict()
        self.children = {}
        self.loaded = {}
        self.gaps = Counter()

    def find(self, observation):
        sid, tid = observation.get("session_id"), observation.get("turn_id")
        turn = (self.turns.get((sid, tid)) or self.turns.get(self.children.get(sid))
                or next((turn for (_, native), turn in self.turns.items() if tid and native == tid), None))
        if turn and sid and sid not in self.children and observation.get("task_id"):
            self.session_for(sid, observation["task_id"])
        return turn

    def observe(self, kind, o):
        with self.journal.transaction() if self.journal else nullcontext():
            self._observe(kind, o)

    def _observe(self, kind, o):
        early = {"start": self.start, "child": self.child, "child_end": self.child_end,
                 "skill_loaded": self.skill_loaded, "tag": self.tag}
        if kind in early:
            return early[kind](o)
        turn = self.find(o)
        if turn is None:
            return
        if kind == "tool":
            # Detached children may emit capabilities after the parent reply; never reopen its usage totals.
            self.tool(turn, o)
            if self.journal and not turn.finished:
                self.journal.save(turn)
            return
        if turn.finished:
            return
        if kind == "end" and o.get("turn_id") != turn.native:
            turn.active_children.discard(o.get("session_id"))
            return
        handlers = {"request": self.request, "usage": self.usage, "aux_usage": self.usage,
                    "answer": self.answer, "wait_start": self.wait, "wait_end": self.wait, "end": self.end}
        if handler := handlers.get(kind):
            handler(turn, o, kind)
            if self.journal:
                self.journal.save(turn)

    def tag(self, o):
        receipt = "tag:" + o["submission_id"]
        self.emit(receipt, capabilities(receipt, "", o["occurred_at"], {**o["tag"], "type": "skill_tag"}))

    def child(self, o):
        parent = self.children.get(o.get("parent_session_id")) or (o.get("parent_session_id"), o.get("parent_turn_id"))
        if parent not in self.turns:
            parent = next((key for key in self.turns if key[1] == o.get("parent_turn_id")), parent)
        if parent in self.turns:
            self.children[o.get("child_session_id")] = parent
            self.turns[parent].active_children.add(o.get("child_session_id"))

    def skill_loaded(self, o):
        # Provenance only. The post-tool event proves a full body was returned.
        key = (o.get("task_id"), o.get("skill_name"))
        self.loaded[key] = (o.get("provenance"), o["mono"])
        if len(self.loaded) > 1000:
            self.loaded.clear()

    def child_end(self, o):
        parent = self.turns.get(self.children.get(o.get("child_session_id")))
        if parent:
            parent.active_children.discard(o.get("child_session_id"))

    def request(self, turn, o, kind):
        if o.get("api_mode") == "codex_responses":
            turn.finished = True
            turn.state = "unsupported"
            return
        if o.get("turn_id") == turn.native and not turn.resumed:
            metadata = turn.metadata(o)
            if metadata:
                turn.model = metadata

    def usage(self, turn, o, kind):
        key = (kind, o.get("session_id"), o.get("attempt"))
        if key not in turn.seen:
            turn.seen.add(key)
            if not turn.add_usage(o):
                self.gaps["model_or_plan_unmapped"] += 1
            elif any(not integer(o.get("tokens", {}).get(name)) for name in TOKEN_FIELDS):
                self.gaps["usage_fields_unavailable"] += 1
            if o.get("streaming"):
                self.gaps["auxiliary_stream_usage"] += 1

    def answer(self, turn, o, kind):
        if o.get("turn_id") == turn.native:
            turn.answer = o.get("has_answer", False)

    def wait(self, turn, o, kind):
        if o.get("surface") == "smart":
            return
        key = (o.get("session_id"), o.get("tool_call_id"), o.get("surface"))
        if kind == "wait_start":
            turn.pauses.setdefault(key, o["mono"])
        elif key in turn.pauses:
            turn.intervals.append((turn.pauses.pop(key), o["mono"]))
        else:
            turn.duration_known = False

    def end(self, turn, o, kind):
        if o.get("turn_id") != turn.native:
            return
        turn.finished = True
        if turn.active_children:
            turn.duration_known = False
        duration = turn.duration(o["mono"])
        if duration is None:
            turn.duration_known = False
        else:
            turn.elapsed_ms = duration
        turn.state = "interrupted" if o.get("interrupted") is True else "finished"
        if not (o.get("completed") is True and o.get("failed") is False
                and o.get("interrupted") is False and turn.answer):
            return
        if duration is None:
            self.gaps["unknown_wait_duration"] += 1
            return
        self.emit("completed:" + turn.logical_id,
                  completed("completed:" + turn.logical_id, turn.session, turn.logical_id,
                            turn.occurred_at, duration, turn.model, turn.input_text, turn.usages.values()))

    def start(self, o):
        key = (o.get("session_id"), o.get("turn_id"))
        if not all(key) or key in self.turns or o.get("session_id") in self.children:
            return
        if o.get("platform") != "desktop" or o.get("parent_session_id"):
            return
        session = self.session_for(key[0], o.get("task_id"))
        if not o.get("submission_id"):
            if self.journal:
                self.journal.invalidate(session)
            self.gaps["unbound_desktop_request"] += 1
            return
        request_kind = o.get("request_kind")
        if request_kind not in {"user", "resume"}:
            if self.journal:
                self.journal.invalidate(session)
            self.gaps["hidden_request_skipped" if request_kind == "hidden" else "request_kind_unavailable"] += 1
            return
        if o.get("api_mode") == "codex_responses":
            return
        models = self.catalog.models(o.get("models", []))
        matching = [m for m in models if m.get("modelId") == o.get("model")]
        model = {"modelId": o.get("model"), "modelName": o.get("model")}
        if len(matching) == 1:
            model = matching[0]
        if request_kind == "resume":
            saved = self.journal.resume(session, o.get("resume_from")) if self.journal else None
            if saved is None:
                if self.journal:
                    self.journal.invalidate(session)
                self.gaps["resume_state_unavailable"] += 1
                return
            turn = Turn.restore(saved[1], saved[0], o, models)
            if not turn.duration_known:
                self.gaps["resume_incomplete"] += 1
            self.journal.save(turn)
        else:
            turn = Turn(session, key[1], o["mono"], o["time"], o.get("input"), models, model,
                        execution_id=o.get("execution_id"))
            if self.journal and not self.journal.start(turn):
                return
        self.turns[key] = turn
        if len(self.turns) > 1000:
            old, _ = self.turns.popitem(last=False)
            self.children = {child: parent for child, parent in self.children.items() if parent != old}
        expert = self.catalog.expert()
        if expert:
            receipt = "expert:" + turn.logical_id
            self.emit(receipt, capabilities(receipt, turn.logical_id, o["time"], plugin=expert))

    def tool(self, turn, o):
        if (o.get("session_id") in self.children and o.get("tool_name") in {
                "mcp__UniAI_Toolkit__doc_translate", "mcp__UniAI_Toolkit__ai_podcast_generate",
                "mcp__UniAI_Toolkit__txt2vid_generate", "mcp__UniAI_Toolkit__img2vid_generate"}):
            self.gaps["background_mcp_submission_unavailable"] += 1
            return
        if o.get("tool_name") in {"clarify", "ask_user", "request_user_input"}:
            turn.duration_known = False
        if not o.get("success") or not o.get("tool_call_id"):
            return
        receipt = ":".join(("tool", turn.logical_id, o.get("session_id", ""), o.get("turn_id", ""), o["tool_call_id"]))
        subject = plugin = None
        if o.get("tool_name") == "skill_view" and o.get("body_loaded"):
            name = o.get("skill_name")
            loaded = self.loaded.pop((o.get("task_id"), name), (None, 0))
            provenance = loaded[0] if abs(o["mono"] - loaded[1]) < 60 else None
            subject, plugin = self.catalog.skill(name, o.get("skill_dir"), provenance)
        elif o.get("tool_name", "").startswith("mcp__"):
            subject, plugin = self.catalog.mcp(o["tool_name"])
        if subject or plugin:
            self.emit(receipt, capabilities(receipt, turn.logical_id, o["time"], subject, plugin))
        elif o.get("body_loaded") or o.get("tool_name", "").startswith("mcp__"):
            self.gaps["capability_identity_unknown"] += 1
