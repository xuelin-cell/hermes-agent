"""Loopback-only capability. The user's access token never enters this plugin."""

import json
import os
import sys
import types
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


# Keep launch credentials through plugin reload, remove them from terminal child environments.
transport = sys.modules.setdefault("_uniwork_telemetry_transport", types.ModuleType("_uniwork_telemetry_transport"))
address = os.environ.pop("UNIWORK_TELEMETRY_BRIDGE", "")
token = os.environ.pop("UNIWORK_TELEMETRY_TOKEN", "")
initial = os.environ.pop("UNIWORK_TELEMETRY_CONTEXT", "")
if address and token:
    transport.address, transport.token = address, token
    try:
        transport.initial = json.loads(initial)
    except ValueError:
        transport.initial = {}


def bridge_error(route, error):
    """Expose the failed stage/status without exception text (which can include paths or tokens)."""
    details = {"route": route, "type": type(error).__name__}
    if isinstance(error, HTTPError):
        details["status"] = error.code
    return details


def call_bridge(route, home, body=b"{}", account=""):
    address, token = getattr(transport, "address", ""), getattr(transport, "token", "")
    if not address.startswith("http://127.0.0.1:") or not token:
        raise RuntimeError("desktop bridge unavailable")
    request = Request(address + route, data=body, method="POST", headers={
        "Authorization": "Bearer " + token, "Content-Type": "application/json",
        "X-UniWork-Account": account,
        # Paths can contain non-ASCII characters; encode them as an HTTP-safe value.
        "X-UniWork-Profile": str(home).encode("utf-8").hex(),
    })
    try:
        with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=12) as response:
            return json.load(response)
    except HTTPError as error:
        if route == "/batch":
            return {"status": error.code}
        raise
