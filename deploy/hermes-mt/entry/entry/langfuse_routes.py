"""Upload-only capabilities keep MaaS credentials outside Agent instances."""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from urllib.parse import urlsplit

import aiohttp
from aiohttp import web
from .langfuse_config import upload_url

MAX_UPLOAD = 16 * 1024 * 1024
MAX_AUTHORIZATIONS = 1024
TRACE_PATH = '/api/public/otel/v1/traces'


@dataclass
class UserAuthorization:
    token: str = field(repr=False)
    expires_at: int  # milliseconds; independent of browser session lifetime


class LangfuseRoutes:
    def __init__(self, entry):
        self.entry = entry
        self.authorizations: dict[str, UserAuthorization] = {}
        self.uploads = asyncio.Semaphore(4)
        self.base_url = entry.s.langfuse_gateway_url.rstrip('/') if entry.s.langfuse_entry_url else ''
        upload_url(entry.s)
        if self.base_url:
            parsed = urlsplit(self.base_url)
            _ = parsed.port
            if (parsed.scheme != 'https' or not parsed.hostname or parsed.username
                    or parsed.password or parsed.query or parsed.fragment
                    or '%' in parsed.path or '\\' in self.base_url
                    or any(part in {'.', '..'} for part in parsed.path.split('/'))):
                raise ValueError('Langfuse gateway must be an HTTPS service root')

    def purge(self):
        now = time.time()
        for key, identity in list(self.authorizations.items()):
            if identity.expires_at <= now * 1000:
                self.authorizations.pop(key, None)

    def remember(self, user_id: str, token: str, expires_at: int) -> bool:
        """Accept only credentials from Entry login or verified browser binding."""
        if not self.base_url:
            return False
        self.purge()
        if (not user_id or not token or expires_at <= time.time() * 1000
                or (user_id not in self.authorizations and len(self.authorizations) >= MAX_AUTHORIZATIONS)):
            return False
        current = self.authorizations.get(user_id)
        if current is not None and current.token == token:
            # A browser proof can expire sooner than the upstream JWT already
            # seen at login. Re-reading that same JWT must not shorten its life.
            expires_at = max(current.expires_at, expires_at)
        self.authorizations[user_id] = UserAuthorization(token, expires_at)
        return True

    def close(self):
        self.authorizations.clear()

    async def authorize(self, user_id):
        if not await self.entry.store.is_user_active(user_id):
            raise web.HTTPUnauthorized(text='tracing_account_unavailable')
        identity = self.authorizations.get(user_id)
        if identity is None or identity.expires_at <= time.time() * 1000:
            raise web.HTTPUnauthorized(text='tracing_login_required')
        return identity

    async def issue(self, request):
        identity = await self.entry._require_maas(request)
        if not self.base_url:
            raise web.HTTPServiceUnavailable(text='tracing_not_configured')
        if not self.remember(identity.user_id, identity.token, identity.expires_at):
            raise web.HTTPServiceUnavailable(text='tracing_authorization_limit')
        credential = await self.entry.store.ensure_langfuse_credentials(identity.user_id)
        return web.json_response({
            'public_key': credential.public_key, 'secret_key': credential.secret_key,
            'base_path': self.entry.s.api_path('/__entry/langfuse'),
        }, headers={'Cache-Control': 'no-store'})

    async def upload(self, request):
        if not self.base_url or self.entry.http is None:
            raise web.HTTPServiceUnavailable(text='tracing_not_configured')
        # Match the unmodified Langfuse SDK's Basic auth, not a browser JWT.
        try:
            auth = aiohttp.BasicAuth.decode(request.headers.get('Authorization', ''))
        except ValueError:
            raise web.HTTPUnauthorized(text='tracing_credentials_required') from None
        user_id = await self.entry.store.langfuse_upload_user(auth.login, auth.password)
        if user_id is None:
            raise web.HTTPUnauthorized(text='tracing_credentials_invalid')
        await self.authorize(user_id)
        if request.query_string or request.content_type not in {'application/x-protobuf', 'application/json'}:
            raise web.HTTPBadRequest(text='invalid_tracing_request')
        if self.uploads.locked():
            raise web.HTTPTooManyRequests(text='tracing_busy')
        async with self.uploads:
            body = bytearray()
            async for chunk in request.content.iter_chunked(64 * 1024):
                if len(body) + len(chunk) > MAX_UPLOAD:
                    raise web.HTTPRequestEntityTooLarge(max_size=MAX_UPLOAD, actual_size=len(body) + len(chunk))
                body.extend(chunk)
            # Account status and cached JWT can change during receipt.
            identity = await self.authorize(user_id)
            headers = {'Authorization': 'Bearer ' + identity.token,
                       'Content-Type': request.content_type,
                       'x-langfuse-sdk-name': 'python'}
            # Preserve SDK protocol negotiation without forwarding caller auth
            # or arbitrary headers into the JWT-verifying gateway.
            for name in ('x-langfuse-ingestion-version', 'x-langfuse-sdk-version'):
                if name in request.headers:
                    headers[name] = request.headers[name]
            try:
                async with self.entry.http.post(
                    self.base_url + TRACE_PATH,
                    data=bytes(body),
                    headers=headers,
                    allow_redirects=False, timeout=aiohttp.ClientTimeout(total=10),
                ) as response:
                    # aiohttp decoded incoming Content-Encoding already; forward
                    # decoded protobuf/JSON without the old compression header.
                    if 200 <= response.status < 300:
                        result = bytearray()
                        async for chunk in response.content.iter_chunked(16 * 1024):
                            if len(result) + len(chunk) > 64 * 1024:
                                raise web.HTTPBadGateway(text='tracing_gateway_response_invalid')
                            result.extend(chunk)
                        return web.Response(body=bytes(result), status=response.status,
                                            headers={'Content-Type': response.headers.get('Content-Type', 'application/x-protobuf'),
                                                     'Cache-Control': 'no-store'})
                    status = response.status if response.status in {400, 401, 403, 413, 429, 500, 502, 503, 504} else 502
                    # Gateway error pages can echo credentials. Never relay them.
                    return web.json_response({'error': 'tracing_gateway_rejected'}, status=status,
                                             headers={'Cache-Control': 'no-store'})
            except (aiohttp.ClientError, asyncio.TimeoutError):
                raise web.HTTPServiceUnavailable(text='tracing_gateway_unavailable') from None
