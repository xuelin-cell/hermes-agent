"""Bounded in-process memo scoped by Home, route and credential fingerprint."""

from collections import OrderedDict
from copy import deepcopy
import hashlib
import json
from threading import RLock
import time
from hermes_constants import get_hermes_home

_entries = OrderedDict()
_lock = RLock()


# 缓存身份包含当前Home与路由凭证，避免跨账号复用结果。
def identity(*parts):
    return hashlib.sha256(
        json.dumps(
            [str(get_hermes_home().resolve()), *parts], ensure_ascii=False
        ).encode()
    ).hexdigest()


# 只复用仍在有效期内的独立缓存，并返回副本避免调用方污染。
def get(key, config):
    if not config("cache_enabled", True):
        return None
    with _lock:
        entry = _entries.get(key)
        if entry and entry[0] > time.monotonic():
            _entries.move_to_end(key)
            return deepcopy(entry[1])
        _entries.pop(key, None)
    return None


# 只缓存成功结果，限制有效期与数量以控制常驻内存。
def put(key, value, config):
    if not config("cache_enabled", True) or not value.get("success"):
        return value
    ttl = max(0, min(float(config("cache_ttl_minutes", 5)), 60)) * 60
    with _lock:
        _entries[key] = (time.monotonic() + ttl, deepcopy(value))
        _entries.move_to_end(key)
        while len(_entries) > 128:
            _entries.popitem(last=False)
    return value
