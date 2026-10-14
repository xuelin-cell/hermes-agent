"""M01 独立 stdio MCP；只回显测试标记，不访问网络、模型或用户文件。"""

import json
import sys


def serve(marker: str) -> None:
    """完成真实 MCP 握手、工具发现和调用，用标记辨别账号或 Profile。"""
    for line in sys.stdin:
        request = json.loads(line)
        if "id" not in request:
            continue
        method = request["method"]
        result = {}
        if method == "initialize":
            result = {
                "protocolVersion": request["params"]["protocolVersion"],
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "desktop-mcp-fixture", "version": "1"},
            }
        elif method == "tools/list":
            result = {"tools": [{
                "name": "echo_marker", "description": "Read fixture marker",
                "inputSchema": {"type": "object", "properties": {}},
                "annotations": {"readOnlyHint": True},
            }]}
        elif method == "tools/call":
            result = {"content": [{"type": "text", "text": marker}]}
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)


if __name__ == "__main__":
    serve(sys.argv[1])
