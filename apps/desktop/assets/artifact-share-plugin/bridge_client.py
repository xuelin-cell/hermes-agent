"""向桌面主进程提交来源事实和发布请求，不接触登录 JWT。"""

import json
import os
import sys
import types
from urllib.request import Request, urlopen

# 仅在插件初始化时接收凭证，移出环境后终端子进程不会继承它；独立模块保留热重载状态。
_TRANSPORT = sys.modules.setdefault("_hermes_desktop_share_transport", types.ModuleType("_hermes_desktop_share_transport"))
_ADDRESS = os.environ.pop("HERMES_ARTIFACT_SHARE_BRIDGE", "")
_TOKEN = os.environ.pop("HERMES_ARTIFACT_SHARE_TOKEN", "")
if _ADDRESS and _TOKEN:
    _TRANSPORT.address = _ADDRESS
    _TRANSPORT.token = _TOKEN


def call_bridge(route: str, payload: dict, *, timeout: float = 3) -> dict:
    """通过桌面启动时交付的本机凭证调用固定接口。"""
    from hermes_cli.config import load_config
    if load_config().get("cloud_sharing", {}).get("enabled"):
        from plugins.conversation_share.origins import current
        origins = current()
        if route == "/origin":
            origins.record(payload)
            return {"ok": True}
        if route == "/eligibility":
            return origins.eligibility(payload)
        if route == "/publish":
            from plugins.conversation_share.agent import publish
            return publish(payload, timeout=timeout)
        raise RuntimeError("云端产物请在页面中确认分享。")
    address = getattr(_TRANSPORT, "address", "")
    token = getattr(_TRANSPORT, "token", "")
    if not address.startswith("http://127.0.0.1:") or not token:
        raise RuntimeError("当前会话未连接桌面分享服务。")
    request = Request(
        f"{address}{route}",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urlopen(request, timeout=timeout) as response:
        return json.load(response)
