"""Local MCP transport fixture: no external service, credentials or generated image."""

import json
import os

from mcp.server import MCPServer
from mcp_types import ToolAnnotations

server = MCPServer("telemetry-fixture")


def record(tool, **values):
    with open(os.environ["TELEMETRY_MCP_LOG"], "a", encoding="utf-8") as stream:
        stream.write(json.dumps({"tool": tool, **values}) + "\n")


@server.tool(annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False))
def txt2img_generate(fail: bool = False) -> str:
    """Return an image-generation fixture receipt, including a business-error case."""
    record("txt2img_generate", fail=fail)
    return json.dumps({"success": False, "error": "fixture refusal"} if fail else {"success": True, "result": "fixture image"})


@server.tool(annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False))
def route() -> str:
    """Return a connector fixture receipt."""
    record("route")
    return json.dumps({"success": True, "result": "fixture route"})


if __name__ == "__main__":
    server.run(transport="stdio")
