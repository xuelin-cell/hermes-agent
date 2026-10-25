"""为当前受管 Profile 准备展示配置，不触碰凭据、收件人和执行规则。"""

import logging
import threading
from collections import Counter

from hermes_cli.config import (
    atomic_config_write,
    get_config_path,
    require_readable_config_before_write,
)

_log = logging.getLogger(__name__)

PLATFORMS = frozenset({"weixin", "dingtalk", "feishu", "wecom"})
QUIET_DISPLAY = {
    "tool_progress": "off",
    "show_reasoning": False,
    "thinking_progress": False,
    "interim_assistant_messages": False,
    "long_running_notifications": False,
    "busy_ack_detail": False,
    "busy_steer_ack_enabled": False,
}
# 记录桌面已代为设置过语言；之后用户改成任何语言都不再覆盖。
LANGUAGE_MARKER = "desktop_language_set"
_config_locks: dict[str, threading.RLock] = {}
_config_locks_guard = threading.Lock()


def config_lock() -> threading.RLock:
    """同一 Profile 的 config.yaml 读改写共用一把锁，扫码线程和桌面准备不会互相覆盖。"""
    key = str(get_config_path().resolve())
    with _config_locks_guard:
        return _config_locks.setdefault(key, threading.RLock())


def _section(parent: dict, key: str) -> dict:
    """只接受合法配置节，避免用默认值覆盖损坏的用户配置。"""
    if key not in parent or parent[key] is None:
        parent[key] = {}
    if not isinstance(parent[key], dict):
        raise ValueError(f"消息展示配置节 {key} 必须是对象")
    return parent[key]


def _shares_target_sections(config: dict) -> bool:
    """只有 display／platforms 内的容器被别处共用时才有串写风险，其它节的 YAML 复用不受影响。"""
    counts: Counter = Counter()

    def count(value):
        if isinstance(value, (dict, list)):
            counts[id(value)] += 1
            if counts[id(value)] == 1:
                for child in value.values() if isinstance(value, dict) else value:
                    count(child)

    def shared(value, seen: set) -> bool:
        if not isinstance(value, (dict, list)):
            return False
        if counts[id(value)] > 1 or id(value) in seen:
            return True
        seen.add(id(value))
        return any(shared(child, seen) for child in (value.values() if isinstance(value, dict) else value))

    count(config)
    return any(shared(config.get(key), set()) for key in ("display", "platforms"))


def prepare_presentation(
    platforms: set[str], *, host_only: bool = False, quiet_busy_ack: bool = False
) -> bool:
    """原子补写本 Profile 展示；配置异常只记日志并跳过，不阻断保存和启动。

    宿主模式只关闭托管渠道广播，不启用渠道；纯四平台网关再移除宿主旧的显式忙碌回执开关。
    """
    targets = platforms & PLATFORMS
    if not targets:
        return False
    try:
        with config_lock():
            return _prepare(targets, host_only, quiet_busy_ack)
    except Exception as exc:
        _log.warning("desktop-messaging: 跳过消息展示配置：%s", exc)
        return False


def _prepare(targets: set[str], host_only: bool, quiet_busy_ack: bool) -> bool:
    """在锁内读改写；任何异常交给调用方记录。"""
    path = get_config_path()
    config = require_readable_config_before_write(path)
    if _shares_target_sections(config):
        raise ValueError("消息展示配置不能含共享或递归的 YAML 别名")
    from copy import deepcopy

    original = deepcopy(config)
    channels = _section(config, "platforms")
    if host_only:
        display = config.get("display")
        # 网关会把宿主 display.busy_ack_enabled 覆盖到子进程环境，旧的显式开启会盖过桌面关闭。
        if quiet_busy_ack and isinstance(display, dict) and display.get("busy_ack_enabled"):
            del display["busy_ack_enabled"]
    else:
        display = _section(config, "display")
        overrides = _section(display, "platforms")
        marked = any(
            isinstance(channel, dict)
            and isinstance(channel.get("extra"), dict)
            and channel["extra"].get(LANGUAGE_MARKER) is True
            for channel in channels.values()
        )
        # 默认模板写的是 en；只替换未设置和默认值，用户选的其它语言保留。
        if not marked and display.get("language") in (None, "", "en"):
            display["language"] = "zh"
    for platform in sorted(targets):
        channel = _section(channels, platform)
        channel["gateway_restart_notification"] = False
        if host_only:
            continue
        settings = _section(overrides, platform)
        settings.update(QUIET_DISPLAY)
        _section(settings, "runtime_footer")["enabled"] = False
        extra = _section(channel, "extra")
        extra["desktop_quiet"] = True
        extra[LANGUAGE_MARKER] = True
        if platform != "weixin":
            # 这三类适配器的专用通知接口默认仍发回原会话；不改变正常消息路由。
            channel["notice_delivery"] = extra["notice_delivery"] = "private"
    if config == original:
        return False
    atomic_config_write(path, config)
    return True
