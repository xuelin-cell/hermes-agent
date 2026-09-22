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
from .cube_api import Cube, CubeError
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
    """一个已经就绪、可以转发的租户实例。

    ``origin`` 和 ``host_header`` 是两种后端唯一的分歧点，也是转发层唯一需要知道的差异：

    - **Docker 后端**：直连容器 IP，Host 由我们伪造成回环形式，
      这样容器里的 hermes 认为请求来自本机、鉴权门关着。
    - **沙箱后端**：连平台代理，Host 用平台的路由格式；
      平台再按每个实例配置的模板把它改写成回环形式，效果一样。

    转发层照着这两个字段发就行，不需要知道背后是哪种后端。
    """

    # ★ 前四个字段的顺序不能动：有调用方是按位置构造的，
    #   把 token 和 ip 换个位置会让它们静默地互相顶替。新字段一律往后加。
    user_id: str
    slug: str
    ip: str                 # 仅 Docker 后端有值，沙箱后端传空串
    token: str
    origin: str = ""        # "host:port"，转发目标
    host_header: str = ""   # 发给上游的 Host 头
    sandbox_id: str = ""    # 仅沙箱后端有值


class CredentialSyncError(RuntimeError):
    """平台模型凭据未能同步到用户 Hermes 容器。"""


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
    """两种执行后端共用的门面。

    ``settings.backend`` 决定走哪条路：``docker`` 是我们自己建容器，
    ``cube`` 是让沙箱平台建实例。两条路的差异全部收敛在 ``_*_docker`` /
    ``_*_cube`` 这几对方法里，对 app.py 和 proxy.py 完全透明。

    ★ Docker 那条路的代码一个字没动 —— 沙箱后端是加出来的，不是改出来的。
    """

    def __init__(
        self,
        settings: Settings,
        docker: Docker | None,
        store: Store,
        http: aiohttp.ClientSession,
        cube: "Cube | None" = None,
    ):
        self.s = settings
        self.docker = docker
        self.cube = cube
        self.store = store
        self.http = http
        self._locks: dict[str, asyncio.Lock] = {}
        self._synced_key_digests: dict[str, bytes] = {}
        self._self_container = settings.self_container or socket.gethostname()

    @property
    def use_cube(self) -> bool:
        return self.s.backend == "cube"

    def _backend_client(self):
        """取当前后端的客户端，没接上就当场报错。

        ★ 检查放在用到的时候，不放在构造函数里：有调用方只为了用其中一两个
          与后端无关的方法（比如凭据同步）而构造它，此时另一个客户端本来就该是空的。
        """
        client = self.cube if self.use_cube else self.docker
        if client is None:
            raise RuntimeError(f"MT_BACKEND={self.s.backend} 但对应的客户端没有接上")
        return client

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

    def _render_user_files(
        self,
        api_key: str,
        endpoint: tuple[str, str] | None = None,
        catalog: list[tuple[str, str]] | None = None,
    ) -> dict[str, bytes]:
        """只渲染「属于这个用户」的两份文件：``config.yaml`` 和 ``.env``。

        与 ``_render_seed`` 分开，是因为两种后端要的东西不一样：
        Docker 后端还要把转发器一并塞进卷，沙箱后端不要 —— 转发器已经烘进镜像了。
        混在一起会让沙箱路径凭空依赖 seed 目录里的一个它根本用不到的文件。

        endpoint = my-plan 给这个用户的 (base_url, model)；没有就退回环境变量里的默认值。

        ★ 优先用 my-plan 的值：套餐 key 只在它自己的 TokenPlan 专用路径上有效，
        用手写的通用网关地址会被回 1004「请使用 TokenPlan 专用路径」。
        """
        base_url, model_name = endpoint or ("", "")
        base_url = base_url or self.s.model_base_url
        model_name = model_name or self.s.model_name
        files: dict[str, bytes] = {}
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

    def _render_seed(
        self,
        api_key: str,
        endpoint: tuple[str, str] | None = None,
        catalog: list[tuple[str, str]] | None = None,
    ) -> dict[str, bytes]:
        """Docker 后端要塞进卷的全部文件：用户那两份，外加转发器。

        沙箱后端不走这里 —— 它的转发器在镜像里，见 ``_cube_seed_files``。
        """
        files = self._render_user_files(api_key, endpoint, catalog)
        files[".mt/forward.py"] = (SEED_DIR / "forward.py").read_bytes()
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
    async def ensure_running(self, user_id: str) -> Tenant:
        """保证这个用户有一个能用的实例，返回可直接转发的 ``Tenant``。"""
        self._backend_client()
        if self.use_cube:
            return await self._ensure_running_cube(user_id)
        return await self._ensure_running_docker(user_id)

    async def _ensure_running_docker(
        self,
        user_id: str,
    ) -> Tenant:
        slug = tenant_slug(user_id)
        async with self._lock(slug):
            token = await self.store.ensure_tenant_token(user_id)
            context = await self.store.get_tenant_context(user_id)
            api_key = context.api_key
            endpoint = context.endpoint
            catalog = context.catalog
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
            needs_start = not state.get("Running")
            if needs_start:
                await self.store.set_tenant_state(user_id, "starting")
            try:
                if needs_start:
                    await self.store.write_audit(user_id, "tenant.start", {"container": cname})
                    await self.docker.start_container(cname)

                ip = await self.docker.container_ip(cname, nname)
                if not ip:
                    raise RuntimeError(f"容器 {cname} 没有拿到 {nname} 网络的 IP")
                await self._wait_ready(ip)
            except Exception:  # noqa: BLE001
                try:
                    await self.store.set_tenant_state(user_id, "stopped")
                except Exception as state_exc:  # noqa: BLE001
                    log.warning(
                        "tenant %s: 启动失败后回写 stopped 失败: %s",
                        cname,
                        type(state_exc).__name__,
                    )
                raise
            tenant = Tenant(
                user_id=user_id,
                slug=slug,
                token=token,
                ip=ip,
                origin=f"{ip}:{self.s.forward_port}",
                host_header=f"127.0.0.1:{self.s.hermes_port}",
            )
            await self.store.set_tenant_state(user_id, "running")
            await self.store.touch_tenant(user_id)
            await self._sync_api_key(tenant, api_key)
            return tenant

    # ---- 沙箱后端 ---------------------------------------------------------------

    def cube_volume_name(self, user_id: str) -> str:
        """用户的持久卷名。平台的 volumeID 与 name 相同，所以这就是卷 ID。

        ★ 不能复用 ``tenant_slug``：它做了小写归一化，是**多对一**的 ——
          ``Alice`` 和 ``alice`` 会算出同一个名字，等于两个用户共用一份数据。
          容器名多对一只是撞名，卷名多对一是数据串台，性质完全不同。
          这里一律走摘要，保证单射。
        """
        digest = hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:32]
        return f"{self.s.prefix}-u-{digest}"

    def _cube_seed_files(
        self,
        api_key: str,
        endpoint: tuple[str, str] | None,
        catalog: list[tuple[str, str]] | None,
    ) -> list[dict]:
        """渲染引导接口要的种子文件。

        与 Docker 那边 ``_render_seed`` 的两点差异：

        1. **不含转发器**。它已经烘进镜像了，不再放在用户可写的数据目录里 ——
           放那儿意味着租户能替换掉自己的转发器。
        2. **``config.yaml`` 用 ``if-pristine``**。沙箱路径下镜像的首启引导比我们的
           引导先跑，会先种一份默认示例；直接 ``overwrite=False`` 会让我们的配置
           永远写不进去，直接 ``True`` 又会毁掉老用户自己改过的内容。
           ``if-pristine`` 的判据是与镜像里的示例逐字节比对，见 seed/forward.py。
        """
        rendered = self._render_user_files(api_key, endpoint, catalog)
        return [
            {
                "path": "config.yaml",
                "content": rendered["config.yaml"].decode("utf-8"),
                "overwrite": "if-pristine",
            },
            {
                "path": ".env",
                "content": rendered[".env"].decode("utf-8"),
                "overwrite": True,
            },
        ]

    async def _ensure_running_cube(self, user_id: str) -> Tenant:
        assert self.cube is not None
        slug = tenant_slug(user_id)
        port = self.s.forward_port
        async with self._lock(slug):
            token = await self.store.ensure_tenant_token(user_id)
            context = await self.store.get_tenant_context(user_id)
            volume = self.cube_volume_name(user_id)

            # 卷先于实例存在，而且不随实例销毁。建过了就是幂等的一次查询。
            await self.cube.ensure_volume(volume, self.s.cube_volume_driver)

            sandbox_id = await self.store.get_sandbox_id(user_id)
            if sandbox_id:
                state = await self.cube.sandbox_state(sandbox_id)
                if state == "gone":
                    # 平台侧已经没了（节点维护、被手工删掉…）。数据在卷上，重建即可。
                    log.info("tenant %s: 实例 %s 已不存在，重建", slug, sandbox_id[:12])
                    await self.store.set_sandbox_id(user_id, None)
                    sandbox_id = ""

            # 与 Docker 那条路同一条不变式：中途失败不能把状态留在 starting，
            # 否则这个用户会一直被当成"正在启动"，既不会被回收也不会被重试。
            try:
                if not sandbox_id:
                    await self.store.set_tenant_state(user_id, "starting")
                    sandbox_id = await self.cube.create_sandbox(
                        volume_name=volume,
                        workspace_path=self.s.cube_workspace_path,
                        metadata={"hermes.mt": "tenant", "hermes.mt.slug": slug},
                    )
                    # ★ 先落库再引导：引导可能超时，但实例已经真实存在了。
                    #   不先记下来的话，下一次请求会再建一个，旧的成为没人管的孤儿。
                    await self.store.set_sandbox_id(user_id, sandbox_id)
                    await self.store.write_audit(user_id, "tenant.start", {"sandbox": sandbox_id})

                    await self.cube.wait_forwarder(sandbox_id, port)
                    await self.cube.bootstrap(
                        sandbox_id,
                        port,
                        token=token,
                        files=self._cube_seed_files(
                            context.api_key, context.endpoint, context.catalog
                        ),
                        ready_timeout_s=self.s.ready_timeout_s,
                    )

                # 实例可能是 paused —— 这个请求会把它自动唤醒，等就绪即可。
                await self.cube.wait_hermes(sandbox_id, port, timeout_s=self.s.ready_timeout_s)
            except Exception:  # noqa: BLE001
                try:
                    await self.store.set_tenant_state(user_id, "stopped")
                except Exception as state_exc:  # noqa: BLE001
                    log.warning(
                        "tenant %s: 启动失败后回写 stopped 失败: %s",
                        slug,
                        type(state_exc).__name__,
                    )
                raise

            tenant = Tenant(
                user_id=user_id,
                slug=slug,
                ip="",  # 沙箱后端不直连实例 IP，走平台代理
                token=token,
                sandbox_id=sandbox_id,
                origin=self.cube.proxy_base.split("://", 1)[-1],
                host_header=self.cube.host_for(sandbox_id, port),
            )
            await self.store.set_tenant_state(user_id, "running")
            await self.store.touch_tenant(user_id)
            await self._sync_api_key(tenant, context.api_key)
            return tenant

    async def _stop_cube(self, user_id: str, reason: str) -> None:
        """空闲回收 = 暂停，不是销毁。

        ★ 销毁会连同实例可写层一起删掉，而对话库就在可写层上 —— 用户的历史会没。
          暂停则把整机状态冻结存盘，下次请求 0.4 秒左右唤醒，数据完好。
        """
        assert self.cube is not None
        slug = tenant_slug(user_id)
        async with self._lock(slug):
            sandbox_id = await self.store.get_sandbox_id(user_id)
            if sandbox_id:
                try:
                    await self.cube.pause_sandbox(sandbox_id)
                except CubeError as exc:
                    log.warning("暂停 %s 的实例失败: %s", slug, exc)
            await self.store.set_tenant_state(user_id, "stopped")
            await self.store.write_audit(user_id, "tenant.stop", {"reason": reason})

    async def _reconcile_cube(self) -> None:
        """入口启动时把运行态清成 stopped，但**不动平台上的实例**。

        与 Docker 那条路的区别：那边入口重启后容器状态未知，一律停掉重来；
        这边实例是平台在管的，暂停/恢复都很便宜，而且实例里可能还挂着别人的
        长连接（多个入口副本共用一个集群）。所以这里只修正我们自己的库，
        实例交给空闲回收按活跃时间处理。
        """
        rows = await self.store.all_tenant_states()
        for user_id, state, _ in rows:
            if state in ("running", "starting"):
                await self.store.set_tenant_state(user_id, "stopped")
        log.info("reconcile(cube): %d 条运行态已重置，平台实例未动", len(rows))

    async def _sync_api_key(self, tenant: Tenant, api_key: str) -> None:
        """通过 Hermes 既有接口更新 Key；只有成功后才记录内存摘要。"""
        if not api_key:
            return
        digest = hashlib.sha256(api_key.encode("utf-8")).digest()
        if self._synced_key_digests.get(tenant.user_id) == digest:
            return
        origin = tenant.origin or f"{tenant.ip}:{self.s.forward_port}"
        url = f"http://{origin}/api/env"
        headers = {
            "Host": tenant.host_header or f"127.0.0.1:{self.s.hermes_port}",
            "X-Hermes-Session-Token": tenant.token,
        }
        try:
            async with self.http.put(
                url,
                headers=headers,
                json={"key": self.s.key_env_name, "value": api_key},
                timeout=aiohttp.ClientTimeout(total=15),
            ) as response:
                if response.status < 200 or response.status >= 300:
                    await response.text()
                    raise CredentialSyncError(f"Hermes 凭据接口返回 HTTP {response.status}")
        except CredentialSyncError:
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            raise CredentialSyncError(f"Hermes 凭据接口不可达: {type(exc).__name__}") from exc
        self._synced_key_digests[tenant.user_id] = digest

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
        if self.use_cube:
            await self._stop_cube(user_id, reason)
            return
        slug = tenant_slug(user_id)
        async with self._lock(slug):
            cname = self.container_name(slug)
            info = await self.docker.inspect_container(cname)
            if info and info.get("State", {}).get("Running"):
                await self.docker.stop_container(cname)
            await self.store.set_tenant_state(user_id, "stopped")
            await self.store.write_audit(user_id, "tenant.stop", {"reason": reason})

    async def reconcile(self) -> None:
        """入口启动时：把所有租户容器停掉，运行态清成 stopped，之后按需再起。

        ★ 必须在后台跑，不能挡住入口开始监听：停一个容器要一秒多，几十个租户就是
        几十秒的 502 窗口（实测 6 个容器 6.8s，期间 nginx 全部 connection refused）。
        ★ 每个租户都走 ``ensure_running`` 用的同一把锁，否则后台停容器会和这段时间里
        进来的用户请求打架——刚拉起来的容器被 reconcile 一巴掌停掉。
        """
        if self.use_cube:
            await self._reconcile_cube()
            return
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
                    await self.store.set_tenant_state(user_id, "stopped")
        log.info("reconcile: %d tenant container(s) reset", len(containers))

    async def reap_idle(self, keep: set[str] | None = None) -> None:
        """``keep`` = 此刻还挂着 ws 连接的用户，一律不回收。"""
        for user_id in await self.store.idle_tenants(self.s.idle_minutes * 60, exclude=keep):
            try:
                log.info("idle reap: stopping tenant of %s", user_id)
                await self.stop(user_id, reason=f"idle>{self.s.idle_minutes}m")
            except Exception:  # noqa: BLE001
                log.exception("idle reap failed for %s", user_id)
