"""UniWork 企业管理平台对接插件（云版沙箱镜像自带；docs/企业版对接 24、25、27、28）。

这一步做两件事：
- 会话头：发给平台 ``/v1`` 的模型请求带 ``X-Uniwork-Session``、``X-Uniwork-Turn``（headers.py）；
- 工具调用上报：每次工具调用结束记一条，攒批发给平台（audit.py、outbox.py）。

怎么装、怎么启用（deploy/hermes-mt）：
- Dockerfile.cube 把这个包和 dist-info 放进 hermes venv 的 site-packages，hermes 按 entry point
  （``hermes_agent.plugins`` 组，名字 ``uniwork-enterprise``）发现它；
- 只有 config.yaml 的 ``plugins.enabled`` 里有它的 profile 才加载：入口的平台块（entry/tenants.py
  ``_config_patch_spec``）写进默认 profile 和 Agent 的托管 profile，员工自建的由转发器巡检补上
  （seed/mtent.py ``sync_plugins``）。只在企业模式写；
- 每个 profile 加载时调一次 ``register()``：会话号按这个 profile 的 state.db 查，配置、令牌、发送队列整个实例共用；
- plugin.json（settings.py）没有或关着，插件什么都不做。入口的 ``MT_UNIWORK_PLUGIN=0`` 就是靠它一键停用。

插件里任何异常都吞掉，只记日志，不影响对话和工具。
"""

from __future__ import annotations

import os
import threading
from pathlib import Path

from .audit import make_hook
from .headers import make_middleware
from .outbox import Outbox
from .sessions import ConversationRoots
from .settings import Source, root_of
from .status import Status

PLUGIN_KEY = "uniwork-enterprise"


class Instance:
    """一个实例主目录共用的：配置和令牌、状态文件、发送队列。"""

    def __init__(self, root: Path):
        self.root = Path(root)
        self.source = Source(self.root)
        self.status = Status(self.root)
        self.outbox = Outbox(self.source, status=self.status)


_instances: dict[str, Instance] = {}
_instances_lock = threading.Lock()


def instance_for(root: Path) -> Instance:
    # hermes 给的 profile 目录按 hermes_home_key 规整过（Windows 上会转小写），这里同样规整再当键
    key = os.path.normcase(os.path.abspath(str(root)))
    with _instances_lock:
        found = _instances.get(key)
        if found is None:
            found = _instances[key] = Instance(Path(root))
        return found


def _profile_home(ctx) -> Path:
    """加载插件时 hermes 把当前 profile 的目录设成「当前」（plugins_loader 的 _plugin_home_scope）。"""
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:  # noqa: BLE001
        return Path(ctx._manager.home_path)  # noqa: SLF001


def register(ctx) -> None:
    home = _profile_home(ctx)
    instance = instance_for(root_of(home))
    roots = ConversationRoots(home)
    ctx.register_middleware("llm_execution", make_middleware(instance.source, roots, instance.status))
    ctx.register_hook("post_tool_call", make_hook(instance.source, roots, instance.outbox))
    ctx.register_hook("on_session_end", lambda **_kwargs: instance.outbox.kick())
    instance.status.note_profile(home)
