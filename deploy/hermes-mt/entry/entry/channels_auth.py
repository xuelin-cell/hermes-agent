"""Per-instance relay secrets bind the socket to a tenant and instance generation."""
import base64
import hashlib
import hmac
import time


def instance_secret(master, user, epoch, revision, binding=""):
    suffix = ":" + binding if binding else ""
    return hmac.new(master.encode(), f'{user}:{epoch}:{revision}{suffix}'.encode(), hashlib.sha256).hexdigest()


def verify_upgrade(token, master):
    try:
        raw = base64.urlsafe_b64decode(token + '=' * (-len(token) % 4)).decode()
        payload, expires, signature = raw.rsplit(':', 2)
        parts = payload.rsplit('.', 3)
        binding = parts[-1] if len(parts)==4 and len(parts[-1])==32 else ''
        user, epoch, revision = payload.rsplit('.',3)[:3] if binding else payload.rsplit('.',2)
        secret = instance_secret(master, user, int(epoch), int(revision), binding)
        expected = hmac.new(secret.encode(), f'{payload}:{expires}'.encode(), hashlib.sha256).hexdigest()
        if not user or not time.time() < int(expires) <= time.time() + 600 or not hmac.compare_digest(signature.encode('ascii'), expected.encode('ascii')):
            raise ValueError()
        return (user, int(epoch), int(revision), binding) if binding else (user, int(epoch), int(revision))
    except (ValueError, UnicodeError):
        return None
