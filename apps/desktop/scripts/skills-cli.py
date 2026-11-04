"""macOS 终端入口，只使用当前安装自带的 Python 和账号解析进程。"""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main() -> int:
    """解析账号后在原终端替换为 CLI，保留输入、信号和退出码。"""
    executable, app_path, *arguments = sys.argv[1:]
    environment = dict(os.environ)
    environment.pop("ELECTRON_RUN_AS_NODE", None)
    try:
        with tempfile.TemporaryDirectory(prefix="uniworker-cli-") as directory:
            request = Path(directory) / "request.json"
            request.write_text(json.dumps(arguments, ensure_ascii=False), encoding="utf-8")
            command = [executable, *([app_path] if app_path else []), "--desktop-skills-cli", str(request)]
            resolver = subprocess.run(command, env=environment, stdin=subprocess.DEVNULL,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
            result = json.loads(Path(str(request) + ".result").read_text(encoding="utf-8"))
            if result.get("error"):
                print(result["error"], file=sys.stderr)
                return 1
            if resolver.returncode:
                raise ValueError("resolver failed")
            environment.update(result["env"])
        # 离开临时目录后才 exec，程序退出或被中断均不会留下本次请求。
        os.execve(result["command"], [result["command"], *result["args"]], environment)
    except KeyboardInterrupt:
        return 130
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired):
        print("无法启动账号技能命令，请检查 UniWork 安装和登录状态。", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
