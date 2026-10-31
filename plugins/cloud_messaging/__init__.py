"""Cloud messaging execution and standalone notification adapters, using existing plugin seams."""
from functools import partial


def register(ctx):
    from hermes_cli.config import read_user_config_raw
    from hermes_constants import get_hermes_home
    from .notifications import PLATFORMS, send_notification
    cfg = read_user_config_raw()
    settings = cfg.get('cloud_messaging', {})
    delivery = cfg.get('cloud_messaging_delivery', {}).get('enabled')
    if not settings.get('enabled') and not delivery: return
    home = get_hermes_home()
    from .adapter import CloudMessagingAdapter
    names = PLATFORMS if delivery else {settings.get('platform', 'uniagentgate'): PLATFORMS[settings.get('platform', 'uniagentgate')]}
    for name, label in names.items():
        ctx.register_platform(name=name, label=label,
            adapter_factory=lambda config: CloudMessagingAdapter(config, settings, home),
            check_fn=lambda: True, validate_config=lambda config: bool(delivery or settings.get('upgrade_secret')),
            standalone_sender_fn=partial(send_notification, name), standalone_sender_override=bool(delivery),
            cron_deliver_env_var=name.upper()+'_HOME_CHANNEL', pii_safe=True,
            platform_hint='Reply with one final message. Attach generated local files using MEDIA:/absolute/path. This IM session has no browser MaaS or Drive authorization.')
