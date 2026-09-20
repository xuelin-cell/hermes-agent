"""租户容器内的 TCP 转发器：0.0.0.0:9121 -> 127.0.0.1:9120。

为什么存在：hermes 的 dashboard 绑非 loopback 地址就会强制开鉴权门（``--insecure`` 已失效），
门开后 ws 只认 30 秒单次票据，而浏览器版前端不会去要票据。所以 hermes 继续绑 127.0.0.1，
入口服务从 bridge 网络连到这个转发器，hermes 看到的对端仍然是 127.0.0.1，门关着。

只用标准库；由容器 CMD 以 hermes 用户启动；出错不重启（容器整体由入口管）。
"""

import asyncio
import os

LISTEN_PORT = int(os.environ.get("MT_FWD_PORT", "9121"))
TARGET_PORT = int(os.environ.get("MT_HERMES_PORT", "9120"))
CHUNK = 64 * 1024


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while True:
            data = await reader.read(CHUNK)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except Exception:  # noqa: BLE001 — 任一端断开都结束
        pass
    finally:
        try:
            writer.close()
        except Exception:  # noqa: BLE001
            pass


async def _handle(client_r: asyncio.StreamReader, client_w: asyncio.StreamWriter) -> None:
    try:
        target_r, target_w = await asyncio.open_connection("127.0.0.1", TARGET_PORT)
    except Exception:  # noqa: BLE001 — hermes 还没起来
        client_w.close()
        return
    await asyncio.gather(_pipe(client_r, target_w), _pipe(target_r, client_w))


async def main() -> None:
    server = await asyncio.start_server(_handle, "0.0.0.0", LISTEN_PORT)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
