"""WeCom smart-bot QR binding for the cloud connector page.

Same upstream flow as the desktop (apps/desktop/electron/open-connector/wecom-qr.ts) and
UniClaw (channels/wecom/qr_auth.py): request a QR session, let the user scan it in WeCom,
then poll until WeCom returns the new bot's ID and secret. Entry plays the desktop main
process: the secret goes straight to the instance's connector service and never reaches
the browser, which only receives the QR link to render.
"""
import time
import uuid
from urllib.parse import quote, urlsplit

import aiohttp

GENERATE_URL = 'https://work.weixin.qq.com/ai/qc/generate?source=wecom_cli_external&plat=3'
QUERY_URL = 'https://work.weixin.qq.com/ai/qc/query_result?scode='
SESSION_TTL_S = 300
REQUEST_TIMEOUT_S = 15


class WecomQrError(Exception):
    """User-facing failure; the message is safe to show."""


class WecomQrSessions:
    def __init__(self, entry):
        self.entry = entry
        self.sessions = {}

    async def start(self, user, profile):
        self.cancel(user)
        data = await self._get(GENERATE_URL)
        scode, link = data.get('scode'), data.get('auth_url')
        if not isinstance(scode, str) or not scode or not isinstance(link, str):
            raise WecomQrError('企业微信未返回有效二维码。')
        url = urlsplit(link)
        if url.scheme != 'https' or url.hostname != 'work.weixin.qq.com' or url.username or url.password:
            raise WecomQrError('企业微信返回的二维码地址无效。')
        session_id = uuid.uuid4().hex
        self.sessions[session_id] = {'user': user, 'profile': profile, 'scode': scode,
                                     'expires': time.monotonic() + SESSION_TTL_S}
        return {'sessionId': session_id, 'qrState': 'pending', 'authUrl': link}

    async def poll(self, user, profile, session_id):
        """Returns (result, values); values carries the bot credentials once confirmed."""
        session = self.sessions.get(session_id)
        if not session or session['user'] != user or session['profile'] != profile:
            raise WecomQrError('扫码会话已失效，请刷新二维码。')
        if time.monotonic() > session['expires']:
            self.sessions.pop(session_id, None)
            return {'sessionId': session_id, 'qrState': 'expired'}, None
        data = await self._get(QUERY_URL + quote(session['scode'], safe=''))
        if self.sessions.get(session_id) is not session:
            raise WecomQrError('扫码会话已取消。')
        status = str(data.get('status') or '').lower()
        if status in {'expired', 'timeout', 'cancelled', 'canceled'}:
            self.sessions.pop(session_id, None)
            return {'sessionId': session_id, 'qrState': 'expired'}, None
        if status == 'success':
            info = data.get('bot_info') if isinstance(data.get('bot_info'), dict) else {}
            bot_id, secret = info.get('botid'), info.get('secret')
            if not isinstance(bot_id, str) or not bot_id or not isinstance(secret, str) or not secret:
                raise WecomQrError('扫码成功，但企业微信未返回机器人信息。')
            self.sessions.pop(session_id, None)
            return {'sessionId': session_id, 'qrState': 'confirmed'}, {'botId': bot_id, 'secret': secret}
        return {'sessionId': session_id, 'qrState': 'scanned' if status == 'scanned' else 'pending'}, None

    def cancel(self, user):
        now = time.monotonic()
        for key, session in list(self.sessions.items()):
            if session['user'] == user or session['expires'] < now:
                self.sessions.pop(key, None)

    async def _get(self, url):
        try:
            async with self.entry.http.get(url, allow_redirects=False,
                                           timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT_S)) as response:
                if response.status != 200:
                    raise WecomQrError(f'企业微信授权服务返回 HTTP {response.status}。')
                payload = await response.json(content_type=None)
        except (aiohttp.ClientError, TimeoutError, ValueError):
            raise WecomQrError('无法连接企业微信授权服务，请检查实例入口的网络。') from None
        if not isinstance(payload, dict) or not isinstance(payload.get('data'), dict):
            raise WecomQrError('企业微信授权服务返回格式异常。')
        return payload['data']
