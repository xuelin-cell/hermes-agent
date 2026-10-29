"""DingTalk Stream SDK boundary: durable admission precedes callback ACK."""
import asyncio
import json
import logging
import time
import mimetypes
from types import SimpleNamespace
from urllib.parse import urlsplit, quote_plus

import aiohttp
from .channel_media import download,pack,unpack,add_inbound,fetch_media


class ReplyRejected(RuntimeError):
    pass


def normalize(data):
    content=data.get('content') or {}
    if isinstance(content,str): content=json.loads(content)
    text = (data.get('text') or {}).get('content','').strip() or str(content.get('recognition') or '')
    for item in content.get('richText') or []:
        if item.get('type')=='text': text+=' '+str(item.get('text') or '')
    group = str(data.get('conversationType')) == '2'
    if data.get('msgtype') not in {'text','picture','image','file','audio','video','richText'}:
        raise ValueError('Unsupported DingTalk message')
    if not text and data.get('msgtype')=='text': raise ValueError('Empty DingTalk text')
    # Match the existing adapter: unmentioned group messages do not run the agent.
    if group and data.get('isInAtList') is not True: return None
    for key in ('msgId','conversationId','senderId'):
        if not isinstance(data.get(key),str) or not data[key]: raise ValueError('Missing routing identity')
    if len(text)>20000: raise ValueError('Message too large')
    return {'text':text,'message_id':data['msgId'], 'source':{'platform':'dingtalk',
        'chat_id':data['conversationId'],'user_id':data['senderId'],
        'chat_type':'group' if group else 'dm'}}


def reply_context(data):
    url=data.get('sessionWebhook','')
    parsed=urlsplit(url)
    if parsed.scheme!='https' or parsed.hostname not in {'oapi.dingtalk.com','api.dingtalk.com'} or parsed.port not in (None,443) or parsed.username or parsed.password or parsed.fragment or parsed.path not in {'/robot/send','/robot/sendBySession'}:
        raise ValueError('Untrusted reply webhook')
    return {'url':url,'expires':int(data.get('sessionWebhookExpiredTime',0))}


class DingTalk:
    def __init__(self, client_id, secret, store, binding, http):
        import dingtalk_stream as sdk
        from dingtalk_stream.version import VERSION_STRING
        self.sdk_module=sdk
        self.sdk_version=VERSION_STRING
        self.store,self.binding,self.http=store,binding,http
        # SDK diagnostics can include callback bodies and connection tickets.
        logger=logging.getLogger('channels.dingtalk.sdk')
        logger.disabled=True
        self.sdk=sdk.DingTalkStreamClient(sdk.Credential(client_id,secret),logger=logger)
        owner=self
        class Receiver(sdk.ChatbotHandler):
            async def process(self, message):
                try:
                    data=json.loads(message.data) if isinstance(message.data,str) else message.data
                    await owner.receive(data)
                except Exception:
                    return sdk.AckMessage.STATUS_SYSTEM_EXCEPTION,'Persistence unavailable or unsupported message'
                return sdk.AckMessage.STATUS_OK,'OK'
        self.sdk.register_callback_handler(sdk.ChatbotMessage.TOPIC,Receiver())
        self.task=None
        self.open_failed=False
        self.client_id,self.secret=client_id,secret
        self.token=''
        self.token_until=0

    @property
    def health(self):
        ws=getattr(self.sdk,'websocket',None)
        return SimpleNamespace(state='running' if ws and not ws.closed else 'failed' if self.open_failed else 'starting')

    async def receive(self,data):
        event=normalize(data)
        if event is None: return
        if await self.store.seen(self.binding['id'],self.binding['revision'],event['source']['chat_id'],event['message_id']): return
        # Never store the ephemeral webhook in plaintext or put it in the model context.
        attachments,note=await fetch_media(self.attachments(data))
        if note: event['text']=(event['text']+'\n'+note).strip()
        add_inbound(event,attachments)
        context=reply_context(data)
        context.update(conversation_type=str(data.get('conversationType') or ''),chat=data.get('conversationId'),staff=data.get('senderStaffId'))
        payload={'event':event,'reply_enc':self.store.cipher.encrypt(json.dumps(context)).decode()}
        await self.store.ingest(self.binding['id'],self.binding['revision'],event['source']['chat_id'],event['message_id'],payload)

    async def start(self):
        self.sdk.pre_start()
        self.task=asyncio.create_task(self.run())

    async def run(self):
        delay=1
        while True:
            try:
                # SDK 0.24.3 uses blocking requests without timeout and catches
                # CancelledError in start(). Keep its protocol, own the I/O lifetime.
                async with self.http.post(self.sdk.OPEN_CONNECTION_API,
                        json={'clientId':self.client_id,'clientSecret':self.secret,
                            'subscriptions':[{'type':'CALLBACK','topic':self.sdk_module.ChatbotMessage.TOPIC}],
                            'ua':'dingtalk-sdk-python/v'+self.sdk_version+'-union','localIp':self.sdk.get_host_ip()},
                        timeout=aiohttp.ClientTimeout(total=15),allow_redirects=False) as response:
                    if response.status!=200: raise RuntimeError('Stream authentication failed')
                    connection=await response.json()
                endpoint=urlsplit(connection['endpoint'])
                if endpoint.scheme!='wss' or endpoint.username or endpoint.password or endpoint.fragment:
                    raise ValueError('Invalid Stream endpoint')
                url=connection['endpoint']+'?ticket='+quote_plus(connection['ticket'])
                async with self.http.ws_connect(url,heartbeat=30,max_msg_size=262144) as ws:
                    class Wire:
                        closed=False
                        async def send(self,data): await ws.send_str(data)
                    wire=Wire()
                    self.sdk.websocket=wire
                    self.open_failed=False
                    delay=1
                    try:
                        async for message in ws:
                            if message.type!=aiohttp.WSMsgType.TEXT: break
                            result=await self.sdk.route_message(json.loads(message.data))
                            if result==self.sdk.TAG_DISCONNECT: break
                    finally:
                        wire.closed=True
                        self.sdk.websocket=None
            except asyncio.CancelledError:
                raise
            except Exception:
                self.open_failed=True
            await asyncio.sleep(delay)
            delay=min(delay*2,60)

    async def stop(self):
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task,return_exceptions=True)

    async def send(self, payload, text):
        context=json.loads(self.store.cipher.decrypt(payload['reply_enc'].encode()))
        # A known expired reply context is a failure, never a blind retry through another chat.
        if context['expires']<=int(time.time()*1000): raise ReplyRejected('reply_context_expired')
        reply_context({'sessionWebhook':context['url'],'sessionWebhookExpiredTime':context['expires']})
        async with self.http.post(context['url'],json={'msgtype':'text','text':{'content':text}},
                timeout=aiohttp.ClientTimeout(total=15),allow_redirects=False) as response:
            if response.status!=200: raise RuntimeError('Reply result unconfirmed')
            result=await response.json()
            if result.get('errcode')!=0: raise ReplyRejected('reply_rejected')
        return {'ok':True}

    async def access_token(self):
        if self.token_until>time.time(): return self.token
        async with self.http.post('https://api.dingtalk.com/v1.0/oauth2/accessToken',json={'appKey':self.client_id,'appSecret':self.secret},allow_redirects=False,timeout=aiohttp.ClientTimeout(total=15)) as response:
            result=await response.json()
            if response.status!=200 or not result.get('accessToken'): raise ReplyRejected('DingTalk access token unavailable')
        self.token=result['accessToken']; self.token_until=time.time()+max(0,int(result.get('expireIn',7200))-60)
        return self.token

    async def attachments(self,data):
        content=data.get('content') or {}
        if isinstance(content,str): content=json.loads(content)
        refs=list(content.get('richText') or [])
        refs.append({**content,**(data.get('imageContent') or {}),'type':data.get('msgtype')})
        attachments=[]
        for item in refs:
            code=item.get('downloadCode') or item.get('pictureDownloadCode')
            if not code: continue
            token=await self.access_token()
            async with self.http.post('https://api.dingtalk.com/v1.0/robot/messageFiles/download',headers={'x-acs-dingtalk-access-token':token},json={'downloadCode':code,'robotCode':self.client_id},allow_redirects=False,timeout=aiohttp.ClientTimeout(total=15)) as response:
                result=await response.json()
                if response.status!=200 or not result.get('downloadUrl'): raise ReplyRejected('DingTalk attachment unavailable')
            raw,mime=await download(self.http,result['downloadUrl'])
            kind={'picture':'image','image':'image','audio':'audio','voice':'audio','video':'video'}.get(item.get('type'),'file')
            name=item.get('fileName') or {'image':'image.jpg','audio':'voice.amr','video':'video.mp4'}.get(kind,'attachment.bin')
            attachments.append(pack(raw,name,kind,mime if mime and mime!='application/octet-stream' else None))
        return attachments

    async def send_media(self,payload,media):
        context=json.loads(self.store.cipher.decrypt(payload['reply_enc'].encode()))
        token=await self.access_token()
        raw=unpack(media)
        if media['kind'] in {'image','video'} and len(raw)>10*1024*1024: raise ReplyRejected('Platform image/video size limit exceeded')
        image=media['kind']=='image'
        form=aiohttp.FormData()
        form.add_field('media',raw,filename=media['name'],content_type=media['mime'])
        async with self.http.post('https://oapi.dingtalk.com/media/upload',params={'access_token':token,'type':'image' if image else 'file'},data=form,allow_redirects=False,timeout=aiohttp.ClientTimeout(total=60)) as response:
            uploaded=await response.json()
            if response.status!=200 or uploaded.get('errcode',0)!=0 or not uploaded.get('media_id'): raise ReplyRejected('DingTalk upload rejected')
        if context['conversation_type']=='2':
            endpoint='https://api.dingtalk.com/v1.0/robot/groupMessages/send'
            target={'openConversationId':context['chat']}
        elif context['conversation_type']=='1' and context.get('staff'):
            endpoint='https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend'
            target={'userIds':[context['staff']]}
        else: raise ReplyRejected('DingTalk media recipient unavailable')
        # Desktop sends non-image media as files (including voice attachments).
        params={'photoURL':uploaded['media_id']} if image else {'mediaId':uploaded['media_id'],'fileName':media['name'],'fileType':media['name'].rsplit('.',1)[-1]}
        async with self.http.post(endpoint,headers={'x-acs-dingtalk-access-token':token},json={
            'robotCode':self.client_id,'msgKey':'sampleImageMsg' if image else 'sampleFile','msgParam':json.dumps(params,ensure_ascii=False),**target},allow_redirects=False,timeout=aiohttp.ClientTimeout(total=30)) as response:
            delivered=await response.json()
            if response.status!=200: raise RuntimeError('DingTalk media result unconfirmed')
            if delivered.get('errcode',0)!=0 or delivered.get('code') not in (None,'',0,'0') or delivered.get('invalidStaffIdList') or delivered.get('flowControlledStaffIdList'):
                raise ReplyRejected('DingTalk media rejected')
            if not delivered.get('processQueryKey'): raise RuntimeError('DingTalk media receipt missing')
        return {'ok':True,'receipt':delivered['processQueryKey']}
