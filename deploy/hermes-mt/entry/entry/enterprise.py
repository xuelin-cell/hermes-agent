"""企业模式：把企业管理平台的策略变成「企业资源清单」，交给实例里的转发器安装（docs/企业版对接/19~21）。

平台的 ``/api/client/policy`` 给的是「这个成员能用什么」：Agent（``experts``）、技能、专家包、连接器、
模型（Agent 用到、成员自己看不到的带 ``onlyFor``）和企业经验层（``sharedLayers``）。这里把它整理成
转发器要的清单（格式见 seed/mtent.py 的 apply），经 ``POST /__mt/enterprise`` 送进实例：

- **员工实例**：默认 profile 装全员可见的技能和连接器；每个已发布、成员可见的 Agent 装成一个托管 profile，
  带它自己的技能、专家包、连接器、企业经验和模型（模型调用带 ``X-Uniwork-Agent``，平台据此放行）。
- **平台的运行环境**（svc: 用户，15）：policy 里的东西就是这个运行环境要的，整份装进默认 profile。

什么时候送：
- 策略变了（登录、后台复查、长轮询收到变更）且实例正在跑 —— 马上送；
- 实例拉起或换代以后 —— 送一次（新实例从归档恢复，归档可能比最近一次安装旧）；
- 平台的运行环境每次准备时都送，并等它装完再回 ready。

清单只在入口内存里，不含令牌：设备令牌由转发器从实例自己的 .env 里取。入口重启后，下一次复查会重新算出清单。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from typing import TYPE_CHECKING, Any

import aiohttp

from .uniwork import UNBOUND, UniworkError

if TYPE_CHECKING:
    from .app import Entry
    from .tenants import Tenant

log = logging.getLogger("entry.enterprise")

SPEC_VERSION = 1  # 和 seed/mtent.py 的 SPEC_VERSION 一致
PUSH_TIMEOUT_S = 180  # 第一次装要下载技能包、专家包
EVENTS_WAIT_S = 25  # 长轮询一次等多久（平台上限 55 秒）
RETRY_S = 30  # 送清单失败、或要重启 hermes 但实例在忙：多久以后的请求再试
ERROR_RETRY_S = 120  # 送进去了但有资源没装上（下载失败、包不合法）：多久以后再试


def _rewrite(url: str, announced: str, server: str) -> str:
    """平台在策略里写的是它自己对外宣告的地址；实例要按入口配置的平台地址去连（本机 Docker 里两者不同）。"""
    url = str(url or "")
    if announced and server and url.startswith(announced + "/"):
        return server + url[len(announced):]
    return url


def build_spec(policy: dict, *, server: str, token_env: str, config: dict, service: bool = False,
               plugin: bool = True) -> dict:
    """平台策略 → 转发器的清单。``config`` 是入口给默认 profile 的配置（TenantManager._config_patch_spec），
    Agent 的托管 profile 以它为模板；``service`` 表示平台的运行环境；``plugin`` 是实例里企业对接插件的总开关
    （MT_UNIWORK_PLUGIN），连同平台的工具调用记录开关一起由转发器写进实例的 plugin.json。"""
    info = policy.get("enterprise") if isinstance(policy.get("enterprise"), dict) else {}
    server = server.rstrip("/")
    announced = str(info.get("serverUrl") or "").rstrip("/")

    def items(key: str) -> list[dict]:
        value = policy.get(key)
        return [i for i in value if isinstance(i, dict) and i.get("id")] if isinstance(value, list) else []

    def package(item: dict) -> dict:
        return {"id": str(item.get("id")), "name": str(item.get("name") or ""),
                "displayName": str(item.get("displayName") or item.get("name") or ""),
                "sha256": str(item.get("sha256") or ""), "url": _rewrite(item.get("url"), announced, server)}

    def connector(item: dict) -> dict:
        out = {"id": str(item.get("id")), "name": str(item.get("name") or ""), "url": str(item.get("url") or ""),
               "transport": str(item.get("transport") or ""), "timeout": item.get("timeout")}
        if item.get("relay"):
            out["relay"] = _rewrite(item.get("relay"), announced, server)
        if item.get("auth") == "device":
            # 配了凭证的连接器、企业知识库（27 号第 2、3 节）：地址就在平台上，调用带设备令牌
            out["auth"] = "device"
            out["url"] = _rewrite(item.get("url"), announced, server)
        return out

    def layer(entry: dict) -> dict:
        facts = entry.get("facts") if isinstance(entry.get("facts"), dict) else {}
        return {"key": str(entry.get("key") or ""), "version": str(entry.get("version") or ""),
                "skills": [package(s) for s in entry.get("skills") or [] if isinstance(s, dict) and s.get("id")],
                "facts": {"count": int(facts.get("count") or 0), "inline": bool(facts.get("inline")),
                          "items": [f for f in facts.get("items") or [] if isinstance(f, dict)]},
                "knowledgeMcp": {"url": _rewrite((entry.get("knowledgeMcp") or {}).get("url"), announced, server)}}

    skills, plugins, connectors = items("skills"), items("plugins"), items("connectors")
    layers = [layer(x) for x in policy.get("sharedLayers") or [] if isinstance(x, dict) and x.get("key")]
    models_block = policy.get("models") if isinstance(policy.get("models"), dict) else {}
    models = [m for m in models_block.get("models") or [] if isinstance(m, dict) and m.get("id")]
    own_models = [m for m in models if not m.get("onlyFor")]
    model_names = {str(m["id"]): str(m.get("model") or "") for m in models}
    main_id = str(models_block.get("main_model_id") or "")
    main_name = model_names.get(main_id) or (str(own_models[0].get("model") or "") if own_models else "")
    own_names = [str(m.get("model") or "") for m in own_models if m.get("model")]
    windows = {str(m.get("model")): int(m["context_window"]) for m in models
               if m.get("model") and isinstance(m.get("context_window"), int) and m["context_window"] > 0}

    builtin = {k: v for k, v in (config.get("mcp_servers") or {}).items() if isinstance(v, dict)}
    base_config = {k: v for k, v in config.items() if k != "mcp_servers"}
    base_config["builtin_mcp"] = builtin

    if service:
        default = {"skills": [package(i) for i in skills], "plugins": [package(i) for i in plugins],
                   "connectors": [connector(i) for i in connectors], "layers": layers}
        agents: list[dict] = []
    else:
        default = {"skills": [package(i) for i in skills if not i.get("onlyFor")], "plugins": [],
                   "connectors": [connector(i) for i in connectors if not i.get("onlyFor")], "layers": []}
        by_id = {"skills": {str(i["id"]): i for i in skills}, "plugins": {str(i["id"]): i for i in plugins},
                 "connectors": {str(i["id"]): i for i in connectors}}
        by_key = {x["key"]: x for x in layers}
        agents = []
        for entry in policy.get("experts") or []:
            if not isinstance(entry, dict) or entry.get("kind") != "agent" or not entry.get("id"):
                continue  # 单独的专家包（kind: expert）平台还没下发，见 21 第 5 节
            model = model_names.get(str(entry.get("model") or "")) or main_name
            agents.append({
                "id": str(entry["id"]), "key": str(entry.get("key") or ""), "name": str(entry.get("name") or ""),
                "description": str(entry.get("description") or ""), "revision": str(entry.get("revision") or ""),
                "instructions": str(entry.get("instructions") or ""),
                "memory": str(entry.get("memory") or "session"), "approval": str(entry.get("approval") or "smart"),
                "model": model, "models": [model] + [n for n in own_names if n != model] if model else own_names,
                "limits": {model: windows[model]} if model in windows else {},
                "skills": [package(by_id["skills"][str(i)]) for i in entry.get("skills") or []
                           if str(i) in by_id["skills"]],
                "plugins": [package(by_id["plugins"][str(i)]) for i in entry.get("plugins") or []
                            if str(i) in by_id["plugins"]],
                "connectors": [connector(by_id["connectors"][str(i)]) for i in entry.get("connectors") or []
                               if str(i) in by_id["connectors"]],
                "layers": [by_key[str(entry.get("key"))]] if str(entry.get("key")) in by_key else [],
                # 这个版本打开的内置工具（27 号第 1 节）；没有这个字段的旧平台 = 全开
                "tools": [str(t) for t in entry["tools"]] if isinstance(entry.get("tools"), list) else None,
            })
    tool_audit = policy.get("toolAudit") if isinstance(policy.get("toolAudit"), dict) else {}
    return {"v": SPEC_VERSION, "tenant": str(info.get("tenantId") or ""), "server": server, "token_env": token_env,
            "revision": str(policy.get("revision") or ""), "config": base_config, "default": default,
            "agents": agents,
            # 企业对接插件（deploy/hermes-mt/plugin）：会话头总是带；工具调用记录按平台的开关，缺省为开（14 号第 14 条）
            "plugin": {"enabled": bool(plugin), "toolAudit": tool_audit.get("enabled", True) is not False}}


def spec_digest(spec: dict) -> str:
    """清单内容的摘要（不含策略版本号：版本号随无关的变化也会变，不该引起重装）。"""
    body = {k: v for k, v in spec.items() if k != "revision"}
    return hashlib.sha256(json.dumps(body, ensure_ascii=False, sort_keys=True, default=str).encode()).hexdigest()


class EnterpriseSync:
    """按用户记着最新的清单和装到哪一份了，需要时送进实例；对实例在跑的成员长轮询平台的变更。"""

    def __init__(self, entry: Entry) -> None:
        self.e = entry
        self._specs: dict[str, tuple[dict, str]] = {}  # user_id -> (清单, 摘要)
        self._applied: dict[str, tuple[str, str]] = {}  # user_id -> (实例标识, 摘要)
        self._tenants: dict[str, Tenant] = {}  # user_id -> 最近一次拿到的实例
        self._locks: dict[str, asyncio.Lock] = {}
        self._retry_at: dict[str, float] = {}  # user_id -> 这个时刻以前不再试
        self._watching: set[str] = set()

    @staticmethod
    def _instance_key(tenant: Tenant) -> str:
        """实例换代就变：沙箱路径看路由 Host（含实例 ID），Docker 路径看容器地址。"""
        return tenant.host_header or tenant.origin or tenant.ip

    def _lock(self, user_id: str) -> asyncio.Lock:
        return self._locks.setdefault(user_id, asyncio.Lock())

    # ---- 清单 ------------------------------------------------------------------------

    async def note_policy(self, user_id: str, policy: dict, *, service: bool = False) -> bool:
        """平台给了新策略：算清单。和上一份不同就记下，实例在跑就马上送。返回清单变没变。"""
        tenants = self.e.tenants
        if tenants is None:
            return False
        context = await self.e.store.get_tenant_context(user_id)
        config = tenants._config_patch_spec(context.endpoint, context.catalog, getattr(context, "limits", None),  # noqa: SLF001
                                            api_key=context.api_key or "")
        spec = build_spec(policy, server=self.e.s.uniwork_server, token_env=self.e.s.key_env_name, config=config,
                          service=service, plugin=self.e.s.uniwork_plugin)
        digest = spec_digest(spec)
        previous = self._specs.get(user_id)
        self._specs[user_id] = (spec, digest)
        if previous is not None and previous[1] == digest:
            return False
        tenant = self._tenants.get(user_id)
        if tenant is not None and not service:
            self.e._spawn(self._push_quietly(user_id, tenant))  # noqa: SLF001
        return True

    def forget(self, user_id: str) -> None:
        self._specs.pop(user_id, None)
        self._applied.pop(user_id, None)
        self._tenants.pop(user_id, None)

    # ---- 送进实例 --------------------------------------------------------------------

    def after_ready(self, user_id: str, tenant: Tenant) -> None:
        """每次拿到在跑的实例时调（很频繁，所以只做内存里的判断）：没装过当前清单就后台送一次；顺手开始长轮询。"""
        self._tenants[user_id] = tenant
        current = self._specs.get(user_id)
        if current is not None and self._applied.get(user_id) != (self._instance_key(tenant), current[1]):
            if time.monotonic() >= self._retry_at.get(user_id, 0.0) and not self._lock(user_id).locked():
                self.e._spawn(self._push_quietly(user_id, tenant))  # noqa: SLF001
        if self.e.uniwork is not None and user_id not in self._watching and not user_id.startswith("svc:"):
            self._watching.add(user_id)
            self.e._spawn(self._watch(user_id))  # noqa: SLF001

    async def apply_now(self, user_id: str, tenant: Tenant) -> dict:
        """送当前清单并等它装完（平台的运行环境用：装好技能和连接器才能回 ready）。没有清单就什么都不做。"""
        self._tenants[user_id] = tenant
        return await self._push(user_id, tenant, force=False)

    async def _push_quietly(self, user_id: str, tenant: Tenant) -> None:
        try:
            await self._push(user_id, tenant)
        except Exception as exc:  # noqa: BLE001 —— 送不进去下一次请求再试，不影响正在用的人
            self._retry_at[user_id] = time.monotonic() + RETRY_S
            log.warning("enterprise: 给 %s 的实例送清单失败：%s", user_id, exc)

    async def _push(self, user_id: str, tenant: Tenant, force: bool = False) -> dict:
        async with self._lock(user_id):
            current = self._specs.get(user_id)
            if current is None:
                return {}
            spec, digest = current
            key = self._instance_key(tenant)
            if not force and self._applied.get(user_id) == (key, digest):
                return {}
            body = await self._call(tenant, spec)
            report = body.get("report") if isinstance(body.get("report"), dict) else {}
            restart_needed = bool(body.get("restart_needed"))
            tenants = self.e.tenants
            if restart_needed and not body.get("busy") and tenants is not None and not tenants.use_cube:
                # Docker 路径：转发器重启不了 hermes（它是容器的主进程），由这里重启容器
                tenant = await tenants.restart_container(user_id)
                self._tenants[user_id] = tenant
                restart_needed = False
                log.info("enterprise: %s 的企业资源要重启 hermes 才生效，已重启容器", user_id)
            if restart_needed:
                # 实例在忙（有对话或定时任务在跑）：文件已经装好，重启留到之后的请求再试
                self._retry_at[user_id] = time.monotonic() + RETRY_S
            elif report.get("errors"):
                # 有资源没装上：装好的不会重装（转发器按包的 sha256 比对），过一阵再试没装上的
                self._retry_at[user_id] = time.monotonic() + ERROR_RETRY_S
            else:
                self._applied[user_id] = (key, digest)
                self._retry_at.pop(user_id, None)
            if body.get("restarted"):
                log.info("enterprise: %s 的企业资源要重启 hermes 才生效，实例里已重启", user_id)
            if report.get("errors"):
                log.warning("enterprise: %s 有 %d 项资源没装上：%s", user_id, len(report["errors"]),
                            "; ".join(report["errors"])[:400])
            changed = {k: v for k, v in report.items() if k in ("profiles", "installed", "removed", "retired", "restored")
                       and v}
            if changed:
                log.info("enterprise: %s 的企业资源已更新：%s", user_id, json.dumps(changed, ensure_ascii=False)[:600])
                await self.e.store.write_audit(user_id, "enterprise.apply", changed)
            return report

    async def _call(self, tenant: Tenant, spec: dict) -> dict:
        assert self.e.http is not None
        origin = tenant.origin or f"{tenant.ip}:{self.e.s.forward_port}"
        headers = {"Host": tenant.host_header or f"127.0.0.1:{self.e.s.hermes_port}", "X-MT-Token": tenant.token}
        if getattr(tenant, "traffic_token", ""):
            headers["cube-traffic-access-token"] = tenant.traffic_token
        async with self.e.http.post(f"http://{origin}/__mt/enterprise", json={"spec": spec, "restart": True},
                                    headers=headers, timeout=aiohttp.ClientTimeout(total=PUSH_TIMEOUT_S)) as resp:
            try:
                body = await resp.json(content_type=None)
            except (ValueError, aiohttp.ContentTypeError):
                body = {"error": (await resp.text())[:200]}
            if resp.status != 200 or not isinstance(body, dict):
                message = body.get("error") if isinstance(body, dict) else ""
                raise RuntimeError(f"转发器返回 HTTP {resp.status}：{message or '（无说明）'}")
            return body

    # ---- 长轮询 ----------------------------------------------------------------------

    async def _watch(self, user_id: str) -> None:
        """实例在跑期间，长轮询平台的 /api/client/events：后台一改（发布或下架 Agent、改技能……）几秒内就收到，
        重新拉策略、算清单、送进实例。实例停了、令牌失效了就停，下一次请求再开始。"""
        delay = 0.0
        try:
            while True:
                if delay:
                    await asyncio.sleep(delay)
                binding = await self.e.store.get_enterprise_binding(user_id)
                runtime = await self.e.store.get_runtime(user_id)
                if binding is None or binding.access_status == UNBOUND or runtime.state != "running":
                    return
                token = (await self.e.store.get_tenant_context(user_id)).api_key
                uniwork = self.e.uniwork
                if not token or uniwork is None:
                    return
                try:
                    answer = await uniwork.events(token, binding.policy_revision, EVENTS_WAIT_S)
                except UniworkError as exc:
                    if exc.status == 401:
                        # 员工重新登录时平台吊销旧令牌，这条长轮询马上收到 401：令牌已经换了就用新的接着等；
                        # 没换才是真失效，复查会把绑定记成 unbound，下一轮就停
                        if (await self.e.store.get_tenant_context(user_id)).api_key == token:
                            await self.e._refresh_enterprise(user_id)  # noqa: SLF001
                        delay = 1.0
                    elif exc.status == 404:
                        delay = 300.0  # 老平台没有长轮询，靠每分钟的复查
                    else:
                        delay = min(60.0, max(5.0, delay * 2))
                    continue
                delay = 0.0
                if answer.get("changed"):
                    await self.e._refresh_enterprise(user_id)  # noqa: SLF001
                    # 复查没跟上（平台忙）就别空转
                    fresh = await self.e.store.get_enterprise_binding(user_id)
                    if fresh is not None and fresh.policy_revision != str(answer.get("revision") or ""):
                        delay = 10.0
        except Exception as exc:  # noqa: BLE001
            log.warning("enterprise: %s 的长轮询停了：%s", user_id, type(exc).__name__)
        finally:
            self._watching.discard(user_id)

