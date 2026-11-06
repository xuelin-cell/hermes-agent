"""桌面账号的单助手网关入口；启动与停机仍由原版网关负责。"""
import asyncio
import os
from pathlib import Path
import sys


def main() -> None:
    """按安装根引导运行时，注入单助手配置，完成原版收尾后退出。"""
    for name in ("PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV"):
        os.environ.pop(name, None)
    # 安装包的插件资源与后端代码分开放置，代码根必须由可信启动方传入。
    sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
    # 与原版命令行入口一致：后台无窗口进程查询系统版本时不弹黑框；HERMES_HOME 里的 ~ 和 $变量先展开再读取。
    from hermes_cli import _startup_fast
    from hermes_cli._subprocess_compat import suppress_platform_ver_console

    suppress_platform_ver_console()
    _startup_fast.normalize_hermes_home_env()
    from hermes_constants import get_default_hermes_root

    os.environ["HERMES_HOME"] = os.environ.get("HERMES_HOME") or str(get_default_hermes_root())
    import hermes_bootstrap  # noqa: F401 — 原版依赖与标准流引导。
    from gateway.config import load_gateway_config
    from gateway.run import _exit_after_graceful_shutdown, start_gateway
    from hermes_cli.boot_bootstrap import maybe_run_boot_bootstrap
    from hermes_cli.gateway import (
        _absorb_windows_console_controls,
        _apply_startup_watchdog_config,
        _respawn_storm_backoff,
        _windows_gateway_should_absorb_console_controls,
    )
    from pm.paths import install_root

    maybe_run_boot_bootstrap(install_root())
    config = load_gateway_config()
    config.multiplex_profiles = False
    if _windows_gateway_should_absorb_console_controls():
        _absorb_windows_console_controls()
    _apply_startup_watchdog_config()
    _respawn_storm_backoff()
    try:
        success = asyncio.run(start_gateway(config=config))
        code = 0 if success else 1
    except KeyboardInterrupt:
        code = 0
    except SystemExit as exc:
        code = 0 if exc.code is None else exc.code if isinstance(exc.code, int) else 1
    _exit_after_graceful_shutdown(code)


if __name__ == "__main__":
    main()
