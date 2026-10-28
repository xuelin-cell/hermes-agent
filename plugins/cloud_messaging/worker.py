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
    def _schedule_resume_pending_sessions(self, platform=None):
        # An interrupted tool may already have changed the outside world. Only a
        # fresh platform message can request another execution; receipts replay separately.
        return 0


async def main():
    import fcntl
    from hermes_constants import get_hermes_home
    lock = (get_hermes_home() / 'cloud-messaging.lock').open('a')
    try:
        fcntl.flock(lock,fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit(75)
    os.environ['HERMES_EXEC_ASK'] = '1'
    runner = MessagingRunner()
    runner.config.streaming.enabled = False
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, lambda: asyncio.create_task(runner.stop()))
    if not await runner.start():
        raise RuntimeError('Messaging gateway could not start')
    await runner.wait_for_shutdown()


if __name__ == '__main__':
    asyncio.run(main())
