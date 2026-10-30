"""OAuth returns through Entry, bound to the initiating session and provider.

PKCE, tokens and single-use states remain in the original instance SQLite store.
The encrypted short-lived cookie only binds the browser to that state; no PG table.
"""
import hmac
import json
import time
from urllib.parse import urlsplit

from aiohttp import web
from aiohttp.web_log import AccessLogger

from .crypto import CredentialError

HOSTS = {'qcc_mcp': 'agent.qcc.com', 'eastmoney_mcp': 'mkcs.dfcfs.com', 'ifind_mcp': 'upass.10jqka.com.cn'}


class ConnectorAccessLogger(AccessLogger):
    def log(self, request, response, elapsed):
        if '/__entry/connectors/' in request.path and request.path.endswith('/oauth/callback'):
            self.logger.info('%s "%s %s" %s %.6fs', request.remote, request.method, request.path, response.status, elapsed)
        else:
            super().log(request, response, elapsed)


def callback_base(entry, request, provider):
    scheme = request.headers.get('X-Forwarded-Proto', request.scheme)
    host = request.headers.get('X-Forwarded-Host', request.host)
    origin = urlsplit(scheme + '://' + host)
    if scheme not in {'http', 'https'} or not origin.hostname or origin.username or origin.password or origin.path or origin.query or origin.fragment:
        raise ValueError('Invalid callback origin')
    return scheme + '://' + host + entry.s.base_path + '/__entry/connectors/' + provider


class ConnectorOAuth:
    def __init__(self, routes):
        self.routes = routes
        self.entry = routes.entry

    def started(self, request, session, provider, result, response):
        url = urlsplit(result['authorizationUrl'])
        state = result['state']
        if provider not in HOSTS or url.scheme != 'https' or url.netloc != HOSTS[provider] or url.username or url.password or not isinstance(state, str) or not 1 <= len(state) <= 256:
            raise web.HTTPBadGateway(text='连接器授权地址无效。')
        origin = callback_base(self.entry, request, provider)
        ticket = {'sid': session.sid, 'provider': provider, 'state': state, 'origin': origin, 'expires': time.time() + 900}
        encrypted = self.entry.store.cipher.encrypt(json.dumps(ticket)).decode('ascii')
        response.set_cookie('hermes_connector_oauth_' + provider, encrypted, max_age=900,
            path=self.entry.s.base_path + '/__entry/connectors/' + provider + '/oauth/callback',
            httponly=True, secure=self.entry.s.cookie_secure, samesite='Lax')

    async def callback(self, request):
        provider = request.match_info['provider']
        try:
            session = await self.entry._require(request)
            if provider not in HOSTS:
                raise ValueError()
            encrypted = request.cookies.get('hermes_connector_oauth_' + provider, '')
            ticket = json.loads(self.entry.store.cipher.decrypt(encrypted.encode('ascii')))
            if (ticket['sid'] != session.sid or ticket['provider'] != provider or ticket['expires'] <= time.time()
                    or ticket['origin'] != callback_base(self.entry, request, provider)
                    or not hmac.compare_digest(ticket['state'], request.query.get('state', ''))):
                raise ValueError()
            parameters = dict(request.query)
            if (set(parameters) - {'state', 'code', 'error', 'error_description', 'scope', 'session_state', 'iss'}
                    or len(parameters) != len(request.query) or parameters.get('error') or not parameters.get('code')
                    or any(len(value) > 8192 for value in parameters.values())):
                raise ValueError()
            await self.routes.execute(session, {'operation': 'oauth.complete', 'profile': 'default', 'id': provider,
                'origin': ticket['origin'], 'parameters': parameters})
            message = '授权成功，连接器设置已保存。请返回原页面继续使用。'
            status = 200
        except (web.HTTPException, ValueError, KeyError, TypeError, CredentialError, UnicodeError):
            message = '授权未完成或保存未确认。请返回原页面检查连接状态；可重试保存，或重新发起授权。'
            status = 400
        # Never echo provider errors, codes, state or tokens into the callback page.
        response = web.Response(text='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>连接器授权</title><body><p>' + message + '</p></body></html>',
            status=status, content_type='text/html', headers={'Cache-Control': 'no-store',
                'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"})
        if provider in HOSTS:
            response.del_cookie('hermes_connector_oauth_' + provider,
                path=self.entry.s.base_path + '/__entry/connectors/' + provider + '/oauth/callback')
        return response
