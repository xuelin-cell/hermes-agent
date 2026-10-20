"""UniWork distribution platform; installed into the owning account's plugin tree."""


def register(ctx):
    from .adapter import UniAgentGateAdapter, check_requirements, validate_config
    from .control import ReconnectControl
    from hermes_constants import get_hermes_home

    control = ReconnectControl(get_hermes_home())
    ctx.on_unload(control.close)

    def create_adapter(config):
        """控制服务只在真实网关 connect 时启动，配置探测不产生进程或连接。"""
        adapter = UniAgentGateAdapter(config)
        adapter._control = control
        return adapter

    ctx.register_platform(
        name="uniagentgate",
        label="5G 消息",
        adapter_factory=create_adapter,
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=validate_config,
        required_env=["UNIAGENTGATE_AGENT_SK"],
        pii_safe=True,
        platform_hint=("You are replying by 5G RCS message. Keep the final answer concise. Preserve URLs. "
                       "To deliver generated files, include MEDIA:/absolute/path in the final reply. "
                       "Text and files are delivered together after the turn finishes."),
    )
