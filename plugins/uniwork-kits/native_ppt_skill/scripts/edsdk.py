#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""edsdk.py —— 本地 editor_sdk MCP 服务的轻封装（直连 POST /mcp，Agent 会话通过 IPC 登记备份）。

    python3 edsdk.py list [doc|sheet|slide|common]   # 列工具（名 + 一句话描述）
    python3 edsdk.py schema <工具名>                  # 查单个工具参数（★调用前必做）
    python3 edsdk.py call <工具名> [k=v ...] [--json '{...}'] [--json-file args.json]

未设置 editor_sdk_port 时，从 39099 起依次探测 10 个端口（39099-39108）；
设置后只使用指定端口。若服务启用鉴权，设 editor_sdk_token。
"""

import argparse
import json
import os
import re
import socket
import sys
import urllib.error
import urllib.request

DEFAULT_PORT = 39099
PORT_SCAN_COUNT = 10
DISCOVERY_TIMEOUT = 2
CONFIGURED_PORT = os.environ.get("editor_sdk_port", "").strip()
TOKEN = os.environ.get("editor_sdk_token", "")
CATEGORIES = ("doc", "sheet", "slide")
_ENDPOINT = None

# 本地直连，绕开环境里的 http_proxy/HTTP_PROXY/all_proxy 等代理设置（等价于 curl --noproxy）。
# 否则即便目标是 127.0.0.1，请求也可能被公司代理拦截，导致连接超时。
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _emit_error(msg, *, rpc_code=None):
    """失败信息必须落在 stdout（多数 Agent 只采集 stdout）；stderr 仅作镜像。"""
    payload = {"ok": False, "exit_code": 1, "error": msg}
    if rpc_code is not None:
        payload["rpc_code"] = rpc_code
    human = f"error: {msg}"
    machine = json.dumps(payload, ensure_ascii=False)
    print(human, flush=True)
    print(machine, flush=True)
    print(human, file=sys.stderr, flush=True)
    print(machine, file=sys.stderr, flush=True)
    sys.exit(1)


def _die(msg, rpc_code=None):
    _emit_error(msg, rpc_code=rpc_code)


def _endpoint(port):
    return f"http://127.0.0.1:{port}/mcp"


def _request(endpoint, method, params=None, timeout=30):
    data = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method,
                       "params": params or {}}).encode("utf-8")
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"
    req = urllib.request.Request(endpoint, data=data, headers=headers, method="POST")
    with _OPENER.open(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _discover_endpoint():
    """按端口顺序探测 editor_sdk，并缓存首个有效的 JSON-RPC 端点。"""
    global _ENDPOINT
    if _ENDPOINT:
        return _ENDPOINT
    if CONFIGURED_PORT:
        _ENDPOINT = _endpoint(CONFIGURED_PORT)
        return _ENDPOINT

    last_port = DEFAULT_PORT + PORT_SCAN_COUNT - 1
    for port in range(DEFAULT_PORT, DEFAULT_PORT + PORT_SCAN_COUNT):
        endpoint = _endpoint(port)
        try:
            obj = _request(endpoint, "tools/list", timeout=DISCOVERY_TIMEOUT)
        except urllib.error.HTTPError as e:
            if e.code == 401:
                _die("401 未授权：请设置环境变量 editor_sdk_token")
            continue
        except (urllib.error.URLError, ConnectionError, TimeoutError,
                UnicodeDecodeError, json.JSONDecodeError):
            continue
        result = obj.get("result") if isinstance(obj, dict) else None
        if (isinstance(obj, dict) and obj.get("jsonrpc") == "2.0"
                and isinstance(result, dict)
                and isinstance(result.get("tools"), list)):
            _ENDPOINT = endpoint
            return _ENDPOINT

    _die(f"连接失败（已依次探测端口 {DEFAULT_PORT}-{last_port}，"
         "editor_sdk 是否已运行？）")


def _ipc_request(address, action, **fields):
    capability = os.environ.get("CODEBUDDY_DOCUMENT_TOKEN")
    if not capability:
        raise OSError("缺少文档备份 IPC 凭证")
    message = json.dumps({"command": "DocumentBackup", "capability": capability,
                          "action": action, **fields}).encode("utf-8") + b"\n"

    def exchange(stream):
        remaining = memoryview(message)
        while remaining:
            written = stream.write(remaining)
            if not written:
                raise OSError("文档 IPC 写入中断")
            remaining = remaining[written:]
        response = stream.readline(1024 * 1024 + 1)
        if not response.endswith(b"\n") or len(response) > 1024 * 1024:
            raise OSError("文档 IPC 响应不完整或超过 1 MiB")
        result = json.loads(response.decode("utf-8"))
        if result.get("ok") is not True:
            raise OSError(result.get("error") or "文档备份 IPC 请求失败")
        return result

    if os.name == "nt":
        with open(address, "r+b", buffering=0) as pipe:
            return exchange(pipe)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(30)
        client.connect(address)
        with client.makefile("rwb", buffering=0) as stream:
            return exchange(stream)


def _result_data(response):
    result = response.get("result") or {}
    if result.get("structuredContent") is not None:
        return result["structuredContent"]
    for item in result.get("content") or []:
        if item.get("type") == "text":
            try:
                return json.loads(item.get("text", ""))
            except json.JSONDecodeError:
                pass
    return {}


def _succeeded(response):
    data = _result_data(response)
    return (not response.get("error") and not (response.get("result") or {}).get("isError")
            and data.get("success") is not False and data.get("code", 0) == 0)


def _document_request(address, endpoint, method, params):
    name = (params or {}).get("name", "")
    args = (params or {}).get("arguments") or {}
    edit = (re.match(r"^(doc|sheet|slide)_", name)
            and not re.match(r"^(doc|sheet|slide)_(get|list|read|search|render|export)(_|$)", name)
            and name not in ("doc_find", "doc_resolve_document_structure", "doc_compare_documents"))
    if not address:
        if method == "tools/call" and (edit or name == "save_file" or name.startswith("create_")):
            reason = os.environ.get("CODEBUDDY_DOCUMENT_BACKUP_ERROR") or "未接入文档备份"
            print(f"[document-backup] {reason}；继续执行，无法保证本次操作的会话回退", file=sys.stderr)
        return _request(endpoint, method, params)
    ticket = None
    if method == "tools/call" and (edit or name == "save_file"):
        try:
            file_id = args.get("file_id")
            path = args.get("file_path")
            target = path if name == "save_file" else None
            if not file_id or (name == "save_file" and not target):
                # editor_sdk 缺省 file_id 时按 file_path 字符串精确反查编辑器；保存还需要原路径
                key, value = ("file_id", file_id) if file_id else ("file_path", path)
                if not value:
                    raise OSError("文档编辑/保存需要 file_id 或 file_path")
                pool = _request(endpoint, "tools/call", {"name": "get_pool_status", "arguments": {}})
                if not _succeeded(pool):
                    raise OSError("无法查询文档实际路径")
                editor = next((e for e in _result_data(pool).get("open_editors", []) if e.get(key) == value), None)
                if editor is None:
                    raise OSError(f"未找到编辑器: {value}")
                file_id = editor.get("file_id")
                if name == "save_file":
                    target = target or editor.get("file_path")
            if name == "save_file":
                ticket = _ipc_request(address, "prepare", fileId=file_id, path=target).get("ticket")
                if not ticket:
                    raise OSError("文档备份 IPC 未返回保存凭证")
            else:
                # 编辑只改内存，保存时才快照；这里仅登记归属，供子代理结束时只保存自己改过的文档
                _ipc_request(address, "edit", fileId=file_id)
        except Exception as error:
            ticket = None
            print(f"[document-backup] 备份准备/归属登记失败，继续执行: {error}", file=sys.stderr)
    try:
        response = _request(endpoint, method, params)
    except Exception:
        if ticket:
            try:
                _ipc_request(address, "cancel", ticket=ticket)
            except Exception as error:
                print(f"[document-backup] 取消备份失败: {error}", file=sys.stderr)
        raise
    try:
        if ticket:
            action = "complete" if _succeeded(response) else "cancel"
            _ipc_request(address, action, ticket=ticket)
        elif address and method == "tools/call" and name.startswith("create_") and _succeeded(response):
            file_id = _result_data(response).get("file_id")
            if file_id:
                _ipc_request(address, "edit", fileId=file_id)
    except Exception as error:
        print(f"[document-backup] 备份登记失败，保留 SDK 执行结果: {error}", file=sys.stderr)
    return response


def _rpc(method, params=None):
    """发一条 JSON-RPC 请求，返回 result。Accept: application/json 走非流式分支。"""
    address = os.environ.get("CODEBUDDY_DOCUMENT_IPC_ADDRESS")
    endpoint = _discover_endpoint()
    try:
        obj = _document_request(address, endpoint, method, params)
    except urllib.error.HTTPError as e:
        _die("401 未授权：请设置环境变量 editor_sdk_token" if e.code == 401
             else f"HTTP {e.code} {e.reason}")
    except urllib.error.URLError as e:
        _die(f"连接失败（editor_sdk 是否在 {endpoint} 运行？）: {e.reason}")
    except TimeoutError as e:
        _die(f"连接超时（editor_sdk 是否在 {endpoint} 运行？）: {e}")
    except OSError as e:
        _die(str(e))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        _die(f"解析响应失败: {e}")
    if obj.get("error"):
        err = obj["error"]
        code = err.get("code")
        message = err.get("message") or ""
        _die(f"JSON-RPC 错误 {code}: {message}", rpc_code=code)
    return obj.get("result") or {}


def _tools():
    return _rpc("tools/list").get("tools", [])


def _category_of(name):
    p = name.split("_", 1)[0]
    return p if p in CATEGORIES else "common"


def _cmd_list(args):
    cat = args.category
    if cat and cat not in (*CATEGORIES, "common"):
        _die(f"未知品类 {cat!r}（应为 doc/sheet/slide/common）")
    rows = sorted((t["name"], (t.get("description") or "").split("\n", 1)[0].strip())
                  for t in _tools() if not cat or _category_of(t["name"]) == cat)
    if not rows:
        print("(无工具，或服务未运行)")
        return
    width = max(len(n) for n, _ in rows)
    for name, desc in rows:
        print(f"{name:<{width}}  {desc}")


def _cmd_schema(args):
    t = next((x for x in _tools() if x.get("name") == args.tool), None)
    if t is None:
        _die(f"未找到工具 {args.tool}（用 `list` 确认工具名）")
    schema = t.get("inputSchema") or {}
    props = schema.get("properties") or {}
    required = schema.get("required") or []

    print(f"# {t['name']}")
    if t.get("description"):
        print(f"\n{t['description'].strip()}")
    if not props:
        print("\n（无参数）")
    else:
        print("\n参数（✓=必填）：")
        ordered = [k for k in required if k in props] + [k for k in props if k not in required]
        for k in ordered:
            spec = props.get(k, {})
            typ = spec.get("type", "")
            if typ == "array" and isinstance(spec.get("items"), dict):
                typ = f"array<{spec['items'].get('type', '')}>".replace("<>", "")
            mark = "✓" if k in required else " "
            desc = (spec.get("description") or "").strip()
            if not desc:
                print(f"  [{mark}] {k} ({typ}):")
                continue
            lines = desc.splitlines()
            print(f"  [{mark}] {k} ({typ}): {lines[0].strip()}")
            for line in lines[1:]:
                print(f"      {line.rstrip()}")
    if args.raw:
        print("\n--- raw inputSchema ---")
        print(json.dumps(schema, ensure_ascii=False, indent=2))


def _cmd_call(args):
    arguments = {}
    for p in args.kv:
        if "=" not in p:
            _die(f"参数需为 key=value 形式，得到 {p!r}")
        k, v = p.split("=", 1)
        try:
            arguments[k] = json.loads(v)  # 数字/布尔/数组/对象/null 自动类型化
        except json.JSONDecodeError:
            arguments[k] = v
    if args.json_file:
        try:
            with open(args.json_file, "r", encoding="utf-8") as f:
                extra = json.load(f)
        except OSError as e:
            _die(f"读取 --json-file 失败: {e}")
        except json.JSONDecodeError as e:
            _die(f"--json-file 不是合法 JSON: {e}")
        if not isinstance(extra, dict):
            _die("--json-file 必须是一个 JSON 对象")
        arguments.update(extra)
    if args.json_blob:
        try:
            extra = json.loads(args.json_blob)
        except json.JSONDecodeError as e:
            _die(f"--json 不是合法 JSON: {e}")
        if not isinstance(extra, dict):
            _die("--json 必须是一个 JSON 对象")
        arguments.update(extra)

    result = _rpc("tools/call", {"name": args.tool, "arguments": arguments})
    texts = [c.get("text", "") for c in (result.get("content") or [])
             if isinstance(c, dict) and c.get("type") == "text"]
    print("\n".join(texts) if texts else json.dumps(result, ensure_ascii=False, indent=2))


def main(argv=None):
    endpoint_hint = (_endpoint(CONFIGURED_PORT) if CONFIGURED_PORT else
                     f"自动探测端口 {DEFAULT_PORT}-{DEFAULT_PORT + PORT_SCAN_COUNT - 1}")
    ap = argparse.ArgumentParser(prog="edsdk.py",
                                 description=f"editor_sdk MCP 轻封装（{endpoint_hint}）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("list", help="列出工具（工具名 + 一句话描述）")
    p.add_argument("category", nargs="?", help="可选品类：doc/sheet/slide/common")
    p.set_defaults(func=_cmd_list)

    p = sub.add_parser("schema", help="查单个工具的完整参数 schema（调用前必做）")
    p.add_argument("tool", help="工具名，如 doc_insert_text")
    p.add_argument("--raw", action="store_true", help="附带打印原始 inputSchema JSON")
    p.set_defaults(func=_cmd_schema)

    p = sub.add_parser("call", help="调用工具")
    p.add_argument("tool", help="工具名")
    p.add_argument("kv", nargs="*", help="key=value 入参（值优先按 JSON 解析）")
    p.add_argument("--json", dest="json_blob", help="完整 arguments JSON 对象（与 k=v 合并，同名以此为准）")
    p.add_argument("--json-file", dest="json_file", help="从文件读取 arguments JSON 对象（大 payload 用此）")
    p.set_defaults(func=_cmd_call)

    args = ap.parse_args(argv)
    try:
        args.func(args)
    except SystemExit:
        raise
    except Exception as e:
        _emit_error(f"edsdk 未捕获异常: {e}")


if __name__ == "__main__":
    main()
