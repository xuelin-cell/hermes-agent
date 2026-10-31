"""WeCom Bot WebSocket text transport, using the existing adapter's wire contract."""
import asyncio
import base64
import hashlib
import json
import secrets
import time
from types import SimpleNamespace

import aiohttp
from .channel_dingtalk import ReplyRejected
from .channel_media import download,decrypt,pack,unpack,add_inbound,MEDIA_UNAVAILABLE
from plugins.cloud_messaging.media import MAX_WIRE_BYTES

WS_URL='wss://openws.work.weixin.qq.com'
CALLBACKS={'aibot_msg_callback','aibot_callback'}


class WeCom:
    def __init__(self,bot,secret,store,binding,http):
        self.bot,self.secret,self.store,self.binding,self.http=bot,secret,store,binding,http
        self.state='starting'
        self.task=None
        self.ws=None
        self.pending={}
        self.generation=''
        self.kicked=False

    @property
    def health(self): return SimpleNamespace(state=self.state)

    async def start(self): self.task=asyncio.create_task(self.run())

    async def stop(self):
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task,return_exceptions=True)

    async def heartbeat(self,ws):
        while True:
            await asyncio.sleep(30)
            await ws.send_json({'cmd':'ping','headers':{'req_id':'ping_'+secrets.token_hex(8)},'body':{}})

    async def receive(self,frame):
        req_id=(frame.get('headers') or {}).get('req_id')
        cmd=frame.get('cmd')
        if cmd not in CALLBACKS and cmd!='aibot_event_callback':
            future=self.pending.get(req_id)
            if future and not future.done(): future.set_result(frame)
            return
        body=frame.get('body') or {}
        if cmd=='aibot_event_callback':
            if body.get('event_type')=='disconnected_event':
                self.kicked=True
                await self.ws.close()
            return
        if body.get('msgtype') not in {'text','mixed','image','file','voice','audio','appmsg','video'}: return
        sender=str((body.get('from') or {}).get('userid') or '')
        chat=str(body.get('chatid') or sender)
        message_id=str(body.get('msgid') or req_id or '')
        if await self.store.seen(self.binding['id'],self.binding['revision'],chat,message_id): return
        text=str((body.get('text') or {}).get('content') or '').strip()
        text=text or str((body.get('voice') or {}).get('content') or '')
        try: attachments,extra_text=await self.attachments(body)
        except ValueError: attachments,extra_text=[],MEDIA_UNAVAILABLE
        text=(text+'\n'+extra_text).strip()
        if not text and not attachments: return
        if not all((sender,chat,message_id,req_id)) or len(text)>20000: raise ValueError('Invalid callback')
        event=add_inbound({'text':text,'message_id':message_id,'source':{'platform':'wecom','chat_id':chat,'user_id':sender,'chat_type':'group' if body.get('chattype')=='group' else 'dm'}},attachments)
        context={'req_id':req_id,'generation':self.generation,'expires':time.time()+330,'stream_id':'stream_'+secrets.token_hex(12)}
        await self.store.ingest(self.binding['id'],self.binding['revision'],chat,message_id,
            {'event':event,'reply_enc':self.store.cipher.encrypt(json.dumps(context)).decode()})

    async def run(self):
        delay=1
        while not self.kicked:
            try:
                async with self.http.ws_connect(WS_URL,heartbeat=60,timeout=15,max_msg_size=MAX_WIRE_BYTES) as ws:
                    self.ws=ws
                    self.generation=secrets.token_hex(16)
                    req_id='subscribe_'+self.generation
                    await ws.send_json({'cmd':'aibot_subscribe','headers':{'req_id':req_id},'body':{'bot_id':self.bot,'secret':self.secret,'device_id':self.binding['id']}})
                    async with asyncio.timeout(15):
                        while True:
                            message=await ws.receive()
                            if message.type!=aiohttp.WSMsgType.TEXT: raise RuntimeError('Subscription closed')
                            frame=json.loads(message.data)
                            if (frame.get('headers') or {}).get('req_id')==req_id:
                                if frame.get('errcode',0) not in (0,None): raise ReplyRejected('Subscription rejected')
                                break
                    self.state='running'
                    delay=1
                    heartbeat=asyncio.create_task(self.heartbeat(ws))
                    try:
                        async for message in ws:
                            if message.type!=aiohttp.WSMsgType.TEXT: break
                            await self.receive(json.loads(message.data))
                    finally:
                        heartbeat.cancel()
                        await asyncio.gather(heartbeat,return_exceptions=True)
            except asyncio.CancelledError: raise
            except Exception: self.state='failed'
            finally:
                self.ws=None
                self.state='failed'
                for future in self.pending.values():
                    if not future.done(): future.set_exception(RuntimeError('Connection lost'))
            if not self.kicked:
                await asyncio.sleep(delay)
                delay=min(delay*2,60)

    async def send(self,payload,text):
        context=json.loads(self.store.cipher.decrypt(payload['reply_enc'].encode()))
        if payload.get('_cloud_notification'):
            return await self.request('aibot_send_msg', {'chatid':payload['_cloud_notification']['chat'], 'msgtype':'markdown','markdown':{'content':text}})
        if context['generation']!=self.generation or time.time()>=context['expires']:
            raise ReplyRejected('Reply window expired; send a new message')
        if len(text.encode())>20480: raise ReplyRejected('Reply exceeds WeCom text limit')
        if not self.ws or self.ws.closed: raise ReplyRejected('Connection unavailable')
        req_id=context['req_id']
        if req_id in self.pending: raise ReplyRejected('Reply already in flight')
        future=asyncio.get_running_loop().create_future()
        self.pending[req_id]=future
        try:
            await self.ws.send_json({'cmd':'aibot_respond_msg','headers':{'req_id':req_id},'body':{
                'msgtype':'stream','stream':{'id':context['stream_id'],'finish':True,'content':text}}})
            result=await asyncio.wait_for(future,15)
            body=result.get('body') or {}
            if result.get('errcode',body.get('errcode',0)) not in (0,None): raise ReplyRejected('Reply rejected')
            return {'ok':True}
        finally:
            self.pending.pop(req_id,None)
            if not future.done(): future.cancel()

    async def attachments(self,body):
        references=[]
        texts=[]
        items=(body.get('mixed') or {}).get('msg_item') or [body.get('appmsg') or body]
        for item in items:
            if body.get('msgtype')=='mixed' and item.get('msgtype')=='text': texts.append(str((item.get('text') or {}).get('content') or ''))
            for key,kind,name in (('image','image','image.jpg'),('file','file','attachment.bin'),('voice','audio','voice.amr'),('audio','audio','audio.amr'),('video','video','video.mp4')):
                ref=item.get(key)
                if not isinstance(ref,dict) or not (ref.get('url') or ref.get('base64')): continue
                if ref.get('base64'):
                    raw=base64.b64decode(ref['base64'],validate=True); mime=None
                else:
                    raw,mime=await download(self.http,ref['url'])
                    if ref.get('aeskey'): raw=decrypt(raw,ref['aeskey'],'cbc')
                if kind=='image' and (not mime or not mime.startswith('image/')):
                    mime='image/png' if raw.startswith(b'\x89PNG') else 'image/jpeg'
                references.append(pack(raw,ref.get('filename') or ref.get('name') or name,kind,mime))
        return references,'\n'.join(texts)

    async def request(self,cmd,body,req_id=None):
        if not self.ws or self.ws.closed: raise ReplyRejected('WeCom connection unavailable')
        req_id=req_id or 'media_'+secrets.token_hex(16)
        if req_id in self.pending: raise ReplyRejected('Reply already in flight')
        future=asyncio.get_running_loop().create_future()
        self.pending[req_id]=future
        try:
            await self.ws.send_json({'cmd':cmd,'headers':{'req_id':req_id},'body':body})
            result=await asyncio.wait_for(future,30)
            if any(code not in (None,0) for code in (result.get('errcode'),(result.get('body') or {}).get('errcode'))): raise ReplyRejected('WeCom media operation rejected')
            return result.get('body') or {}
        finally:
            self.pending.pop(req_id,None)
            if not future.done(): future.cancel()

    async def send_media(self,payload,media):
        context=json.loads(self.store.cipher.decrypt(payload['reply_enc'].encode()))
        if not payload.get('_cloud_notification') and (context['generation']!=self.generation or time.time()>=context['expires']): raise ReplyRejected('WeCom reply window expired')
        raw=unpack(media)
        if media['kind'] in {'image','video'} and len(raw)>10*1024*1024: raise ReplyRejected('Platform image/video size limit exceeded')
        kind={'image':'image','video':'video','audio':'voice','file':'file'}[media['kind']]
        if kind=='voice' and (media['mime'].lower()!='audio/amr' or len(raw)>2*1024*1024): kind='file'
        size=512*1024
        chunks=(len(raw)+size-1)//size
        opened=await self.request('aibot_upload_media_init',{'type':kind,'filename':media['name'],'total_size':len(raw),'total_chunks':chunks,'md5':hashlib.md5(raw).hexdigest()})
        upload_id=opened.get('upload_id')
        if not upload_id: raise ReplyRejected('WeCom upload ID missing')
        for index,start in enumerate(range(0,len(raw),size)):
            await self.request('aibot_upload_media_chunk',{'upload_id':upload_id,'chunk_index':index,'base64_data':base64.b64encode(raw[start:start+size]).decode()})
        finished=await self.request('aibot_upload_media_finish',{'upload_id':upload_id})
        if not finished.get('media_id'): raise ReplyRejected('WeCom media ID missing')
        if not payload.get('_cloud_notification') and (context['generation']!=self.generation or time.time()>=context['expires']): raise ReplyRejected('WeCom reply window expired')
        if payload.get('_cloud_notification'):
            await self.request('aibot_send_msg', {'chatid':payload['_cloud_notification']['chat'],'msgtype':kind,kind:{'media_id':finished['media_id']}})
        else:
            await self.request('aibot_respond_msg',{'msgtype':kind,kind:{'media_id':finished['media_id']}},context['req_id'])
        return {'ok':True}
