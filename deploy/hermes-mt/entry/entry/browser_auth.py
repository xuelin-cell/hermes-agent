"""Bind browser-held MaaS credentials to an existing Entry session without DB storage."""

from __future__ import annotations

import hashlib
import json
import secrets
import time
from dataclasses import dataclass, field

from aiohttp import web

from .crypto import CredentialCipher, CredentialError
from .store import Session


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class BrowserIdentity:
    user_id: str
    login_id: str
    expires_at: int  # milliseconds, matching the browser login response
    token: str = field(repr=False)
    session_sid: str = field(default="", repr=False)


class BrowserAuth:
    """The authenticated cookie contains only a token digest, never the bearer itself."""

    def __init__(self, cipher: CredentialCipher):
        self.cipher = cipher

    def issue(self, session: Session, token: str, expires_at: int) -> tuple[str, dict]:
        expires_at = min(expires_at, session.expires_at * 1000)
        login_id = secrets.token_urlsafe(18)
        proof = self.cipher.encrypt(json.dumps({
            "purpose": "browser-maas-v1", "session": _digest(session.sid),
            "user": session.user_id, "token": _digest(token),
            "login": login_id, "expires": expires_at,
        }))
        return proof.decode("ascii"), {"token": token, "expiresAt": expires_at, "loginId": login_id}

    def require(self, session: Session, proof: str, authorization: str) -> BrowserIdentity:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not token or len(token) > 16384:
            raise web.HTTPUnauthorized(text="maas_auth_required")
        try:
            claims = json.loads(self.cipher.decrypt(proof.encode("utf-8")))
            valid = (
                isinstance(claims, dict)
                and claims.get("purpose") == "browser-maas-v1"
                and claims.get("session") == _digest(session.sid)
                and claims.get("user") == session.user_id
                and isinstance(claims.get("token"), str)
                and secrets.compare_digest(claims["token"], _digest(token))
                and isinstance(claims.get("expires"), int)
                and time.time() * 1000 < claims["expires"] <= session.expires_at * 1000
                and isinstance(claims.get("login"), str)
            )
        except (CredentialError, UnicodeError, ValueError, TypeError):
            valid = False
        if not valid:
            raise web.HTTPUnauthorized(text="maas_auth_required")
        return BrowserIdentity(session.user_id, claims["login"], claims["expires"], token, session.sid)
