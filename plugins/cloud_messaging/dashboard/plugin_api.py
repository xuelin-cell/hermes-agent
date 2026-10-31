"""Entry-only drain of the durable notification outbox; no public send proxy."""
import hmac
import os
from fastapi import APIRouter, HTTPException, Request
from plugins.cloud_messaging.notifications import Notifications

router = APIRouter()


def authorize(request):
    expected = os.environ.get('HERMES_DASHBOARD_SESSION_TOKEN', '')
    if not expected or not hmac.compare_digest(request.headers.get('X-Hermes-Entry-Token', ''), expected):
        raise HTTPException(403)
    from hermes_constants import get_hermes_home
    return Notifications(get_hermes_home())


@router.post('/notifications')
async def notifications(request: Request):
    store = authorize(request)
    data = await request.json()
    if data.get('operation') == 'list': return {'items': store.pending()}
    if data.get('operation') == 'ack':
        store.acknowledge(data.get('id'), data.get('state'))
        return {'ok': True}
    raise HTTPException(400)
