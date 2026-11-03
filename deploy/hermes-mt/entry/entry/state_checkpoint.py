"""Confirm a user's current instance state is durable before acknowledging a change."""
import re


async def checkpoint(entry, user, tenant):
    await entry._touch(user)
    if entry.s.backend == 'cube' and not tenant.sandbox_id:
        raise RuntimeError('missing_sandbox')
    if tenant.sandbox_id:
        runtime = await entry.store.get_runtime(user)
        if runtime.sandbox_id != tenant.sandbox_id:
            raise RuntimeError('instance_replaced')
        result = await entry.cube.sync_state(tenant.sandbox_id, entry.s.forward_port, tenant.token)
        summary = result.get('archive') or {}
        if (result.get('ok') is not True or summary.get('owner') != tenant.sandbox_id
                or not summary.get('archive') or not re.fullmatch(r'[0-9a-f]{64}', summary.get('sha256', ''))):
            raise RuntimeError('archive_unconfirmed')
        await entry.store.set_state_archive(user, summary['archive'], summary)
