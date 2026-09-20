"""租户生命周期：一用户一容器、一网络、一卷。

设计约束（照隔壁方案说明）：
- hermes 镜像**一个字节不改**。转发器是卷里的一段 python（seed/forward.py），
  由容器 CMD 以 ``sh -c 'python3 forward.py & exec hermes serve …'`` 拉起，
  hermes 仍绑 127.0.0.1:9120，鉴权门关着，ws 的对端是 127.0.0.1。
- 每个租户一个独立 bridge 网络，入口容器自己 connect 进去；租户之间没有共同网络，
  互相不可达。不用 ``enable_icc=false``（那会把入口也挡在外面）。
- 用户数据全在 named volume ``<prefix>-data-<uid>``；容器随时可删重建。
- 首次建卷时把 ``.env``（模型 key）和 ``config.yaml`` 放进去；镜像的 stage2 hook
  只在文件不存在时才 seed，所以我们放的文件不会被覆盖，之后会被 chown 给 hermes。
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import logging
import re
import socket
import tarfile
import time
from dataclasses import dataclass
from pathlib import Path

import aiohttp

from .config import Settings
from .docker_api import Docker, DockerError
from .store import Store

log = logging.getLogger("entry.tenants")

SEED_DIR = Path(__file__).resolve().parent.parent / "seed"
_SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,40}$")


def tenant_slug(user_id: str) -> str:
    """把上游 uid 变成能当容器名/卷名的确定性 id。"""
    lowered = user_id.strip().lower()
    if _SAFE_ID.match(lowered):
        return lowered
    return "u" + hashlib.sha1(user_id.encode()).hexdigest()[:12]


@dataclass
class Tenant:
    user_id: str
    slug: str
    ip: str
    token: str


def _stamp_bytes(endpoint: tuple[str, str], models: list[str] | None = None) -> bytes:
    """记录「这个卷当前用的是哪个端点、哪些模型」，下次比对用。

    模型清单也算进来：套餐加了一个模型而端点没变时，同样要把它同步进 config.yaml。
    """
    return ("\n".join([endpoint[0], endpoint[1], "models=" + ",".join(models or []), ""])).encode("utf-8")


def _tar_bytes(files: dict[str, bytes], mode: int = 0o644) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for rel, content in files.items():
            info = tarfile.TarInfo(name=rel)
            info.size = len(content)
            info.mode = mode
            info.mtime = int(time.time())
            tar.addfile(info, io.BytesIO(content))
    return buf.getvalue()


class TenantManager:
    def __init__(self, settings: Settings, docker: Docker, store: Store, http: aiohttp.ClientSession):
        self.s = settings
        self.docker = docker
        self.store = store
        self.http = http
        self._locks: dict[str, asyncio.Lock] = {}
        self._self_container = settings.self_container or socket.gethostname()

    # ---- naming ------------------------------------------------------------------
    def container_name(self, slug: str) -> str:
        return f"{self.s.prefix}-t-{slug}"

    def network_name(self, slug: str) -> str:
        return f"{self.s.prefix}-net-{slug}"

    def volume_name(self, slug: str) -> str:
        return f"{self.s.prefix}-data-{slug}"

    def _lock(self, slug: str) -> asyncio.Lock:
        lock = self._locks.get(slug)
        if lock is None:
            lock = self._locks[slug] = asyncio.Lock()
        return lock

    # ---- seed files ------------------------------------------------------------
    @staticmethod
    def _models_block(catalog: list[tuple[str, str]], fallback: str) -> str:
        """渲染 providers.<key>.models 映射。空清单时至少放主模型，别产出空 mapping。"""
        names = [n for n, _ in catalog] or [fallback]
        return "\n".join(f"      {n}: {{}}" for n in names)

    def _render_seed(
        self,
        api_key: str,
        endpoint: tuple[str, str] | None = None,
        catalog: list[tuple[str, str]] | None = None,
    ) -> dict[str, bytes]:
        """endpoint = my-plan 给这个用户的 (base_url, model)；没有就退回环境变量里的默认值。

        ★ 优先用 my-plan 的值：套餐 key 只在它自己的 TokenPlan 专用路径上有效，
        用手写的通用网关地址会被回 1004「请使用 TokenPlan 专用路径」。
        """
        base_url, model_name = endpoint or ("", "")
        base_url = base_url or self.s.model_base_url
        model_name = model_name or self.s.model_name
        files: dict[str, bytes] = {}
        forward = (SEED_DIR / "forward.py").read_bytes()
        files[".mt/forward.py"] = forward
        config_tmpl = (SEED_DIR / "config.yaml.tmpl").read_text(encoding="utf-8")
        config = (
            config_tmpl.replace("{{MODEL_NAME}}", model_name)
            .replace("{{MODEL_BASE_URL}}", base_url)
            .replace("{{PROVIDER_KEY}}", self.s.provider_key)
            .replace("{{KEY_ENV_NAME}}", self.s.key_env_name)
            .replace("{{FILES_ROOT}}", self.s.files_root)
            .replace("{{MODELS_BLOCK}}", self._models_block(catalog or [], model_name))
        )
        files["config.yaml"] = config.encode("utf-8")
        env_lines = [f"TERMINAL_ENV=local"]
        if api_key:
            env_lines.append(f"{self.s.key_env_name}={api_key}")
        files[".env"] = ("\n".join(env_lines) + "\n").encode("utf-8")
        return files

    # ---- 平台下发的模型配置：变了要同步到已有的卷 ------------------------------------
    @staticmethod
    def _patch_config(text: str, base_url: str, model_name: str, provider_key: str) -> str:
        """只改 ``model:`` 段和 ``providers.<key>:`` 段里的端点/模型四行，其余一字不动。

        不能整份重写：hermes 自己会往 config.yaml 里写运行时状态，用户也可能在界面上
        改过别的设置。
        """
        out: list[str] = []
        section: str | None = None
        sub: str | None = None
        for line in text.splitlines(keepends=True):
            body = line.rstrip("\n")
            if body and not body[0].isspace() and body.rstrip().endswith(":"):
                section = body.rstrip()[:-1]
                sub = None
            elif section == "providers" and body.startswith("  ") and not body.startswith("    ") and body.rstrip().endswith(":"):
                sub = body.strip()[:-1]
            stripped = body.strip()
            if section == "model" and stripped.startswith("base_url:"):
                line = f'  base_url: "{base_url}"\n'
            elif section == "model" and stripped.startswith("default:"):
                line = f'  default: "{model_name}"\n'
            elif section == "providers" and sub == provider_key and stripped.startswith("api:"):
                line = f'    api: "{base_url}"\n'
            elif section == "providers" and sub == provider_key and stripped.startswith("default_model:"):
                line = f'    default_model: "{model_name}"\n'
            out.append(line)
        return "".join(out)

    @staticmethod
    def _from_tar(blob: bytes, name: str) -> bytes | None:
        with tarfile.open(fileobj=io.BytesIO(blob)) as tar:
            for m in tar.getmembers():
                if m.isfile() and m.name.rsplit("/", 1)[-1] == name:
                    f = tar.extractfile(m)
                    return f.read() if f else None
        return None

    @staticmethod
    def _patch_models(text: str, provider_key: str, names: list[str]) -> str:
        """把 ``providers.<key>.models`` 整段换成 *names*。段不存在就补在该 provider 末尾。

        ★ 界面的模型下拉读的是这个映射，不是 default_model。套餐里有三个模型而这里只写
        一个，用户就只看得到一个。
        """
        if not names:
            return text
        lines = text.splitlines(keepends=True)
        out: list[str] = []
        section: str | None = None
        sub: str | None = None
        in_models = False          # 正在跳过旧的 models 子树
        wrote = False
        block = [f"      {n}: {{}}\n" for n in names]

        def flush_provider_end() -> None:
            """在离开该 provider 之前补上 models 段。

            先把已经攒下的尾部空行摘掉，补完再放回去——否则新段会落在空行之后，
            看起来像脱离了这个 provider（YAML 仍然合法，纯粹是给人看的）。
            """
            nonlocal wrote
            if wrote:
                return
            trailing: list[str] = []
            while out and not out[-1].strip():
                trailing.append(out.pop())
            out.append("    models:\n")
            out.extend(block)
            out.extend(reversed(trailing))
            wrote = True

        for line in lines:
            body = line.rstrip("\n")
            top = bool(body) and not body[0].isspace() and body.rstrip().endswith(":")
            prov = section == "providers" and body.startswith("  ") and not body.startswith("    ") and body.rstrip().endswith(":")
            if in_models:
                # models 的子项缩进比 "    models:" 更深；遇到同级/更浅的行**或空行**就结束。
                # 空行必须算结束并保留：我们生成的条目里没有空行，把它吞掉会让重复执行
                # 一次比一次少一行（不幂等）。
                if not body.strip() or not body.startswith("      "):
                    in_models = False
                else:
                    continue
            if top or prov:
                if sub == provider_key and (top or prov):
                    flush_provider_end()
                section = body.rstrip()[:-1] if top else section
                sub = body.strip()[:-1] if prov else (None if top else sub)
            if section == "providers" and sub == provider_key and body.strip().startswith("models:"):
                out.append("    models:\n")
                out.extend(block)
                wrote = True
                in_models = True
                continue
            out.append(line)
        if sub == provider_key:
            flush_provider_end()
        return "".join(out)

    async def _sync_endpoint(
        self,
        cname: str,
        endpoint: tuple[str, str] | None,
        catalog: list[tuple[str, str]] | None = None,
    ) -> bool:
        """套餐给的端点变了就改写这个卷里的 config.yaml。返回 True 表示改过（需要重启容器）。

        ★ 为什么必须有这一步：模型端点是**平台下发**的，会变（换套餐、网关迁移、
        或者像 09-20 这样发现之前写的是错的通用路径）。只在首次建卷时写，已有用户
        就永远卡在旧地址上，症状是网关回 1004 而不是任何看得懂的错误。
        """
        base_url, model_name = endpoint or ("", "")
        if not base_url:
            return False
        names = [n for n, _ in (catalog or [])]
        want = _stamp_bytes((base_url, model_name), names)
        try:
            stamp_tar = await self.docker.get_archive(cname, "/opt/data/.mt/endpoint.stamp")
            if stamp_tar and self._from_tar(stamp_tar, "endpoint.stamp") == want:
                return False
            cfg_tar = await self.docker.get_archive(cname, "/opt/data/config.yaml")
            if not cfg_tar:
                return False
            raw = self._from_tar(cfg_tar, "config.yaml")
            if raw is None:
                return False
            patched = self._patch_config(raw.decode("utf-8"), base_url, model_name, self.s.provider_key)
            patched = self._patch_models(patched, self.s.provider_key, names)
            files = {".mt/endpoint.stamp": want}
            if patched.encode("utf-8") != raw:
                files["config.yaml"] = patched.encode("utf-8")
                log.info(
                    "tenant %s: 套餐配置变了，已更新 config.yaml -> %s / %s / models=%s",
                    cname, base_url, model_name, ",".join(names) or "(仅主模型)",
                )
            await self.docker.put_archive(cname, "/opt/data", _tar_bytes(files))
            return "config.yaml" in files
        except DockerError as exc:
            log.warning("tenant %s: 同步套餐端点失败: %s", cname, exc)
            return False

    # ---- lifecycle -----------------------------------------------------------------
    async def ensure_running(
        self,
        user_id: str,
        api_key: str = "",
        endpoint: tuple[str, str] | None = None,
        catalog: list[tuple[str, str]] | None = None,
    ) -> Tenant:
        slug = tenant_slug(user_id)
        async with self._lock(slug):
            token = self.store.ensure_tenant_token(user_id)
            cname, nname, vname = self.container_name(slug), self.network_name(slug), self.volume_name(slug)
            labels = {"hermes.mt": "tenant", "hermes.mt.user": user_id, "hermes.mt.slug": slug}

            await self.docker.ensure_network(nname, labels)
            await self.docker.connect_network(nname, self._self_container)
            fresh_volume = await self.docker.ensure_volume(vname, labels)

            info = await self.docker.inspect_container(cname)
            if info is not None:
                # 镜像换了就重建（卷不动）
                if info.get("Config", {}).get("Image") != self.s.image:
                    log.info("tenant %s: image changed, recreating container", slug)
                    await self.docker.remove_container(cname)
                    info = None
            if info is None:
                await self._create(cname, nname, vname, labels, token)
                seed = self._render_seed(api_key, endpoint, catalog)
                if not fresh_volume:
                    # 卷已有数据：只刷新转发器，不碰用户的 .env / config.yaml
                    seed = {k: v for k, v in seed.items() if k.startswith(".mt/")}
                if endpoint and endpoint[0]:
                    seed[".mt/endpoint.stamp"] = _stamp_bytes(endpoint, [n for n, _ in (catalog or [])])
                await self.docker.put_archive(cname, "/opt/data", _tar_bytes(seed))
                info = await self.docker.inspect_container(cname)

            # 平台下发的端点若有变化，先改卷里的 config.yaml（hermes 只在启动时读一次）
            changed = await self._sync_endpoint(cname, endpoint, catalog)
            if changed and (info or {}).get("State", {}).get("Running"):
                log.info("tenant %s: 端点已更新，重启容器让 hermes 重新读配置", slug)
                await self.docker.stop_container(cname)
                info = await self.docker.inspect_container(cname)

            state = (info or {}).get("State", {})
            if not state.get("Running"):
                self.store.set_tenant_state(user_id, "starting")
                self.store.audit(user_id, "tenant.start", cname)
                await self.docker.start_container(cname)

            ip = await self.docker.container_ip(cname, nname)
            if not ip:
                raise RuntimeError(f"容器 {cname} 没有拿到 {nname} 网络的 IP")
            await self._wait_ready(ip)
            self.store.set_tenant_state(user_id, "running")
            self.store.touch_tenant(user_id)
            return Tenant(user_id=user_id, slug=slug, ip=ip, token=token)

    async def _create(self, cname: str, nname: str, vname: str, labels: dict, token: str) -> None:
        cmd = (
            "python3 /opt/data/.mt/forward.py & "
            f"exec hermes serve --host 127.0.0.1 --port {self.s.hermes_port} --skip-build"
        )
        spec = {
            "Image": self.s.image,
            "Env": [
                "HERMES_HOME=/opt/data",
                f"HERMES_DASHBOARD_SESSION_TOKEN={token}",
                "HERMES_UID=10000",
                "HERMES_GID=10000",
                f"TZ={self.s.tz}",
                "TERMINAL_ENV=local",
                f"HERMES_DASHBOARD_FILES_ROOT={self.s.files_root}",
                f"MT_FWD_PORT={self.s.forward_port}",
                f"MT_HERMES_PORT={self.s.hermes_port}",
            ],
            "Cmd": ["sh", "-c", cmd],
            "Labels": labels,
            "HostConfig": {
                "Binds": [f"{vname}:/opt/data"],
                "Memory": self.s.memory_bytes,
                "MemorySwap": self.s.memory_bytes,
                "NanoCpus": self.s.nano_cpus,
                "PidsLimit": self.s.pids_limit,
                "SecurityOpt": ["no-new-privileges"],
                "RestartPolicy": {"Name": "no"},
                "NetworkMode": nname,
                "LogConfig": {"Type": "json-file", "Config": {"max-size": "20m", "max-file": "3"}},
            },
        }
        await self.docker.create_container(cname, spec)

    async def _wait_ready(self, ip: str) -> None:
        """轮询 /api/health。注意 Host 头必须是 loopback 名，否则被 hermes 的 Host 门拒掉。"""
        url = f"http://{ip}:{self.s.forward_port}/api/health"
        headers = {"Host": f"127.0.0.1:{self.s.hermes_port}"}
        deadline = time.monotonic() + self.s.ready_timeout_s
        last_err = ""
        while time.monotonic() < deadline:
            try:
                async with self.http.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=3)) as resp:
                    if resp.status == 200:
                        return
                    last_err = f"HTTP {resp.status}"
            except Exception as exc:  # noqa: BLE001
                last_err = type(exc).__name__
            await asyncio.sleep(1.0)
        raise TimeoutError(f"租户容器 {self.s.ready_timeout_s}s 内没就绪: {last_err}")

    async def stop(self, user_id: str, reason: str = "") -> None:
        slug = tenant_slug(user_id)
        async with self._lock(slug):
            cname = self.container_name(slug)
            info = await self.docker.inspect_container(cname)
            if info and info.get("State", {}).get("Running"):
                await self.docker.stop_container(cname)
            self.store.set_tenant_state(user_id, "stopped")
            self.store.audit(user_id, "tenant.stop", reason)

    async def reconcile(self) -> None:
        """入口启动时：把所有租户容器停掉，运行态清成 stopped，之后按需再起。

        ★ 必须在后台跑，不能挡住入口开始监听：停一个容器要一秒多，几十个租户就是
        几十秒的 502 窗口（实测 6 个容器 6.8s，期间 nginx 全部 connection refused）。
        ★ 每个租户都走 ``ensure_running`` 用的同一把锁，否则后台停容器会和这段时间里
        进来的用户请求打架——刚拉起来的容器被 reconcile 一巴掌停掉。
        """
        containers = await self.docker.list_containers("hermes.mt=tenant")
        for c in containers:
            name = (c.get("Names") or ["?"])[0].lstrip("/")
            slug = (c.get("Labels") or {}).get("hermes.mt.slug", "")
            user_id = (c.get("Labels") or {}).get("hermes.mt.user", "")
            async with self._lock(slug or name):
                if c.get("State") == "running":
                    try:
                        await self.docker.stop_container(name)
                    except DockerError as exc:
                        log.warning("reconcile stop %s failed: %s", name, exc)
                if user_id:
                    self.store.set_tenant_state(user_id, "stopped")
        log.info("reconcile: %d tenant container(s) reset", len(containers))

    async def reap_idle(self, keep: set[str] | None = None) -> None:
        """``keep`` = 此刻还挂着 ws 连接的用户，一律不回收。"""
        for user_id in self.store.idle_tenants(self.s.idle_minutes * 60, exclude=keep):
            try:
                log.info("idle reap: stopping tenant of %s", user_id)
                await self.stop(user_id, reason=f"idle>{self.s.idle_minutes}m")
            except Exception:  # noqa: BLE001
                log.exception("idle reap failed for %s", user_id)
