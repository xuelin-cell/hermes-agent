"""Instance-local relay listener. Entry owns dialing and reconnects; never dial out."""
import asyncio
import hmac
import json
import secrets

from aiohttp import web
from gateway.relay.ws_transport import WebSocketRelayTransport
from .media import MAX_WIRE_BYTES

PORT = 9123
PATH = '/__mt/messaging/relay'
CAPABILITY = 'entry-forward-relay-v1'


class AcceptedRelayTransport(WebSocketRelayTransport):
    def __init__(self, settings, descriptor, ledger):
        super().__init__('http://localhost', settings['platform'], settings['bot_id'], reconnect=False,
                         max_message_bytes=MAX_WIRE_BYTES)
        self.settings, self.ledger = settings, ledger
        self._descriptor = descriptor
        self._descriptors_by_platform = {settings['platform']: descriptor}
        self.worker_id = secrets.token_hex(16)
        self.runner = None
        self.admission_ready = False
        self.session_lock = asyncio.Lock()

    def authorized(self, request):
        supplied = request.headers.get('Authorization', '').removeprefix('Bearer ')
        return hmac.compare_digest(supplied.encode(), self.settings['upgrade_secret'].encode())

    async def connect(self):
        self._closing = False
        app = web.Application()
        app.router.add_get('/ready', self.ready)
        app.router.add_get(PATH, self.accept)
        self.runner = web.AppRunner(app, shutdown_timeout=2, access_log=None)
        await self.runner.setup()
        try:
            await web.TCPSite(self.runner, '127.0.0.1', PORT).start()
        except BaseException:
            await self.runner.cleanup()
            raise
        return True

    async def ready(self, request):
        if not self.authorized(request): raise web.HTTPUnauthorized()
        if not self.admission_ready: raise web.HTTPServiceUnavailable()
        return web.json_response({'ok': True, 'capability': CAPABILITY, 'worker_id': self.worker_id})

    def open_admission(self):
        # The worker opens this only after the normal gateway startup queue drains.
        self.admission_ready = True

    async def _send(self, frame):
        if self._ws is None or self._ws.closed: raise RuntimeError('Relay disconnected')
        await self._ws.send_str(json.dumps(frame) + '\n')

    async def accept(self, request):
        if not self.authorized(request): raise web.HTTPUnauthorized()
        if not self.admission_ready: raise web.HTTPServiceUnavailable()
        # One transport owner per worker. A stale reconnect cannot replace a live owner.
        if self.session_lock.locked(): raise web.HTTPConflict()
        async with self.session_lock:
            ws = web.WebSocketResponse(timeout=2, heartbeat=30, max_msg_size=MAX_WIRE_BYTES)
            await ws.prepare(request)
            self._ws = ws
            try:
                await self._send({'type': 'hello', 'platform': self._platform, 'botId': self._bot_id,
                                  'workerId': self.worker_id, 'capability': CAPABILITY})
                async with asyncio.timeout(15):
                    descriptor = await ws.receive_json()
                    if descriptor.get('type') != 'descriptor' or descriptor.get('descriptor', {}).get('platform') != self._platform:
                        raise ValueError('Relay descriptor mismatch')
                await self._send({'type': 'relay_ready', 'workerId': self.worker_id})
                async for message in ws:
                    if message.type != web.WSMsgType.TEXT: break
                    for line in message.data.splitlines():
                        frame = json.loads(line)
                        if frame.get('type') == 'execution_probe':
                            row = self.ledger.get(frame['delivery_id'])
                            if row and (row['binding_id'] != self.settings['binding_id'] or row['revision'] != self.settings['revision']):
                                raise ValueError('Execution binding mismatch')
                            await self._send({'type': 'execution_status', 'delivery_id': frame['delivery_id'],
                                              'workerId': self.worker_id, 'state': row['state'] if row else 'missing'})
                        elif frame.get('type') == 'inbound':
                            source = frame.get('event', {}).get('source', {})
                            if source.get('platform') != self._platform or source.get('scope_id') != self.settings['user_id']:
                                raise ValueError('Inbound identity mismatch')
                            await self._handle_frame(line)
                        else:
                            await self._handle_frame(line)
            finally:
                self._ws = None
                self._fail_pending(lambda future: future.set_result({'success': False, 'error': 'Relay disconnected'}))
                await ws.close()
        return ws

    async def disconnect(self, *, budget_s=None):
        self._closing = True
        self.admission_ready = False
        if self._ws is not None: await self._ws.close()
        if self.runner: await self.runner.cleanup()
        self.runner = None
