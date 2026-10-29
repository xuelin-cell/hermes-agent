"""Platform media HTTP boundaries; no platform credentials travel to instances."""
import base64
from urllib.parse import urlsplit,unquote

import aiohttp
from cryptography.hazmat.primitives.ciphers import Cipher,algorithms,modes
from plugins.cloud_messaging.media import MAX_MEDIA_BYTES,pack,unpack,add_inbound

HOSTS=('weixin.qq.com','qpic.cn','qlogo.cn','qq.com','dingtalk.com','dingtalk.cn','dingding.xin','aliyuncs.com',
    'alicdn.com','feishu.cn','larksuite.com','feishucdn.com','larksuitecdn.com','myqcloud.com')


def media_url(url,hosts=HOSTS):
    parsed=urlsplit(url)
    if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or parsed.port not in (None,443):
        raise ValueError('Invalid platform media URL')
    if not any(parsed.hostname==host or parsed.hostname.endswith('.'+host) for host in hosts):
        raise ValueError('Untrusted platform media host')
    return url


async def download(http,url,*,headers=None):
    media_url(url)
    async with http.get(url,headers=headers or {},allow_redirects=False,timeout=aiohttp.ClientTimeout(total=60)) as response:
        if 400<=response.status<500: raise ValueError('Platform attachment expired or unavailable')
        if response.status!=200: raise RuntimeError('Platform attachment unavailable')
        if int(response.headers.get('Content-Length','0'))>MAX_MEDIA_BYTES+32: raise ValueError('Media too large')
        data=bytearray()
        async for chunk in response.content.iter_chunked(65536):
            data.extend(chunk)
            if len(data)>MAX_MEDIA_BYTES+32: raise ValueError('Media too large')
        return bytes(data),response.headers.get('Content-Type','').split(';')[0]


def decrypt(data,key,mode='ecb'):
    value=unquote(key or '')
    decoded=base64.b64decode(value+'='*((-len(value))%4))
    if mode=='ecb' and len(decoded)==32:
        try: decoded=bytes.fromhex(decoded.decode())
        except (ValueError,UnicodeError): pass
    if len(decoded)!=(16 if mode=='ecb' else 32): raise ValueError('Invalid platform media key')
    decryptor=Cipher(algorithms.AES(decoded),modes.ECB() if mode=='ecb' else modes.CBC(decoded[:16])).decryptor()
    output=decryptor.update(data)+decryptor.finalize()
    padding=output[-1] if output else 0
    if not 1<=padding<=32 or output[-padding:]!=bytes([padding])*padding: raise ValueError('Invalid media padding')
    return output[:-padding]


MEDIA_UNAVAILABLE='[附件未接收：文件超出大小限制、链接失效或格式不支持，请重新发送。]'


async def fetch_media(operation):
    try: return await operation,''
    except ValueError: return [],MEDIA_UNAVAILABLE
