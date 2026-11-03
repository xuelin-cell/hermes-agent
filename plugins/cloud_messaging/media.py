"""Bounded media envelopes shared by the connector and the instance relay."""
import base64
import hashlib
import mimetypes
from pathlib import Path
from urllib.parse import quote, unquote

MAX_MEDIA_BYTES=20*1024*1024
MAX_MESSAGE_BYTES=25*1024*1024
MAX_FILE_BYTES=64*1024*1024
MAX_RCS_MESSAGE_BYTES=96*1024*1024
MAX_WIRE_BYTES=136*1024*1024
KINDS={'image','audio','file','video'}


def attachment_limit(platform, kind):
    return MAX_FILE_BYTES if platform=='uniagentgate' and kind=='file' else MAX_MEDIA_BYTES


def message_limit(platform):
    return MAX_RCS_MESSAGE_BYTES if platform=='uniagentgate' else MAX_MESSAGE_BYTES


def outbound_bytes(platform, media):
    raw = unpack(media)
    if len(raw)>attachment_limit(platform, media['kind']): raise ValueError('Platform attachment limit exceeded')
    return raw


def pack(data,filename,kind='file',mime=None):
    if not data or len(data)>(MAX_FILE_BYTES if kind=='file' else MAX_MEDIA_BYTES) or kind not in KINDS:
        raise ValueError('Media is empty, oversized or unsupported')
    name=Path(str(filename).replace('\\','/')).name.encode('utf-8')[:180].decode('utf-8','ignore') or 'attachment.bin'
    if any(ord(char)<32 for char in name): raise ValueError('Invalid filename')
    if kind=='image':
        mime=next((value for magic,value in ((b'\x89PNG\r\n\x1a\n','image/png'),(b'\xff\xd8\xff','image/jpeg'),(b'GIF8','image/gif'),(b'RIFF','image/webp')) if data.startswith(magic)),mime)
    mime=mime or mimetypes.guess_type(name)[0] or 'application/octet-stream'
    if not isinstance(mime,str) or any(c in mime for c in '\r\n;,'): raise ValueError('Invalid media type')
    return {'name':name,'kind':kind,'mime':mime,'data':base64.b64encode(data).decode(),
        'id':hashlib.sha256(kind.encode()+b'\0'+name.encode()+b'\0'+mime.encode()+b'\0'+data).hexdigest()}


def unpack(media):
    if not isinstance(media,dict) or not isinstance(media.get('data'),str) or len(media['data'])>((MAX_FILE_BYTES+2)//3)*4:
        raise ValueError('Invalid media envelope')
    raw=base64.b64decode(media['data'],validate=True)
    checked=pack(raw,media.get('name','attachment.bin'),media.get('kind','file'),media.get('mime'))
    if checked['id']!=media.get('id'): raise ValueError('Media identity mismatch')
    return raw


def add_inbound(event,attachments):
    if sum(len(unpack(media)) for media in attachments)>MAX_MESSAGE_BYTES:
        attachments=[]
        event['text']=(event.get('text','')+'\n[附件未接收：单条消息的附件总大小超过 25 MiB，请分开发送。]').strip()
    event['media_urls']=['data:'+m['mime']+';name='+quote(m['name'],safe='')+';base64,'+m['data'] for m in attachments]
    event['media']=[]
    if attachments:
        event['message_type']={'image':'photo','audio':'voice','video':'video','file':'document'}[attachments[0]['kind']]
    return event


def localize(event,home):
    paths=[]
    types=[]
    total=0
    for item in event.media_urls:
        if not item.startswith('data:') or ';base64,' not in item: raise ValueError('Unexpected remote attachment')
        header,encoded=item.split(';base64,',1)
        mime,name=header[5:].split(';name=',1)
        if len(encoded)>((MAX_MEDIA_BYTES+2)//3)*4: raise ValueError('Media too large')
        raw=base64.b64decode(encoded,validate=True)
        total+=len(raw)
        if not raw or len(raw)>MAX_MEDIA_BYTES or total>MAX_MESSAGE_BYTES: raise ValueError('Media limit exceeded')
        filename=Path(unquote(name).replace('\\','/')).name or 'attachment.bin'
        directory=Path(home)/'messaging-media'/hashlib.sha256(str(event.message_id).encode()).hexdigest()
        directory.mkdir(parents=True,exist_ok=True,mode=0o700)
        target=directory/(hashlib.sha256(raw).hexdigest()[:16]+'-'+filename[:180])
        target.write_bytes(raw)
        target.chmod(0o600)
        paths.append(str(target))
        types.append(mime)
    event.media_urls=paths
    event.media_types=types
