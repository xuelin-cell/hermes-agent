"""Run the normal gateway turn engine without a second cron ticker or auto-resume.

The instance's existing serve process owns cron. Durable IM execution admission
and frozen result replay belong to the relay adapter's ledger.
"""
import asyncio
import signal
import os
import sys


def bind_parent():
    from hermes_platform.host.facts import os_family
    if os_family() == "linux":
        import ctypes
        parent = int(sys.argv[1])
        if ctypes.CDLL(None).prctl(1, signal.SIGTERM, 0, 0, 0) != 0:
            raise RuntimeError("Cannot bind gateway to its forwarder")
        if os.getppid() != parent:
            raise SystemExit(75)


if __name__ == "__main__":
    bind_parent()

from gateway.run import GatewayRunner


class MessagingRunner(GatewayRunner):
    async def _deliver_platform_notice(self, source, content):
        # This worker has a fixed binding and does not own cron/home-channel setup.
        # Setup notices must not freeze the one final execution receipt before the Agent replies.
        return

    async def _finish_startup_restore(self):
        await super()._finish_startup_restore()
        for adapter in self.adapters.values():
            # Plugin loading uses its own module names; class identity is not stable.
            open_admission = getattr(getattr(adapter,'_transport',None),'open_admission',None)
            if callable(open_admission): open_admission()

    def _schedule_resume_pending_sessions(self, platform=None):
        # An interrupted tool may already have changed the outside world. Only a
        # fresh platform message can request another execution; receipts replay separately.
        return 0


async def main():
    import fcntl
    from hermes_constants import get_hermes_home
    from hermes_logging import setup_logging
    setup_logging(hermes_home=get_hermes_home(),mode='gateway')
    lock = (get_hermes_home() / 'cloud-messaging.lock').open('a')
    try:
        fcntl.flock(lock,fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit(75)
    os.environ['HERMES_EXEC_ASK'] = '1'
    runner = MessagingRunner()
    runner.config.streaming.enabled = False
    from hermes_cli.config import read_user_config_raw
    active = read_user_config_raw()['cloud_messaging']['platform']
    runner.config.platforms = {key: value for key, value in runner.config.platforms.items() if str(getattr(key, 'value', key)) == active}
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, lambda: asyncio.create_task(runner.stop()))
    try:
        # Same startup discovery as `gateway run`, before a session freezes its tool catalog.
        from gateway.run import _discover_gateway_mcp_tools
        try:
            await _discover_gateway_mcp_tools(runner.config)
        except Exception:
            import logging
            logging.getLogger(__name__).exception('Cloud messaging MCP discovery failed')
        if not await runner.start():
            raise RuntimeError('Messaging gateway could not start')
        await runner.wait_for_shutdown()
    finally:
        from gateway.run import _shutdown_mcp_servers_nonblocking
        await _shutdown_mcp_servers_nonblocking(config=runner.config)


if __name__ == '__main__':
    asyncio.run(main())
