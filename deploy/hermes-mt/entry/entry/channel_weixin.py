"""iLink text protocol matching gateway/platforms/weixin.py, without loading the agent."""
import asyncio
import base64
import json
import secrets
import hashlib
import mimetypes
from types import SimpleNamespace
from urllib.parse import urlsplit,quote

import aiohttp
from aiohttp import web
from .channel_dingtalk import ReplyRejected
from .channel_media import download,decrypt,pack,unpack,add_inbound,media_url,fetch_media
from cryptography.hazmat.primitives.ciphers import Cipher,algorithms,modes

BASE_URL = 'https://ilinkai.weixin.qq.com'


class SessionExpired(ReplyRejected):
    pass


def trusted_origin(value):
    url = urlsplit(value)
    if (url.scheme != 'https' or not url.hostname or
            not (url.hostname == 'weixin.qq.com' or url.hostname.endswith('.weixin.qq.com')) or
            url.port not in (None,443) or url.username or url.password or
            url.path not in ('','/') or url.query or url.fragment):
        raise ValueError('Untrusted iLink origin')
    return value.rstrip('/')


async def api(http, origin, endpoint, *, token=None, payload=None):
    headers = {'iLink-App-Id':'bot','iLink-App-ClientVersion':str((2<<16)|(2<<8))}
    options = {'headers':headers,'allow_redirects':False,'timeout':aiohttp.ClientTimeout(total=40)}
    method = 'GET'
    if payload is not None:
        method = 'POST'
        headers.update({'AuthorizationType':'ilink_bot_token', 'Content-Type':'application/json',
            'X-WECHAT-UIN':base64.b64encode(str(secrets.randbits(32)).encode()).decode()})
        if token: headers['Authorization']='Bearer '+token
        options['json'] = {**payload,'base_info':{'channel_version':'2.2.0'}}
    async with http.request(method, trusted_origin(origin)+'/'+endpoint, **options) as response:
        if response.status != 200: raise RuntimeError('iLink request failed')
        result = await response.json()
        if result.get('ret',0) not in (None,0) or result.get('errcode',0) not in (None,0):
            codes=(result.get('ret'),result.get('errcode'))
            stale=-14 in codes or (-2 in codes and str(result.get('errmsg') or result.get('msg') or '').lower() in {'unknown error','prepare failed'})
            if stale: raise SessionExpired('iLink login expired')
            raise ReplyRejected('iLink rejected request')
        return result


class Weixin:
    def __init__(self, bot, token, store, binding, http):
        self.bot,self.token,self.store,self.binding,self.http=bot,token,store,binding,http
        self.config=json.loads(binding['config'])
        self.origin=trusted_origin(self.config['gateway_url'])
        self.state='starting'
        self.task=None

    @property
    def health(self): return SimpleNamespace(state=self.state)

    async def start(self): self.task=asyncio.create_task(self.run())

    async def stop(self):
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task,return_exceptions=True)

    async def receive_batch(self, result):
        async with self.store.database.acquire() as db:
            config=await db.fetchval('SELECT config FROM messaging_bindings WHERE id=$1 AND revision=$2',self.binding['id'],self.binding['revision'])
        if config is None: raise web.HTTPConflict(text='Binding changed')
        self.config=json.loads(config)
        for message in result.get('msgs') or []:
            sender=str(message.get('from_user_id') or '')
            message_id=str(message.get('message_id') or '')
            room=str(message.get('room_id') or message.get('chat_room_id') or '')
            if not room and message.get('to_user_id') and message['to_user_id']!=self.bot and message.get('msg_type')==1: room=str(message['to_user_id'])
            if room and (self.config.get('group_policy')!='open' or room not in self.config.get('group_ids',[])): continue
            if not sender or sender==self.bot: continue
            if await self.store.seen(self.binding['id'],self.binding['revision'],room or sender,message_id): continue
            items=message.get('item_list') or []
            text='\n'.join(str((item.get('text_item') or {}).get('text') or '') for item in items if item.get('type')==1).strip()
            attachments,note=await fetch_media(self.attachments(items))
            text=(text+'\n'+note).strip()
            if not sender or sender==self.bot or (not text and not attachments): continue
            if not message_id or len(text)>20000: raise ValueError('Invalid iLink message identity or size')
            chat=room or sender
            event=add_inbound({'text':text,'message_id':message_id,'source':{'platform':'weixin','chat_id':chat,'user_id':sender,'chat_type':'group' if room else 'dm'}},attachments)
            context={'to':chat,'context_token':str(message.get('context_token') or ''),'client_id':'wx_'+secrets.token_hex(16)}
            payload={'event':event,'reply_enc':self.store.cipher.encrypt(json.dumps(context)).decode()}
            await self.store.ingest(self.binding['id'],self.binding['revision'],chat,message_id,payload)
        # Advance only after every admission commits. A crash in between replays the
        # batch through the inbox unique key, including after connector replacement.
        cursor=result.get('get_updates_buf')
        if cursor is not None:
            async with self.store.database.acquire() as db:
                updated=await db.fetchval("UPDATE messaging_bindings SET config=jsonb_set(config,'{sync_buf}',to_jsonb($3::text)) WHERE id=$1 AND revision=$2 AND enabled AND deleted_at IS NULL RETURNING id",self.binding['id'],self.binding['revision'],str(cursor))
            if not updated: raise RuntimeError('Binding changed')
        return str(cursor) if cursor is not None else None

    async def run(self):
        cursor=json.loads(self.binding['config']).get('sync_buf','')
        delay=1
        while True:
            try:
                result=await api(self.http,self.origin,'ilink/bot/getupdates',token=self.token,payload={'get_updates_buf':cursor})
                next_cursor=await self.receive_batch(result)
                if next_cursor is not None: cursor=next_cursor
                self.state='running'
                delay=1
            except asyncio.CancelledError: raise
            except asyncio.TimeoutError:
                self.state='running'
            except SessionExpired:
                # Re-pair explicitly; never silently substitute another account.
                self.state='failed'
                await asyncio.Event().wait()
            except Exception:
                self.state='failed'
                await asyncio.sleep(delay)
                delay=min(delay*2,60)

    async def send(self,payload,text):
        context=json.loads(self.store.cipher.decrypt(payload['reply_enc'].encode()))
        if not context['context_token']: raise ReplyRejected('Missing reply context')
        await api(self.http,self.origin,'ilink/bot/sendmessage',token=self.token,payload={'msg':{
            'from_user_id':'','to_user_id':context['to'],'client_id':context['client_id'],
            'message_type':2,'message_state':2,'context_token':context['context_token'],
            'item_list':[{'type':1,'text_item':{'text':text}}]}})
        return {'ok':True}

    async def attachments(self,items):
        shapes={2:('image_item','image','image.jpg','image/jpeg'),3:('voice_item','audio','voice.silk','audio/silk'),4:('file_item','file','document.bin',None),5:('video_item','video','video.mp4','video/mp4')}
        result=[]
        for item in items:
            shape=shapes.get(item.get('type'))
            if not shape: continue
            key,kind,name,mime=shape
            body=item.get(key) or {}
            ref=body.get('media') or {}
            query=ref.get('encrypt_query_param')
            url='https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param='+quote(query,safe='') if query else ref.get('full_url')
            if not url: raise ValueError('Missing Weixin media reference')
            raw,_=await download(self.http,url)
            aes_key=base64.b64encode(bytes.fromhex(body['aeskey'])).decode() if body.get('aeskey') else ref.get('aes_key')
            if aes_key: raw=decrypt(raw,aes_key)
            result.append(pack(raw,body.get('file_name') or name,kind,mime))
        return result

    async def send_media(self,payload,media):
        context=json.loads(self.store.cipher.decrypt(payload['reply_enc'].encode()))
        raw=unpack(media)
        if media['kind'] in {'image','video'} and len(raw)>10*1024*1024: raise ReplyRejected('Platform image/video size limit exceeded')
        aes_key=secrets.token_bytes(16)
        padding=16-len(raw)%16
        encryptor=Cipher(algorithms.AES(aes_key),modes.ECB()).encryptor()
        ciphertext=encryptor.update(raw+bytes([padding])*padding)+encryptor.finalize()
        kind=media['kind']
        # Desktop send_voice uses file attachment until native voice bubbles are verified.
        if kind=='audio': kind='file'
        media_type={'image':1,'video':2,'file':3,'audio':4}[kind]
        filekey=secrets.token_hex(16)
        result=await api(self.http,self.origin,'ilink/bot/getuploadurl',token=self.token,payload={
            'filekey':filekey,'media_type':media_type,'to_user_id':context['to'],'rawsize':len(raw),
            'rawfilemd5':hashlib.md5(raw).hexdigest(),'filesize':len(ciphertext),'no_need_thumb':True,'aeskey':aes_key.hex()})
        url=result.get('upload_full_url')
        if not url and result.get('upload_param'):
            url='https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param='+quote(result['upload_param'],safe='')+'&filekey='+filekey
        media_url(url or '')
        async with self.http.post(url,data=ciphertext,headers={'Content-Type':'application/octet-stream'},allow_redirects=False,timeout=aiohttp.ClientTimeout(total=60)) as response:
            if response.status!=200 or not response.headers.get('x-encrypted-param'): raise RuntimeError('Weixin media upload unconfirmed')
            query=response.headers['x-encrypted-param']
        ref={'encrypt_query_param':query,'aes_key':base64.b64encode(aes_key.hex().encode()).decode(),'encrypt_type':1}
        field={'image':'image_item','video':'video_item','file':'file_item','audio':'voice_item'}[kind]
        detail={'media':ref}
        if kind=='file': detail.update(file_name=media['name'],len=str(len(raw)))
        elif kind=='image': detail['mid_size']=len(ciphertext)
        elif kind=='video': detail.update(video_size=len(ciphertext),play_length=0,video_md5=hashlib.md5(raw).hexdigest())
        else: detail.update(encode_type=6,sample_rate=24000,bits_per_sample=16,playtime=0)
        item={'type':{'image':2,'video':5,'file':4,'audio':3}[kind],field:detail}
        await api(self.http,self.origin,'ilink/bot/sendmessage',token=self.token,payload={'msg':{
            'from_user_id':'','to_user_id':context['to'],'client_id':media.get('client_id',media['id']),'message_type':2,'message_state':2,
            'context_token':context['context_token'],'item_list':[item]}})
        return {'ok':True}
