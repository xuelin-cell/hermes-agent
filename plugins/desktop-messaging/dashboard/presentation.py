"""为当前受管 Profile 准备展示配置，不触碰凭据、收件人和执行规则。"""

from hermes_cli.config import (
    atomic_config_write,
    get_config_path,
    require_readable_config_before_write,
)

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


def _section(parent: dict, key: str) -> dict:
    """只接受合法配置节，避免用默认值覆盖损坏的用户配置。"""
    if key not in parent or parent[key] is None:
        parent[key] = {}
    if not isinstance(parent[key], dict):
        raise ValueError(f"消息展示配置节 {key} 必须是对象")
    return parent[key]


def prepare_presentation(platforms: set[str], *, host_only: bool = False) -> bool:
    """原子补写本 Profile 展示；宿主模式只关闭托管渠道广播，不启用渠道。"""
    targets = platforms & PLATFORMS
    if not targets:
        return False
    path = get_config_path()
    config = require_readable_config_before_write(path)
    # YAML 别名可能令修改一节连带改变另一平台，拒绝这类歧义配置。
    seen: set[int] = set()

    def check_aliases(value):
        """在修改前拒绝共享或递归容器，防止跨平台写入。"""
        if isinstance(value, (dict, list)):
            if id(value) in seen:
                raise ValueError("消息展示配置不能含共享或递归的 YAML 别名")
            seen.add(id(value))
            for child in value.values() if isinstance(value, dict) else value:
                check_aliases(child)

    check_aliases(config)
    from copy import deepcopy

    original = deepcopy(config)
    if not host_only:
        display = _section(config, "display")
        display["language"] = "zh"
        overrides = _section(display, "platforms")
    channels = _section(config, "platforms")
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
        if platform != "weixin":
            # 这三类适配器的专用通知接口默认仍发回原会话；不改变正常消息路由。
            channel["notice_delivery"] = extra["notice_delivery"] = "private"
    if config == original:
        return False
    atomic_config_write(path, config)
    return True
