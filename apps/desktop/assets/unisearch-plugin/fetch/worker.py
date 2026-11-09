"""One request per scoped worker; always closes its browser and driver."""

from __future__ import annotations
import asyncio
import importlib.util
import json
from pathlib import Path
import signal
import sys
import time


# 子进程绑定明确Home，一次请求结束后总是关闭浏览器资源。
async def run():
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location(
        "_unisearch_worker",
        root / "__init__.py",
        submodule_search_locations=[str(root)],
    )
    package = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = package
    spec.loader.exec_module(package)
    from _unisearch_worker.fetch.builtin_parse import (
        BuiltinParseFetchProvider,
        WebAPIError,
    )

    request = json.load(sys.stdin)
    # 同机单调时钟包括排队和启动耗时，不能在子进程重新领取完整预算。
    deadline = float(request.get("deadline", time.monotonic() + 110))
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Builtin budget exhausted before extraction")
    provider = BuiltinParseFetchProvider(
        timeout=remaining,
        allowed_hosts=request["allowed_hosts"],
        blocked_hosts=request["blocked_hosts"],
    )
    task = asyncio.current_task()
    loop = asyncio.get_running_loop()
    if sys.platform != "win32":
        loop.add_signal_handler(signal.SIGTERM, task.cancel)
    try:
        result = await provider.fetch(request["url"])
        print(
            json.dumps(
                {
                    "url": result.url,
                    "title": result.title or "",
                    "content": result.content,
                    "raw_content": result.content,
                    "metadata": {"links": result.links},
                    "fetch_status": result.fetch_status,
                    "engine": result.engine,
                    "reasons": list(result.reasons),
                },
                ensure_ascii=False,
            )
        )
    except WebAPIError as exc:
        print(
            json.dumps(
                {
                    "url": request["url"],
                    "title": "",
                    "content": "",
                    "error": "未取得可用网页正文",
                    "fetch_status": "unavailable",
                    "reasons": [exc.reason],
                },
                ensure_ascii=False,
            )
        )
    finally:
        # 输出完成后仍有界回收，父进程保留硬截止与强制回收。
        try:
            async with asyncio.timeout(
                min(2.0, max(0.05, deadline - time.monotonic()))
            ):
                await provider.aclose()
        except TimeoutError:
            pass


if __name__ == "__main__":
    asyncio.run(run())
