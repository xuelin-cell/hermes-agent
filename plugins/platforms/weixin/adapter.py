"""桌面微信展示适配，所有 iLink 协议仍由原版负责。"""

from gateway.platforms._shared import extra_or_secret, get_scoped_secret
from gateway.platforms.weixin import WeixinAdapter, check_weixin_requirements
from plugins.platforms.desktop_presentation import DesktopPresentationMixin


class DesktopWeixinAdapter(DesktopPresentationMixin, WeixinAdapter):
    """连接、鉴权、媒体和 typing 完整沿用原版。"""


def _is_connected(config) -> bool:
    """与原版适配器读取方式一致：token 和账号都存在才算已配置，未扫码的 Profile 不会被自动启用。"""
    extra = getattr(config, "extra", None) or {}
    token = getattr(config, "token", None) or extra.get("token") or get_scoped_secret("WEIXIN_TOKEN", "")
    account = extra_or_secret(extra, "account_id", "WEIXIN_ACCOUNT_ID")
    return bool(str(token or "").strip() and str(account or "").strip())


def register(ctx) -> None:
    """通过正式平台注册接口加载薄适配器，缺依赖时仍使用原版探测结果。"""
    ctx.register_platform(
        name="weixin",
        label="Weixin",
        adapter_factory=DesktopWeixinAdapter,
        check_fn=check_weixin_requirements,
        is_connected=_is_connected,
        validate_config=_is_connected,
        required_env=["WEIXIN_ACCOUNT_ID", "WEIXIN_TOKEN"],
        allowed_users_env="WEIXIN_ALLOWED_USERS",
        allow_all_env="WEIXIN_ALLOW_ALL_USERS",
        cron_deliver_env_var="WEIXIN_HOME_CHANNEL",
        emoji="💬",
    )
