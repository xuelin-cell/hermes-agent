"""Durable messaging ownership, dedupe, execution leases and outbound receipts."""
import json
import secrets

from aiohttp import web


class MessagingStore:
    def __init__(self, database, cipher):
        self.database, self.cipher = database, cipher

    async def binding(self, user, platform='uniagentgate'):
        async with self.database.acquire() as db:
            return await db.fetchrow('SELECT * FROM messaging_bindings WHERE user_id=$1 AND platform=$2 AND deleted_at IS NULL', user, platform)

    async def configure(self, user, gateway, agent_id, secret, *, platform="uniagentgate", enable=False, plan=None):
        if platform not in {"uniagentgate", "dingtalk", "weixin", "wecom", "feishu"}: raise ValueError("Unsupported platform")
        async with self.database.acquire() as db, db.transaction():
            await db.execute('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', 'messaging:'+user)
            await db.execute('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', 'messaging-bot:'+platform+':'+agent_id)
            if plan is not None:
                active = await db.fetchval("SELECT user_id FROM users WHERE user_id=$1 AND status='active' FOR SHARE",user)
                if not active: raise web.HTTPNotFound(text='用户配置不存在或用户已停用。')
            row = await self._configure(db,user,gateway,agent_id,secret,platform)
            if enable and not row['enabled']:
                row = dict(await db.fetchrow("UPDATE messaging_bindings SET enabled=true,revision=revision+1,connection_state='stopped',updated_at=now() WHERE id=$1 RETURNING *",row['id']))
            if plan is not None:
                await self._save_plan(db,user,plan)
                await db.execute("UPDATE messaging_bindings SET source='service-provision' WHERE id=$1",row['id'])
            return row

    async def _save_plan(self, db, user, plan):
        from .store import Store
        base,model=plan.endpoint()
        await db.execute("""INSERT INTO tenant_model_config(user_id,default_base_url,default_model,model_catalog,synced_at)
            VALUES($1,$2,$3,$4::jsonb,now()) ON CONFLICT(user_id) DO UPDATE SET
            default_base_url=EXCLUDED.default_base_url,default_model=EXCLUDED.default_model,
            model_catalog=EXCLUDED.model_catalog,synced_at=now()""",user,base,model,Store._catalog_json(plan.catalog(),plan.limits()))
        await db.execute("""INSERT INTO tenant_credentials(user_id,api_key_ciphertext) VALUES($1,$2)
            ON CONFLICT(user_id) DO UPDATE SET api_key_ciphertext=EXCLUDED.api_key_ciphertext,updated_at=now()""",user,self.cipher.encrypt(plan.api_key))

    async def _configure(self, db, user, gateway, agent_id, secret, platform):
        encoded = self.cipher.encrypt(secret)
        old = await db.fetchrow("SELECT * FROM messaging_bindings WHERE user_id=$1 AND platform=$2 AND deleted_at IS NULL FOR UPDATE", user, platform)
        if old and old['bot_key'] == agent_id and json.loads(old['config']).get('gateway_url') == gateway and self.cipher.decrypt(old['secret_enc']) == secret:
            return dict(old)
        owner = await db.fetchval("SELECT user_id FROM messaging_bindings WHERE platform=$2 AND bot_key=$1 AND deleted_at IS NULL", agent_id, platform)
        if owner and owner != user:
            raise web.HTTPConflict(text='此 cloud Agent 已属于另一个账号。')
        if old:
            await self._cancel(db, old['id'])
            if old['bot_key'] == agent_id:
                return dict(await db.fetchrow("UPDATE messaging_bindings SET config=$2::jsonb,secret_enc=$3,revision=revision+1,connection_state='stopped',updated_at=now() WHERE id=$1 RETURNING *",
                    old['id'], json.dumps({'gateway_url': gateway}), encoded))
            await db.execute('UPDATE messaging_bindings SET deleted_at=now(),enabled=false,revision=revision+1 WHERE id=$1', old['id'])
        return dict(await db.fetchrow("INSERT INTO messaging_bindings(id,user_id,platform,bot_key,config,secret_enc,source) VALUES($1,$2,$6,$3,$4::jsonb,$5,CASE WHEN $6='uniagentgate' THEN 'sms-login' ELSE 'user-config' END) RETURNING *",
            secrets.token_hex(16), user, agent_id, json.dumps({'gateway_url': gateway}), encoded, platform))

    async def _cancel(self, db, binding_id):
        # In-flight execution becomes uncertain, never silently reruns under new credentials.
        await db.execute("UPDATE messaging_inbox SET state=CASE WHEN state IN ('dispatching','accepted','running') THEN 'uncertain' ELSE 'cancelled' END,lease_until=NULL,lease_owner=NULL,updated_at=now() WHERE binding_id=$1 AND state NOT IN ('completed','failed','uncertain','cancelled')", binding_id)
        await db.execute("UPDATE messaging_outbox SET state=CASE WHEN state='sending' THEN 'unknown' ELSE 'cancelled' END,updated_at=now() WHERE delivery_id IN(SELECT delivery_id FROM messaging_inbox WHERE binding_id=$1) AND state IN('pending','sending')", binding_id)

    async def set_enabled(self, user, enabled, *, remove=False, platform="uniagentgate", missing_ok=False):
        async with self.database.acquire() as db, db.transaction():
            await db.execute('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', 'messaging:'+user)
            row = await db.fetchrow("SELECT * FROM messaging_bindings WHERE user_id=$1 AND platform=$2 AND deleted_at IS NULL FOR UPDATE", user, platform)
            if not row:
                if missing_ok: return
                raise web.HTTPConflict(text='短信登录尚未提供有效的 cloud Agent 凭据。')
            await self._cancel(db, row['id'])
            await db.execute("UPDATE messaging_bindings SET enabled=$2,revision=revision+1,connection_state='stopped',updated_at=now(),deleted_at=CASE WHEN $3 THEN now() ELSE deleted_at END WHERE id=$1", row['id'], enabled, remove)

    async def seen(self,binding_id,revision,chat,message_id):
        async with self.database.acquire() as db, db.transaction():
            binding=await db.fetchrow("SELECT b.* FROM messaging_bindings b JOIN users u ON u.user_id=b.user_id WHERE b.id=$1 AND b.revision=$2 AND b.enabled AND b.deleted_at IS NULL AND u.status='active' FOR SHARE OF b",binding_id,revision)
            if not binding: raise web.HTTPConflict(text='Binding changed')
            return bool(await db.fetchval('SELECT 1 FROM messaging_inbox WHERE platform=$1 AND bot_key=$2 AND external_chat_id=$3 AND external_message_id=$4',binding['platform'],binding['bot_key'],chat,message_id))

    async def groups(self,user,enabled=None,ids=None):
        async with self.database.acquire() as db, db.transaction():
            await db.execute('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','messaging:'+user)
            row=await db.fetchrow("SELECT * FROM messaging_bindings WHERE user_id=$1 AND platform='weixin' AND deleted_at IS NULL FOR UPDATE",user)
            if not row: raise web.HTTPConflict(text='请先扫码绑定微信。')
            config=json.loads(row['config'])
            if enabled is not None:
                if not isinstance(enabled,bool) or not isinstance(ids,list) or len(ids)>100 or any(not isinstance(value,str) or not value or len(value)>256 or any(char.isspace() for char in value) for value in ids):
                    raise web.HTTPBadRequest(text='群 ID 格式无效。')
                ids=list(dict.fromkeys(ids))
                if enabled and not ids: raise web.HTTPBadRequest(text='启用群聊时请填写允许接收的群 ID。')
                policy='open' if enabled else 'disabled'
                if config.get('group_policy','disabled')!=policy or config.get('group_ids',[])!=ids:
                    config.update(group_policy=policy,group_ids=ids)
                    await db.execute("UPDATE messaging_bindings SET config=$2::jsonb,updated_at=now() WHERE id=$1",row['id'],json.dumps(config))
            return {'enabled':config.get('group_policy')=='open','group_ids':config.get('group_ids',[])}

    async def ingest(self, binding_id, revision, chat, message_id, payload):
        async with self.database.acquire() as db, db.transaction():
            binding = await db.fetchrow("SELECT b.* FROM messaging_bindings b JOIN users u ON u.user_id=b.user_id WHERE b.id=$1 AND b.revision=$2 AND b.enabled AND b.deleted_at IS NULL AND u.status='active' FOR SHARE OF b", binding_id, revision)
            if not binding:
                raise web.HTTPConflict(text='Binding changed')
            delivery = secrets.token_hex(16)
            result = await db.fetchval('''INSERT INTO messaging_inbox(delivery_id,binding_id,binding_revision,platform,bot_key,external_chat_id,external_message_id,payload,user_id)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT(platform,bot_key,external_chat_id,external_message_id) DO NOTHING RETURNING delivery_id''',
                delivery,binding_id,revision,binding['platform'],binding['bot_key'],chat,message_id,json.dumps(payload),binding['user_id'])
            return result or await db.fetchval('SELECT delivery_id FROM messaging_inbox WHERE platform=$1 AND bot_key=$2 AND external_chat_id=$3 AND external_message_id=$4', binding['platform'],binding['bot_key'],chat,message_id)

    async def claim(self, owner, lease_seconds=90):
        async with self.database.acquire() as db, db.transaction():
            # The lifecycle advisory lock serializes admission per tenant without
            # locking users against lifecycle audit foreign keys.
            row = await db.fetchrow('''SELECT i.delivery_id,b.user_id FROM messaging_inbox i JOIN messaging_bindings b ON b.id=i.binding_id
                JOIN users u ON u.user_id=b.user_id WHERE u.status='active' AND i.state='queued' AND i.next_at<=now() AND b.enabled AND b.deleted_at IS NULL AND b.revision=i.binding_revision
                AND NOT EXISTS(SELECT 1 FROM messaging_inbox q WHERE q.user_id=i.user_id AND q.state='queued'
                    AND (q.created_at,q.delivery_id)<(i.created_at,i.delivery_id))
                AND NOT EXISTS(SELECT 1 FROM messaging_inbox x JOIN messaging_bindings xb ON xb.id=x.binding_id
                    WHERE xb.user_id=b.user_id AND xb.deleted_at IS NULL AND xb.revision=x.binding_revision
                    AND x.state IN('dispatching','accepted','running','uncertain'))
                ORDER BY i.created_at FOR UPDATE OF i SKIP LOCKED LIMIT 1''')
            if not row:
                return None
            from .store import advisory_key
            if not await db.fetchval('SELECT pg_try_advisory_xact_lock($1)', advisory_key(row['user_id'])):
                return None
            if await db.fetchval("SELECT 1 FROM messaging_inbox x JOIN messaging_bindings b ON b.id=x.binding_id WHERE x.user_id=$1 AND b.deleted_at IS NULL AND b.revision=x.binding_revision AND x.state IN('dispatching','accepted','running','uncertain') LIMIT 1",row['user_id']):
                return None
            return dict(await db.fetchrow("UPDATE messaging_inbox SET state='dispatching',lease_owner=$2,lease_until=now()+$3*interval '1 second',attempts=attempts+1,updated_at=now() WHERE delivery_id=$1 RETURNING *",row['delivery_id'],owner,lease_seconds)) | {'user_id':row['user_id']}

    async def renew(self, delivery, owner):
        async with self.database.acquire() as db:
            return bool(await db.fetchval("UPDATE messaging_inbox SET lease_until=now()+interval '90 seconds',updated_at=now() WHERE delivery_id=$1 AND lease_owner=$2 AND state IN('dispatching','accepted','running') AND lease_until>now() RETURNING delivery_id",delivery,owner))

    async def complete(self, delivery, owner, epoch, content):
        async with self.database.acquire() as db, db.transaction():
            binding_id = await db.fetchval('SELECT binding_id FROM messaging_inbox WHERE delivery_id=$1',delivery)
            # Binding mutations lock binding -> inbox; use the same order here.
            if binding_id:
                await db.execute('SELECT id FROM messaging_bindings WHERE id=$1 FOR UPDATE',binding_id)
            row = await db.fetchrow('''SELECT i.*,b.enabled,b.revision,b.deleted_at FROM messaging_inbox i JOIN messaging_bindings b ON b.id=i.binding_id
                WHERE i.delivery_id=$1 FOR UPDATE OF i''',delivery)
            if (not row or not owner or row['lease_owner'] != owner or row['state'] not in {'accepted','running','uncertain','completed'} or row['instance_epoch'] != epoch or not row['enabled'] or row['deleted_at'] or row['binding_revision'] != row['revision']):
                raise web.HTTPConflict(text='Execution ownership changed')
            existing = await db.fetchrow('SELECT * FROM messaging_outbox WHERE delivery_id=$1 AND part_index=0',delivery)
            if existing:
                if json.loads(existing['payload']) != content:
                    raise web.HTTPConflict(text='Completed content changed')
                return existing['outbound_id']
            outbound = secrets.token_hex(16)
            await db.execute('INSERT INTO messaging_outbox(outbound_id,delivery_id,binding_revision,payload) VALUES($1,$2,$3,$4::jsonb)',outbound,delivery,row['binding_revision'],json.dumps(content))
            await db.execute("UPDATE messaging_inbox SET state='completed',lease_until=NULL,updated_at=now() WHERE delivery_id=$1",delivery)
            return outbound

    async def record_media(self, delivery, owner, epoch, media):
        from plugins.cloud_messaging.media import unpack,MAX_MESSAGE_BYTES
        unpack(media)
        if set(media)-{'id','name','kind','mime','data','caption'} or not isinstance(media.get('caption',''),str) or len(media.get('caption',''))>20000: raise ValueError('Invalid media fields')
        async with self.database.acquire() as db, db.transaction():
            binding_id=await db.fetchval('SELECT binding_id FROM messaging_inbox WHERE delivery_id=$1',delivery)
            if binding_id: await db.execute('SELECT id FROM messaging_bindings WHERE id=$1 FOR UPDATE',binding_id)
            row=await db.fetchrow("SELECT i.*,b.enabled,b.revision,b.deleted_at FROM messaging_inbox i JOIN messaging_bindings b ON b.id=i.binding_id WHERE delivery_id=$1 FOR UPDATE OF i",delivery)
            if not row or row['lease_owner']!=owner or row['instance_epoch']!=epoch or not row['enabled'] or row['deleted_at'] or row['revision']!=row['binding_revision'] or row['state'] not in {'accepted','running','completed','uncertain'}:
                raise web.HTTPConflict(text='Media execution ownership changed')
            existing=await db.fetchval("SELECT outbound_id FROM messaging_outbox WHERE delivery_id=$1 AND payload->'media'->>'id'=$2",delivery,media['id'])
            if existing: return existing
            part=await db.fetchval('SELECT COALESCE(MAX(part_index),0)+1 FROM messaging_outbox WHERE delivery_id=$1',delivery)
            total=await db.fetchval("SELECT COALESCE(sum(octet_length(payload->'media'->>'data')),0) FROM messaging_outbox WHERE delivery_id=$1",delivery)
            if part>20 or total+len(media['data'])>((MAX_MESSAGE_BYTES+2)//3)*4: raise ValueError('Execution attachment limit exceeded')
            outbound=secrets.token_hex(16)
            await db.execute('INSERT INTO messaging_outbox(outbound_id,delivery_id,part_index,binding_revision,payload) VALUES($1,$2,$3,$4,$5::jsonb)',outbound,delivery,part,row['binding_revision'],json.dumps({'media':media}))
            return outbound

    async def recover(self, *, startup=False):
        async with self.database.acquire() as db, db.transaction():
            if startup:
                await db.execute("UPDATE messaging_outbox SET state='unknown',error_code='sender_restarted',updated_at=now() WHERE state='sending'")
            # Active rows are queried/reconciled with the original instance; never requeue them here.
            await db.execute("UPDATE messaging_inbox SET state='uncertain',error_code='lease_expired',lease_until=NULL,updated_at=now() WHERE state IN('dispatching','accepted','running') AND lease_until<=now()")
