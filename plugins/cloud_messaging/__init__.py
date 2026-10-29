"""Cloud messaging uses the generic relay transport; no direct platform secret enters instances."""


def register(ctx):
    from hermes_cli.config import read_user_config_raw
    from hermes_constants import get_hermes_home
    settings = read_user_config_raw().get('cloud_messaging', {})
    if not settings.get('enabled'): return
    home = get_hermes_home()
    from .adapter import CloudMessagingAdapter
    ctx.register_platform(name=settings.get('platform','uniagentgate'),label={'uniagentgate':'5G 消息','dingtalk':'钉钉','weixin':'微信','wecom':'企业微信','feishu':'飞书'}[settings.get('platform','uniagentgate')],
        adapter_factory=lambda config: CloudMessagingAdapter(config,settings,home),
        check_fn=lambda: True,validate_config=lambda config: bool(settings.get('upgrade_secret')),
        pii_safe=True,platform_hint='Reply with one final message. Attach generated local files using MEDIA:/absolute/path. This IM session has no browser MaaS or Drive authorization.')
