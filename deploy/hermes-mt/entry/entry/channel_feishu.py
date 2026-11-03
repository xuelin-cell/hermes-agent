"""Feishu long connection uses pinned lark-oapi protobuf frames with owned async I/O."""
import asyncio
import json
import secrets
import time
from types import SimpleNamespace
from urllib.parse import parse_qs,urlsplit

import aiohttp
from .channel_dingtalk import ReplyRejected
from .channel_media import pack,add_inbound,MAX_MEDIA_BYTES,unpack,download,MEDIA_UNAVAILABLE

API='https://open.feishu.cn'


class Feishu:
    def __init__(self,app_id,secret,store,binding,http):
        self.app_id,self.secret,self.store,self.binding,self.http=app_id,secret,store,binding,http
        self.state='starting'
        self.task=None
        self.token=''
        self.token_until=0
        self.bot_id=''
        self.fragments={}

    @property
    def health(self): return SimpleNamespace(state=self.state)

    async def start(self): self.task=asyncio.create_task(self.run())

    async def stop(self):
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task,return_exceptions=True)

    async def access_token(self):
        if self.token_until>time.time(): return self.token
        async with self.http.post(API+'/open-apis/auth/v3/tenant_access_token/internal',json={'app_id':self.app_id,'app_secret':self.secret},allow_redirects=False,timeout=aiohttp.ClientTimeout(total=15)) as response:
            result=await response.json()
            if response.status!=200 or result.get('code')!=0 or not result.get('tenant_access_token'): raise ReplyRejected('Feishu authentication failed')
        self.token=result['tenant_access_token']
        self.token_until=time.time()+max(0,int(result.get('expire',7200))-60)
        return self.token

    async def request(self,path,*,data=None,body=None,method='POST'):
        token=await self.access_token()
        async with self.http.request(method,API+'/open-apis/'+path,headers={'Authorization':'Bearer '+token},json=body,data=data,allow_redirects=False,timeout=aiohttp.ClientTimeout(total=60)) as response:
            result=await response.json()
            if response.status!=200 or result.get('code')!=0: raise ReplyRejected('Feishu operation rejected')
            return result.get('data') or result

    async def receive(self,event):
        if (event.get('header') or {}).get('event_type')!='im.message.receive_v1': return
        body=event.get('event') or {}
        sender=body.get('sender') or {}
        if sender.get('sender_type')!='user': return
        sender_id=(sender.get('sender_id') or {}).get('open_id')
        message=body.get('message') or {}
        kind=message.get('message_type')
        if kind not in {'text','post','image','audio','file','media'}: return
        group=message.get('chat_type')=='group'
        if group:
            if not self.bot_id:
                info=await self.request('bot/v3/info',method='GET')
                self.bot_id=(info.get('bot') or info).get('open_id','')
            if not self.bot_id or not any((item.get('id') or {}).get('open_id')==self.bot_id for item in message.get('mentions') or []): return
        message_id,chat=message.get('message_id'),message.get('chat_id')
        if not all(isinstance(value,str) and value for value in (sender_id,message_id,chat)): raise ValueError('Missing Feishu routing identity')
        if await self.store.seen(self.binding['id'],self.binding['revision'],chat,message_id): return
        content=json.loads(message.get('content') or '{}')
        text=str(content.get('text') or '')
        for mention in message.get('mentions') or []: text=text.replace(mention.get('key','@_user_0'),'')
        refs=[]
        if kind=='post':
            document=content.get('zh_cn') or content.get('en_us') or content
            text=str(document.get('title') or '')
            for row in document.get('content') or []:
                for item in row:
                    if item.get('tag') in {'text','a','md'}: text+='\n'+str(item.get('text') or '')
                    if item.get('tag')=='img': refs.append(('image',item.get('image_key'),'image.png'))
        if kind in {'image','audio','file','media'}:
            refs.append(('image' if kind=='image' else 'audio' if kind=='audio' else 'video' if kind=='media' else 'file',content.get('image_key') if kind=='image' else content.get('file_key'),content.get('file_name') or {'image':'image.png','audio':'voice.opus','media':'video.mp4'}.get(kind,'attachment.bin')))
        attachments=[]
        token=await self.access_token() if refs else ''
        for media_kind,key,name in refs:
            if not isinstance(key,str) or not key or '/' in key: raise ValueError('Invalid resource key')
            resource=f'{API}/open-apis/im/v1/messages/{message_id}/resources/{key}'
            try:
                data,mime=await download(self.http,resource+'?type='+('image' if media_kind=='image' else 'file'),headers={'Authorization':'Bearer '+token})
                attachments.append(pack(data,name,media_kind,mime or None))
            except ValueError: text+='\n'+MEDIA_UNAVAILABLE
        if len(text)>20000: raise ValueError('Message too large')
        if not text.strip() and not attachments: return
        normalized=add_inbound({'text':text.strip(),'message_id':message_id,'source':{'platform':'feishu','chat_id':chat,'user_id':sender_id,'chat_type':'group' if group else 'dm'}},attachments)
        context={'message_id':message_id,'uuid':secrets.token_hex(16)}
        await self.store.ingest(self.binding['id'],self.binding['revision'],chat,message_id,{'event':normalized,'reply_enc':self.store.cipher.encrypt(json.dumps(context)).decode()})

    async def frame(self,ws,data):
        from lark_oapi.ws.pb.pbbp2_pb2 import Frame
        frame=Frame()
        frame.ParseFromString(data)
        if frame.method!=1: return
        headers={h.key:h.value for h in frame.headers}
        if headers.get('type')!='event': return
        count,index=int(headers.get('sum','1')),int(headers.get('seq','0'))
        if not 1<=count<=64 or not 0<=index<count: raise ValueError('Invalid frame fragments')
        payload=frame.payload
        if count>1:
            now=time.monotonic()
            self.fragments={key:value for key,value in self.fragments.items() if now-value[0]<60}
            key=headers.get('message_id')
            if not key or (len(self.fragments)>=128 and key not in self.fragments): raise ValueError('Fragment limit exceeded')
            _,expected,pieces=self.fragments.setdefault(key,(now,count,{}))
            if expected!=count: raise ValueError('Fragment count changed')
            pieces[index]=payload
            if sum(map(len,pieces.values()))>262144: raise ValueError('Event too large')
            if len(pieces)<count: return
            payload=b''.join(pieces[n] for n in range(count))
            self.fragments.pop(key,None)
        try:
            await self.receive(json.loads(payload))
            code=200
        except asyncio.CancelledError: raise
        except Exception: code=500
        frame.payload=json.dumps({'code':code}).encode()
        await ws.send_bytes(frame.SerializeToString())

    async def heartbeat(self,ws,service,interval):
        from lark_oapi.ws.pb.pbbp2_pb2 import Frame
        while True:
            frame=Frame(service=service,method=0,SeqID=0,LogID=0)
            header=frame.headers.add(); header.key='type'; header.value='ping'
            await ws.send_bytes(frame.SerializeToString())
            await asyncio.sleep(interval)

    async def run(self):
        delay=1
        while True:
            try:
                async with self.http.post(API+'/callback/ws/endpoint',json={'AppID':self.app_id,'AppSecret':self.secret},allow_redirects=False,timeout=aiohttp.ClientTimeout(total=15)) as response:
                    result=await response.json()
                    if response.status!=200 or result.get('code')!=0: raise ReplyRejected('Feishu connection rejected')
                endpoint=result['data']['URL']; url=urlsplit(endpoint)
                if url.scheme!='wss' or url.username or url.password or url.fragment: raise ValueError('Invalid Feishu endpoint')
                service=int(parse_qs(url.query)['service_id'][0])
                interval=max(5,min(120,int((result['data'].get('ClientConfig') or {}).get('PingInterval',90))))
                async with self.http.ws_connect(endpoint,heartbeat=60,max_msg_size=262144) as ws:
                    self.state='running'; delay=1; self.fragments.clear()
                    task=asyncio.create_task(self.heartbeat(ws,service,interval))
                    try:
                        async for message in ws:
                            if message.type==aiohttp.WSMsgType.BINARY: await self.frame(ws,message.data)
                            elif message.type not in {aiohttp.WSMsgType.PING,aiohttp.WSMsgType.PONG}: break
                    finally:
                        task.cancel(); await asyncio.gather(task,return_exceptions=True)
            except asyncio.CancelledError: raise
            except Exception: self.state='failed'
            self.state='failed'
            await asyncio.sleep(delay); delay=min(delay*2,60)

    async def send(self,payload,text):
        context=json.loads(self.store.cipher.decrypt(payload['reply_enc'].encode()))
        return await self.request('im/v1/messages/'+context['message_id']+'/reply',body={'msg_type':'text','content':json.dumps({'text':text}),'uuid':context['uuid']})

    async def send_media(self,payload,media):
        raw=unpack(media)
        if media['kind'] in {'image','video'} and len(raw)>10*1024*1024: raise ReplyRejected('Platform image/video size limit exceeded')
        kind=media['kind']
        if kind=='audio' and not media['name'].lower().endswith(('.opus','.ogg')): kind='file'
        image=kind=='image'
        form=aiohttp.FormData()
        form.add_field('image_type' if image else 'file_type','message' if image else 'opus' if kind=='audio' else 'mp4' if kind=='video' else 'stream')
        if not image: form.add_field('file_name',media['name'])
        form.add_field('image' if image else 'file',raw,filename=media['name'],content_type=media['mime'])
        uploaded=await self.request('im/v1/images' if image else 'im/v1/files',data=form)
        kind={'image':'image','audio':'audio','video':'media','file':'file'}[kind]
        content={'image_key' if image else 'file_key':uploaded['image_key' if image else 'file_key']}
        context=json.loads(self.store.cipher.decrypt(payload['reply_enc'].encode()))
        return await self.request('im/v1/messages/'+context['message_id']+'/reply',body={'msg_type':kind,'content':json.dumps(content),'uuid':media.get('client_id',media['id'])[:32]})
