"""Profile-scoped media files and crash-safe media-only reply receipts."""
import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent.secret_scope import build_profile_secret_scope,set_secret_scope,reset_secret_scope,set_multiplex_active,is_multiplex_active
from hermes_constants import set_hermes_home_override,reset_hermes_home_override
from gateway.config import PlatformConfig
from gateway.platforms.event import MessageEvent,MessageType,ProcessingOutcome
from gateway.session import SessionSource
from gateway.config import Platform
from plugins.cloud_messaging.adapter import CloudMessagingAdapter
from plugins.cloud_messaging.media import pack,unpack,add_inbound,localize,MAX_MEDIA_BYTES


def settings():
    return {'platform':'feishu','relay_url':'ws://127.0.0.1:1/relay','gateway_id':'owner.1.1','bot_id':'bot','upgrade_secret':'fixture','revision':1,'binding_id':'binding'}


@pytest.mark.asyncio
async def test_media_materialization_a_b_a_is_profile_owned(tmp_path,monkeypatch):
    monkeypatch.setattr(Path,'home',lambda:tmp_path)
    multiplex=is_multiplex_active(); set_multiplex_active(True)
    paths={}
    try:
        for owner in ('alice','bob','alice'):
            home=tmp_path/owner; home.mkdir(exist_ok=True)
            monkeypatch.setenv('HERMES_HOME',str(home))
            token=set_hermes_home_override(home)
            secret=set_secret_scope(build_profile_secret_scope(home),profile_home=str(home))
            try:
                wire=add_inbound({'text':'read file'},[pack(owner.encode(),'../../input.txt')])
                event=MessageEvent(text='read file',message_id='same-external-id',source=SessionSource(platform=Platform.FEISHU,chat_id='same-chat'),media_urls=wire['media_urls'])
                localize(event,home)
                path=Path(event.media_urls[0]); assert path.is_relative_to(home)
                assert path.read_bytes()==owner.encode() and event.media_types==['text/plain']
                if owner in paths: assert paths[owner]==path
                paths[owner]=path
                assert path.stat().st_mode&0o077==0
            finally:
                reset_secret_scope(secret); reset_hermes_home_override(token)
        assert paths['alice']!=paths['bob']
        with pytest.raises(ValueError): pack(b'x'*(MAX_MEDIA_BYTES+1),'too-large.bin')
    finally: set_multiplex_active(multiplex)


@pytest.mark.asyncio
async def test_media_only_caption_and_bytes_survive_worker_restart(tmp_path,monkeypatch):
    monkeypatch.setenv('HERMES_HOME',str(tmp_path))
    token=set_hermes_home_override(tmp_path)
    try:
        source=tmp_path/'voice.mp3'; source.write_bytes(b'original-audio')
        adapter=CloudMessagingAdapter(PlatformConfig(enabled=True),settings(),tmp_path)
        adapter.ledger.accept('delivery','chat',1,'binding'); adapter.current_delivery='delivery'
        frames=[]
        async def lose_receipt(action,**kwargs):
            frames.append(action)
            # The final control receipt is accepted; attachment enqueue confirmation is lost.
            return {'success':action['op']=='send','message_id':'queued'}
        adapter._transport=SimpleNamespace(send_outbound=lose_receipt)
        assert not (await adapter.send_voice('chat',str(source),caption='audio caption')).success
        event=MessageEvent(text='reply',message_id='delivery',source=SessionSource(platform=Platform.FEISHU,chat_id='chat'))
        # Replay acceptance before the turn completes, as a recovered transport would do.
        media=adapter.ledger.media_pending(1,'binding')[0]
        import json
        queued=json.loads(media['payload']); adapter.ledger.media_queued('delivery',queued['id'])
        await adapter.on_processing_complete(event,ProcessingOutcome.SUCCESS)
        assert adapter.ledger.get('delivery')['result']=='audio caption'
        source.write_bytes(b'changed-after-send')
        restored=CloudMessagingAdapter(PlatformConfig(enabled=True),settings(),tmp_path)
        frozen=restored.ledger.delivered_media('delivery')[0]
        assert unpack(frozen)==b'original-audio'
        assert restored.ledger.get('delivery')['result']=='audio caption'
        assert frames[-1]['content']=='audio caption'
    finally: reset_hermes_home_override(token)
