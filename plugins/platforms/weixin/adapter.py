"""桌面微信展示适配，所有 iLink 协议仍由原版负责。"""

from gateway.platforms.weixin import WeixinAdapter, check_weixin_requirements
from plugins.platforms.desktop_presentation import DesktopPresentationMixin


class DesktopWeixinAdapter(DesktopPresentationMixin, WeixinAdapter):
    """连接、鉴权、媒体和 typing 完整沿用原版。"""


def register(ctx) -> None:
    """通过正式平台注册接口加载薄适配器，缺依赖时仍使用原版探测结果。"""
    ctx.register_platform(
        name="weixin",
        label="Weixin",
        adapter_factory=DesktopWeixinAdapter,
        check_fn=check_weixin_requirements,
        required_env=["WEIXIN_ACCOUNT_ID", "WEIXIN_TOKEN"],
        allowed_users_env="WEIXIN_ALLOWED_USERS",
        allow_all_env="WEIXIN_ALLOW_ALL_USERS",
        cron_deliver_env_var="WEIXIN_HOME_CHANNEL",
        emoji="💬",
    )
