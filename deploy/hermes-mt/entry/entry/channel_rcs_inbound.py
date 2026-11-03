"""Prepare durable 5G attachment references after admission, before instance dispatch."""
import asyncio
import ipaddress
import json
import logging
from pathlib import Path
from urllib.parse import unquote, urlsplit

import aiohttp
from aiohttp.resolver import DefaultResolver

from plugins.cloud_messaging.media import MAX_MEDIA_BYTES, MAX_MESSAGE_BYTES, add_inbound, pack

log = logging.getLogger(__name__)
MEDIA_UNAVAILABLE = '[附件未接收：下载失败、链接失效或文件超出限制，请重新发送。]'


def _public(address):
    if not ipaddress.ip_address(address).is_global:
        raise ValueError('Internal 5G media address')


class _MediaResolver(DefaultResolver):
    async def resolve(self, host, port=0, family=0):
        addresses = await super().resolve(host, port, family)
        for address in addresses:
            _public(address['host'])
        return addresses


def _origin(value):
    return value.scheme, value.hostname, value.port or (443 if value.scheme == 'https' else 80)


async def download(url, gateway, limit=MAX_MEDIA_BYTES):
    """Accept the configured gateway or public HTTP(S) media hosts, without credentials.

    DNS answers are checked at connection time. Other platforms retain their
    existing host allowlist; 5G gateway/CSP URLs do not share those domains.
    """
    target, trusted = urlsplit(url), urlsplit(gateway)
    if (target.scheme not in {'http', 'https'} or not target.hostname or target.username
            or target.password or target.fragment):
        raise ValueError('Invalid 5G media URL')
    gateway_origin = _origin(target) == _origin(trusted)
    if not gateway_origin:
        if target.port not in (None, 80, 443):
            raise ValueError('Invalid 5G media port')
        try:
            address = ipaddress.ip_address(target.hostname)
        except ValueError:
            pass  # Hostnames are checked by the connector's resolver.
        else:
            _public(address)
    resolver = DefaultResolver() if gateway_origin else _MediaResolver()
    try:
        connector = aiohttp.TCPConnector(resolver=resolver, use_dns_cache=False)
        async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=30)) as http:
            async with http.get(url, allow_redirects=False) as response:
                if response.status != 200:
                    raise ValueError('5G attachment unavailable')
                if int(response.headers.get('Content-Length', '0')) > limit:
                    raise ValueError('5G attachment too large')
                data = bytearray()
                async for chunk in response.content.iter_chunked(65536):
                    data.extend(chunk)
                    if len(data) > limit:
                        raise ValueError('5G attachment too large')
                return bytes(data), response.headers.get('Content-Type', '').split(';')[0]
    finally:
        await resolver.close()


async def prepare_inbound(service, row):
    payload = json.loads(row['payload'])
    if '_media_event' in payload:
        return row  # Reuse the frozen result after a disconnect or process restart.
    request = service.protocol.parse_agent_request(payload)
    urls = [item.url for item in request.inputs if item.url]
    if not urls:
        return row
    async with service.database.acquire() as db:
        config = await db.fetchval('SELECT config FROM messaging_bindings WHERE id=$1', row['binding_id'])
    gateway = json.loads(config)['gateway_url']
    attachments = []
    total = 0
    text = request.text
    try:
        # Bound the whole message as well as each individual HTTP request.
        async with asyncio.timeout(60):
            for url in urls[:20]:
                try:
                    data, mime = await download(url, gateway, min(MAX_MEDIA_BYTES, MAX_MESSAGE_BYTES - total))
                    filename = unquote(Path(urlsplit(url).path).name) or 'attachment.bin'
                    kind = {'image': 'image', 'audio': 'audio', 'video': 'video'}.get(mime.split('/')[0], 'file')
                    attachments.append(pack(data, filename, kind, mime or None))
                    total += len(data)
                except (ValueError, OSError, aiohttp.ClientError) as error:
                    log.warning('5G inbound attachment unavailable: %s', type(error).__name__)
                    text += '\n' + MEDIA_UNAVAILABLE
            if len(urls) > 20:
                text += '\n[附件未接收：单条消息最多接收 20 个附件，请分开发送。]'
    except TimeoutError:
        text += '\n[附件下载超时，请重新发送；本条文字已保留。]'
    payload['_media_event'] = add_inbound({'text': text.strip(), 'source': {
        'platform': 'uniagentgate', 'chat_id': request.phone_number,
        'user_id': request.phone_number, 'chat_type': 'dm'}}, attachments)
    encoded = json.dumps(payload)
    async with service.database.acquire() as db:
        updated = await db.fetchval("""UPDATE messaging_inbox SET payload=$3::jsonb,updated_at=now()
            WHERE delivery_id=$1 AND lease_owner=$2 AND state='dispatching' AND lease_until>now()
            RETURNING delivery_id""", row['delivery_id'], service.owner, encoded)
    if not updated:
        raise RuntimeError('Delivery lease lost during media preparation')
    return dict(row, payload=encoded)
