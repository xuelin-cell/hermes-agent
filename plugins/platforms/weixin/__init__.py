"""复用原版微信协议，仅补充桌面消息展示。"""

from plugins.platforms.weixin.adapter import DesktopWeixinAdapter, register

__all__ = ["DesktopWeixinAdapter", "register"]
