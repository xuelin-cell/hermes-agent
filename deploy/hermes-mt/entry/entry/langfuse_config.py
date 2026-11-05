"""Provision the unmodified tracing plugin without giving instances a MaaS JWT."""
from urllib.parse import urlsplit


def upload_url(settings):
    origin = settings.langfuse_entry_url
    if not origin:
        return ''
    parsed = urlsplit(origin)
    _ = parsed.port
    if (parsed.scheme not in {'http', 'https'} or not parsed.hostname
            or parsed.username or parsed.password or parsed.path not in {'', '/'}
            or parsed.query or parsed.fragment or '\\' in origin
            or any(c.isspace() for c in origin)):
        raise ValueError('MT_LANGFUSE_ENTRY_URL must be an instance-reachable HTTP(S) origin')
    return origin.rstrip('/') + settings.api_path('/__entry/langfuse')


async def credential_lines(settings, store, user_id):
    url = upload_url(settings)
    if not url:
        return []
    credential = await store.ensure_langfuse_credentials(user_id)
    return [
        f'HERMES_LANGFUSE_PUBLIC_KEY={credential.public_key}',
        f'HERMES_LANGFUSE_SECRET_KEY={credential.secret_key}',
        f'HERMES_LANGFUSE_BASE_URL={url}',
        # Cloud integration deliberately uses the plugin's existing full mode.
        'HERMES_LANGFUSE_CAPTURE=full',
    ]
