"""Short-lived, one-attachment download links for the 5G gateway media plane."""
import hashlib
import hmac
import time
from urllib.parse import quote

import aiohttp
from aiohttp import web
from plugins.cloud_messaging.media import unpack,MAX_MEDIA_BYTES


def signature(key,identity,expires):
    return hmac.new(key.encode(),f'messaging-media:{identity}:{expires}'.encode(),hashlib.sha256).hexdigest()


def media_link(settings,identity):
    expires=int(time.time())+3600
    base=settings.channels_relay_url.removesuffix('/relay').replace('wss://','https://',1).replace('ws://','http://',1)
    return f'{base}/media/{identity}?e={expires}&s='+signature(settings.channels_key,identity,expires)


def media_response(media):
    return web.Response(body=unpack(media),headers={'Content-Type':media['mime'],'Content-Disposition':"attachment; filename*=UTF-8''"+quote(media['name'],safe=''),
        'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"})


async def handle(entry,request):
    identity=request.match_info['id']
    try: expires=int(request.query.get('e','0'))
    except ValueError: raise web.HTTPUnauthorized()
    supplied=request.query.get('s','')
    if not entry.s.channels_key or not int(time.time())<expires<=int(time.time())+3600 or not hmac.compare_digest(supplied.encode(),signature(entry.s.channels_key,identity,expires).encode()):
        raise web.HTTPUnauthorized()
    async with entry.http.get(entry.s.channels_url+'/media/'+quote(identity,safe=''),headers={'Authorization':'Bearer '+entry.s.channels_key},allow_redirects=False,timeout=aiohttp.ClientTimeout(total=30)) as response:
        if response.status!=200: raise web.HTTPNotFound()
        content=await response.read()
        if not content or len(content)>MAX_MEDIA_BYTES: raise web.HTTPBadGateway()
        return web.Response(body=content,headers={key:response.headers[key] for key in ('Content-Type','Content-Disposition','Cache-Control','X-Content-Type-Options','Content-Security-Policy') if key in response.headers})
