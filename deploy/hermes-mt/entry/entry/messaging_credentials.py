"""Cloud channel credentials are accepted only from the trusted SMS-login plan."""
from urllib.parse import urlsplit, urlunsplit

MISSING = object()


def cloud_binding(plan, allowed_origins):
    if not isinstance(plan, dict):
        return 'missing', None
    if plan.get('uniagentgate', MISSING) is None:
        return 'clear', None
    fields = ('ipUrl', 'agentIdCloud', 'agentKeyCloud')
    if not any(field in plan for field in fields):
        return 'missing', None
    if not all(isinstance(plan.get(field), str) and plan[field].strip() and all(32 <= ord(c) < 127 for c in plan[field]) for field in fields):
        return 'invalid', None
    try:
        url = urlsplit(plan['ipUrl'].strip())
        origin = f'{url.scheme}://{url.netloc.lower()}'
        if url.scheme not in {'https', 'http'} or not url.hostname or url.username or url.password or url.query or url.fragment or (allowed_origins and origin not in allowed_origins):
            return 'invalid', None
        agent, secret = plan['agentIdCloud'].strip(), plan['agentKeyCloud'].strip()
        if len(agent) > 256 or len(secret) > 4096 or '${' in secret:
            return 'invalid', None
        return 'available', {'gateway':urlunsplit((url.scheme,url.netloc.lower(),url.path.rstrip('/'),'','')), 'agent_id':agent,'secret':secret}
    except ValueError:
        return 'invalid', None
