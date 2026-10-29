"""Entry-owned, cookie-scoped QR login; bot credentials never enter the browser."""
import asyncio
import secrets
import time
from urllib.parse import quote

from aiohttp import web
from .channel_weixin import BASE_URL, api, trusted_origin


class WeixinQr:
    def __init__(self,routes):
        self.routes=routes
        self.sessions={}
        self.locks={}

    async def handle(self,user,operation,data):
        lock=self.locks.setdefault(user,asyncio.Lock())
        if operation=='weixin-start':
            async with lock:
                self.sessions.pop(user,None)
                result=await api(self.routes.entry.http,BASE_URL,'ilink/bot/get_bot_qrcode?bot_type=3')
                if not result.get('qrcode') or not result.get('qrcode_img_content'):
                    raise web.HTTPBadGateway(text='微信未返回二维码，请重试。')
                row={'session_id':secrets.token_hex(16),'state':'wait','qr_content':result['qrcode_img_content'],
                    'message':'等待微信扫码确认。','qrcode':result['qrcode'],'origin':BASE_URL,'expires':time.monotonic()+300}
                self.sessions[user]=row
        elif operation=='weixin-unbind':
            async with lock:
                self.sessions.pop(user,None)
                if await self.routes.store.binding(user,'weixin'):
                    await self.routes.store.set_enabled(user,False,remove=True,platform='weixin')
            return {'ok':True,'restart_started':True}
        else:
            row=self.sessions.get(user)
            if not row or row['session_id']!=data.get('session_id'):
                raise web.HTTPNotFound(text='二维码已失效，请重新扫码。')
            if row['expires']<time.monotonic(): row['state']='expired'
            if row['state'] in ('wait','scanned'):
                # No lock during long poll: unbind/new QR can fence this confirmation.
                result=await api(self.routes.entry.http,row['origin'],
                    'ilink/bot/get_qrcode_status?qrcode='+quote(row['qrcode'],safe=''))
                async with lock:
                    if self.sessions.get(user) is not row:
                        raise web.HTTPConflict(text='扫码操作已取消。')
                    if row['state']=='confirmed':
                        return {key:value for key,value in row.items() if key in {'session_id','state','qr_content','message','restart_started'}}
                    if row['expires']<time.monotonic():
                        row['state']='expired'
                    elif result.get('status')=='confirmed':
                        bot,token=result.get('ilink_bot_id'),result.get('bot_token')
                        origin=trusted_origin(result.get('baseurl') or BASE_URL)
                        if not isinstance(bot,str) or not bot or not isinstance(token,str) or not token:
                            raise web.HTTPBadGateway(text='微信凭据不完整，请重新扫码。')
                        await self.routes.store.configure(user,origin,bot,token,platform='weixin')
                        await self.routes.store.set_enabled(user,True,platform='weixin')
                        row.update(state='confirmed',message='微信配置已保存，正在连接。',restart_started=True)
                    elif result.get('status')=='scaned_but_redirect':
                        row['origin']=trusted_origin('https://'+str(result.get('redirect_host','')))
                        row['state']='scanned'
                    else:
                        row['state']={'scaned':'scanned','expired':'expired'}.get(result.get('status'),'wait')
        # Bound memory to active/just-finished logins; no upstream tokens in responses.
        for owner,item in list(self.sessions.items()):
            if item['expires']+600<time.monotonic(): self.sessions.pop(owner,None)
        return {key:value for key,value in row.items() if key in {'session_id','state','qr_content','message','restart_started'}}
