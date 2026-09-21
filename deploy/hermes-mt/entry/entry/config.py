"""入口服务配置：全部来自环境变量，没有配置文件。

变量名前缀 ``MT_``。凡是凭据（MT_DEV_API_KEY）只从环境读，绝不落日志。
"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _parse_bytes(text: str) -> int:
    text = text.strip().lower()
    units = {"k": 1024, "m": 1024**2, "g": 1024**3}
    if text and text[-1] in units:
        return int(float(text[:-1]) * units[text[-1]])
    return int(text)


@dataclass(frozen=True)
class Settings:
    # 对外路径与监听
    base_path: str = _env("MT_BASE_PATH", "/hermes").rstrip("/")
    listen_port: int = int(_env("MT_PORT", "9400"))

    # 租户容器
    image: str = _env("MT_IMAGE", "hermes-custom:dev")
    prefix: str = _env("MT_PREFIX", "hermes")  # hermes-t-<uid> / hermes-net-<uid> / hermes-data-<uid>
    docker_sock: str = _env("MT_DOCKER_SOCK", "/var/run/docker.sock")
    self_container: str = _env("MT_SELF_CONTAINER", "")  # 空 = 用主机名（容器短 id）
    memory_bytes: int = _parse_bytes(_env("MT_MEMORY", "2g"))
    nano_cpus: int = int(float(_env("MT_CPUS", "1")) * 1_000_000_000)
    pids_limit: int = int(_env("MT_PIDS", "512"))
    idle_minutes: int = int(_env("MT_IDLE_MINUTES", "30"))
    ready_timeout_s: int = int(_env("MT_READY_TIMEOUT_S", "180"))
    tz: str = _env("MT_TZ", "Asia/Shanghai")
    hermes_port: int = 9120
    forward_port: int = 9121
    files_root: str = _env("MT_FILES_ROOT", "/opt/data/workspace")

    # 会话 cookie
    cookie_name: str = _env("MT_COOKIE", "hermes_mt_session")
    cookie_secure: bool = _env("MT_COOKIE_SECURE", "0") == "1"
    session_ttl_s: int = int(_env("MT_SESSION_TTL_S", str(7 * 24 * 3600)))

    # Entry 平台数据库与凭据加密
    database_url: str = _env("MT_DATABASE_URL")
    db_pool_min_size: int = int(_env("MT_DB_POOL_MIN_SIZE", "1"))
    db_pool_max_size: int = int(_env("MT_DB_POOL_MAX_SIZE", "10"))
    db_command_timeout_s: int = int(_env("MT_DB_COMMAND_TIMEOUT_S", "30"))
    credential_key: str = _env("MT_CREDENTIAL_KEY")
    credential_key_id: str = _env("MT_CREDENTIAL_KEY_ID", "local-v1")

    # MaaS 登录 / 套餐
    maas_app: str = _env("MT_MAAS_APP", "https://maas.ai-yuanjing.com/app").rstrip("/")
    myplan_url: str = _env("MT_MYPLAN_URL", "https://maas.ai-yuanjing.com/app/gateway/uniwork/my-plan")
    login_application: str = _env("MT_LOGIN_APPLICATION", "uniwork")
    upstream_timeout_s: int = int(_env("MT_UPSTREAM_TIMEOUT_S", "15"))

    # 模型（写进每个租户卷的 config.yaml）
    model_base_url: str = _env("MT_MODEL_BASE_URL", "https://maas-api.ai-yuanjing.com/openapi/compatible-mode/v1")
    model_name: str = _env("MT_MODEL", "deepseek-v4-flash")
    provider_key: str = _env("MT_PROVIDER_KEY", "yuanjing")
    key_env_name: str = _env("MT_KEY_ENV_NAME", "HERMES_CUSTOM_YUANJING_API_KEY")

    # 开发模式：不走短信登录，任意用户名直接进；模型 key 用 MT_DEV_API_KEY。生产必须关。
    dev_login: bool = _env("MT_DEV_LOGIN", "0") == "1"
    dev_api_key: str = _env("MT_DEV_API_KEY", "")

    def path(self, suffix: str) -> str:
        return f"{self.base_path}{suffix}"


SETTINGS = Settings()
