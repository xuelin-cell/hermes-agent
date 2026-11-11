"""PPT diagnostics in the owning profile's existing log stream."""
from contextvars import ContextVar
import json
import logging
from pathlib import Path

context = ContextVar("native_ppt_context", default={})
logger = logging.getLogger(__name__)


def get_log_context_fields():
    return {"turn_id": "", **context.get()}


def emit(event, **fields):
    logger.info("[native-ppt] %s", json.dumps({"event": event, **context.get(), **fields}, ensure_ascii=False))


def file_ref(path):
    return Path(path).name


def safe_text(value):
    return str(value)[-3500:]
