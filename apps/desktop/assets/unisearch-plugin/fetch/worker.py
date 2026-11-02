"""One request per scoped worker; always closes its browser and driver."""

from __future__ import annotations
import asyncio
import importlib.util
import json
from pathlib import Path
import signal
import sys


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
    from _unisearch_worker.fetch.builtin_parse import BuiltinParseFetchProvider

    request = json.load(sys.stdin)
    provider = BuiltinParseFetchProvider(
        timeout=110,
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
                },
                ensure_ascii=False,
            )
        )
    finally:
        await provider.aclose()


if __name__ == "__main__":
    asyncio.run(run())
