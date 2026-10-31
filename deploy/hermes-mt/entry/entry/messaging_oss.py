"""5G attachments use the same Yuanjing OSS upload/explicit-public-confirm flow as UniClaw."""
import asyncio
import json
import re
from collections import OrderedDict
import hashlib
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit, unquote

import aiohttp

from .store import Store
from plugins.cloud_messaging.media import unpack


class OssUploadFailed(RuntimeError):
    pass


def object_url(value, *, public=False):
    """Only the existing platform OSS receives file bytes; never forward MCP/user credentials."""
    parsed = urlsplit(value)
    allowed = {'obs-nmhhht6.cucloud.cn'} if public else {'obs-nmhhht6.cucloud.cn', 'obs-nmhhht6-internal.cucloud.cn'}
    if (parsed.hostname not in allowed or parsed.scheme not in ({'https'} if public else {'http', 'https'})
            or parsed.username or parsed.password or parsed.fragment or parsed.port not in (None, 80, 443)
            or not unquote(parsed.path).startswith('/app-agent-prod/') or '..' in unquote(parsed.path).split('/')):
        raise OssUploadFailed('Invalid OSS object address')
    return value


def fields(result):
    if result.is_error:
        raise OssUploadFailed('OSS tool rejected upload')
    data = result.structured_content or {}
    if isinstance(data.get('data'), dict): data = data['data']
    text = '\n'.join(getattr(block, 'text', '') for block in result.content)
    # MCP currently returns human-readable Chinese summaries; older versions use structured JSON.
    try:
        decoded = json.loads(text)
        if isinstance(decoded, dict):
            data = decoded.get('data', decoded)
    except ValueError:
        pass
    if not isinstance(data, dict): data = {}
    for key, label in (('uploadUrl', '上传地址'), ('downloadUrl', '下载链接'), ('ossPath', 'ossPath')):
        if key not in data:
            match = re.search(r'(?:'+label+r'|'+key+r')[^：:\n]{0,16}[：:]\s*["\']?([^\s"\'<>]+)', text)
            if match: data[key] = match.group(1)
    return data


class MessagingOss:
    def __init__(self, service):
        self.service = service
        self.objects = OrderedDict()
        self.slots = asyncio.Semaphore(3)

    async def public_url(self, user, item):
        try:
            async with self.slots, asyncio.timeout(180):
                return await self._upload(user, item)
        except Exception:
            # No downlink has been attempted. Do not expose keys, presigned URLs or tool errors.
            raise OssUploadFailed('OSS attachment upload failed') from None

    async def _upload(self, user, item):
        from mcp import ClientSession
        from mcp.client.streamable_http import streamable_http_client
        service = self.service
        account = await Store(service.database, service.store.cipher).get_tenant_context(user)
        if not account.api_key or not service.s.yuanjing_mcp_url:
            raise OssUploadFailed('User OSS authorization unavailable')
        parsed = urlsplit(service.s.yuanjing_mcp_url)
        query = dict(parse_qsl(parsed.query))
        query.update(key=account.api_key, client_id=service.s.yuanjing_mcp_client_id, oss_mode=service.s.yuanjing_mcp_oss_mode)
        endpoint = urlunsplit(parsed._replace(query=urlencode(query)))
        raw = unpack(item)
        cache_key = (user, hashlib.sha256(account.api_key.encode()).digest(), hashlib.sha256(raw).digest())
        # Scope the connection and upload cache to this user/key; refresh the signed URL on every send.
        async with streamable_http_client(endpoint) as (read, write), ClientSession(read, write) as mcp:
            await mcp.initialize()
            oss_path = self.objects.get(cache_key)
            if oss_path is None:
                target = fields(await mcp.call_tool('get_oss_upload_url', {'fileName': item['name']}))
                url = object_url(target.get('uploadUrl', ''))
                oss_path = target.get('ossPath') or unquote(urlsplit(url).path).lstrip('/')
                headers = target.get('headers') or {}
                content_type = headers.get('Content-Type', item['mime']) if isinstance(headers, dict) else item['mime']
                async with service.http.put(url, data=raw, headers={'Content-Type':content_type},
                        allow_redirects=False, timeout=aiohttp.ClientTimeout(total=90)) as response:
                    if not 200 <= response.status < 300: raise OssUploadFailed('OSS PUT rejected')
                if not isinstance(oss_path,str) or not oss_path.startswith('app-agent-prod/') or '..' in oss_path.split('/'):
                    raise OssUploadFailed('Invalid OSS object path')
                self.objects[cache_key] = oss_path
                if len(self.objects)>256: self.objects.popitem(last=False)
            self.objects.move_to_end(cache_key)
            confirmed = fields(await mcp.call_tool('confirm_oss_upload', {'ossPath':oss_path, 'usePublic':True}))
            return object_url(confirmed.get('downloadUrl',''), public=True)
