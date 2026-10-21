"""元景工具调用前自动上传本机文件：只传允许的位置，换成 ossPath，失败时说明原因。"""

from datetime import datetime, timezone
import json
import os
import time
from types import SimpleNamespace

import httpx
import pytest

from tests.plugins.test_desktop_deliverables_fallback import delivery  # noqa: F401

HOST = "https://obs-nmhhht6.cucloud.cn"
SIGNED = "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=secret"


def upload_answer(name):
    """与元景上传工具的真实返回同形：文字里带上传地址、请求头和下载链接。"""
    url = f"{HOST}/app-agent-prod/temp/{name}{SIGNED}"
    return json.dumps(
        {
            "result": "已生成文件上传地址，请使用 PUT 方法上传文件。\n"
            f"上传地址：{url} 方法：PUT\n请求头：Content-Type=image/png\n下载链接：{url} PUT 成功"
        },
        ensure_ascii=False,
    )


@pytest.fixture
def uploads(delivery, monkeypatch):  # noqa: F811
    """注册真实钩子；元景工具与对象存储都换成本地记录，不连网络。"""
    plugin, work = delivery
    from fallback_delivery import uploads as module

    hooks = {}

    class Context:
        """只收集插件公开注册的钩子。"""

        def register_hook(self, name, handler):
            """同名钩子按注册顺序保存。"""
            hooks.setdefault(name, []).append(handler)

    plugin.register(Context())
    calls, puts = [], []
    state = SimpleNamespace(
        tools={"mcp__UniAI_Toolkit__get_oss_upload_url"}, status=200
    )

    def call_tool(name, args):
        """记录对上传工具的调用，按序号给出不同的对象名。"""
        calls.append((name, args))
        return upload_answer(f"obj{len(calls)}.png")

    def handler(request):
        """记录 PUT 的地址、类型和内容。"""
        puts.append((str(request.url), request.headers["content-type"], request.read()))
        return httpx.Response(state.status)

    real_client = httpx.Client
    monkeypatch.setattr(module, "has_tool", lambda name: name in state.tools)
    monkeypatch.setattr(module, "call_tool", call_tool)
    monkeypatch.setattr(
        module,
        "httpx",
        SimpleNamespace(
            Client=lambda **kw: real_client(
                transport=httpx.MockTransport(handler), **kw
            )
        ),
    )
    home = module.attachments_folder()
    home.mkdir(parents=True)
    return SimpleNamespace(
        plugin=plugin,
        module=module,
        hooks=hooks,
        work=work,
        home=home,
        calls=calls,
        puts=puts,
        state=state,
    )


def before(env, tool, args, session="s"):
    """按原生顺序运行全部 pre_tool_call 钩子，返回上传钩子的结果。"""
    results = [
        handler(
            tool_name=tool, args=args, session_id=session, task_id=session, turn_id="t"
        )
        for handler in env.hooks["pre_tool_call"]
    ]
    return next((result for result in results if result), None)


def test_attachment_is_uploaded_once_and_replaced_with_oss_path(uploads):
    """附件目录里的图片上传一次换成 ossPath，签名链接不进参数；同一文件再用不重传。"""
    image = uploads.home / "猫 咪.png"
    image.write_bytes(b"png-bytes")
    args = {"image_url": str(image), "prompt": "让它动起来"}
    result = before(uploads, "mcp__UniAI_Toolkit__img2vid_generate", args)
    assert result == {
        "action": "modify",
        "args": {"image_url": "app-agent-prod/temp/obj1.png"},
    }
    assert uploads.calls == [
        ("mcp__UniAI_Toolkit__get_oss_upload_url", {"fileName": "猫 咪.png"})
    ]
    url, content_type, body = uploads.puts[0]
    assert url.startswith(HOST + "/app-agent-prod/temp/obj1.png")
    assert content_type == "image/png" and body == b"png-bytes"
    again = before(
        uploads,
        "mcp__UniAI_Toolkit__analyze_image",
        {"image_url_or_oss_path": str(image)},
    )
    assert again["args"]["image_url_or_oss_path"] == "app-agent-prod/temp/obj1.png"
    assert len(uploads.calls) == 1 and len(uploads.puts) == 1
    # 文件改过就重新上传。
    image.write_bytes(b"changed")
    assert before(uploads, "mcp__UniAI_Toolkit__analyze_image", {"x": str(image)})
    assert len(uploads.puts) == 2


def test_list_arguments_and_working_directory_files(uploads):
    """列表参数逐项处理，网络地址和 ossPath 原样保留；工作目录里的相对路径也能用。"""
    (uploads.work / "outputs").mkdir()
    (uploads.work / "outputs" / "a.png").write_bytes(b"a")
    images = [
        "outputs/a.png",
        HOST + "/app-agent-prod/temp/x.png",
        "app-agent-prod/temp/y.png",
    ]
    result = before(
        uploads,
        "mcp__UniAI_Toolkit__image_edit",
        {"images": images, "prompt": "红色背景"},
    )
    assert result["args"] == {
        "images": ["app-agent-prod/temp/obj1.png", images[1], images[2]]
    }


def test_files_pasted_earlier_in_the_session_are_allowed(uploads, tmp_path):
    """会话里贴过的图片在别的目录也能上传；其它目录的文件拦下并说明原因。"""
    pasted = tmp_path / "composer images" / "p.png"
    other = tmp_path / "private" / "id.png"
    for file in (pasted, other):
        file.parent.mkdir()
        file.write_bytes(b"x")
    remember = uploads.hooks["pre_llm_call"][-1]
    context = remember(
        session_id="s",
        user_message="把它做成视频",
        conversation_history=[
            {"role": "user", "content": f'看看这张\n@image:"{pasted}"'},
            {"role": "assistant", "content": f"@image:{other}"},
        ],
    )
    assert "直接填本机绝对路径" in context["context"]
    assert (
        before(
            uploads, "mcp__UniAI_Toolkit__img2vid_generate", {"image_url": str(pasted)}
        )["action"]
        == "modify"
    )
    blocked = before(
        uploads, "mcp__UniAI_Toolkit__img2vid_generate", {"image_url": str(other)}
    )
    assert blocked["action"] == "block" and "没有自动上传" in blocked["message"]
    assert str(uploads.work) in blocked["message"]
    # 另一个会话看不到这个会话贴过的文件。
    assert (
        before(
            uploads,
            "mcp__UniAI_Toolkit__img2vid_generate",
            {"image_url": str(pasted)},
            "b",
        )["action"]
        == "block"
    )
    assert len(uploads.puts) == 1


def test_only_remote_toolkit_tools_with_local_files_are_touched(uploads):
    """非元景工具、上传工具本身、没有上传工具的服务器、普通文字参数都不动。"""
    image = uploads.home / "a.png"
    image.write_bytes(b"a")
    for tool, args in [
        ("terminal", {"command": str(image)}),
        ("mcp__UniAI_Toolkit__get_oss_upload_url", {"fileName": str(image)}),
        ("mcp__UniAI_Toolkit__confirm_oss_upload", {"ossPath": str(image)}),
        ("mcp__playwright__browser_file_upload", {"paths": [str(image)]}),
        (
            "mcp__UniAI_Toolkit__txt2img_generate",
            {"prompt": "一只猫", "size": "1024*1024"},
        ),
        (
            "mcp__UniAI_Toolkit__analyze_image",
            {"image_url_or_oss_path": str(image) + ".missing"},
        ),
    ]:
        assert before(uploads, tool, args) is None, tool
    assert not uploads.calls and not uploads.puts
    # 元景没连上时不提醒。
    uploads.state.tools.clear()
    assert uploads.hooks["pre_llm_call"][-1](session_id="s", user_message="hi") is None


def test_upload_failures_block_the_call_and_name_the_step(uploads, monkeypatch, caplog):
    """上传失败、地址不可信、文件过大时拦下调用并说明步骤，日志里不出现签名。"""
    image = uploads.home / "a.png"
    image.write_bytes(b"a")
    uploads.state.status = 403
    failed = before(
        uploads, "mcp__UniAI_Toolkit__img2vid_generate", {"image_url": str(image)}
    )
    assert failed["action"] == "block" and "上传文件" in failed["message"]
    assert "secret" not in failed["message"] and "secret" not in caplog.text
    monkeypatch.setattr(
        uploads.module,
        "call_tool",
        lambda name, args: upload_answer("x.png").replace(
            HOST, "https://evil.example.com"
        ),
    )
    refused = before(
        uploads, "mcp__UniAI_Toolkit__img2vid_generate", {"image_url": str(image)}
    )
    assert "取上传地址" in refused["message"]
    monkeypatch.setattr(
        uploads.module, "call_tool", lambda name, args: '{"error": "down"}'
    )
    assert (
        "取上传地址"
        in before(uploads, "mcp__UniAI_Toolkit__x", {"f": str(image)})["message"]
    )
    monkeypatch.setattr(uploads.module, "MAX_BYTES", 0)
    assert (
        "超过" in before(uploads, "mcp__UniAI_Toolkit__x", {"f": str(image)})["message"]
    )


def test_upload_target_reads_oss_path_from_url_or_field(uploads):
    """没有 ossPath 字段时从路径式地址取；有字段时以字段为准；临时目录以外的地址不认。"""
    target = uploads.module.upload_target
    text = json.loads(upload_answer("a.png"))["result"]
    url, oss_path, content_type = target(text)
    assert url.endswith("a.png" + SIGNED)
    assert oss_path == "app-agent-prod/temp/a.png" and content_type == "image/png"
    assert (
        target(text + "\nossPath：app-agent-prod/temp/b.png")[1]
        == "app-agent-prod/temp/b.png"
    )
    for bad in (
        text.replace("/temp/", "/videos/"),
        text.replace("https://", "http://"),
        text.replace("/temp/a.png", "/temp/../videos/a.png"),
        "没有地址",
    ):
        with pytest.raises(ValueError):
            target(bad)


def test_downloaded_deliverable_goes_back_as_its_original_link(uploads):
    """插件下载的成品换回原链接、不上传；内容被换掉、链接快过期或读不出期限时改为上传。"""
    module = uploads.module
    output = uploads.work / "outputs" / "小猫.png"
    output.parent.mkdir()
    output.write_bytes(b"cat-1")
    now = int(time.time())
    image = f"http://obs-nmhhht6.cucloud.cn/yuanjing-t2i-oss/a.png?AWSAccessKeyId=k&Signature=s&Expires={now + 3600}"
    signed = datetime.fromtimestamp(now - 60, timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    edited = f"{HOST}/app-agent-prod/images/edited/b.jpg?X-Amz-Date={signed}&X-Amz-Expires=604800"

    def sent():
        """把本机路径交给图生视频，返回实际发出去的参数。"""
        result = before(
            uploads, "mcp__UniAI_Toolkit__img2vid_generate", {"image_url": str(output)}
        )
        return (
            result["args"]["image_url"]
            if result and result["action"] == "modify"
            else result
        )

    for link in (image, edited):
        module.remember_download(output, link)
        assert sent() == link
    assert not uploads.calls and not uploads.puts
    # 同名文件被换成别的内容，即使大小和修改时间不变也认得出来。
    info = output.stat()
    output.write_bytes(b"dog-1")
    os.utime(output, ns=(info.st_atime_ns, info.st_mtime_ns))
    assert sent() == "app-agent-prod/temp/obj1.png"
    output.write_bytes(b"cat-2")
    for link in (
        image.replace(str(now + 3600), str(now + 60)),
        f"{HOST}/app-agent-prod/music/c.wav?sig=1",
    ):
        module.remember_download(output, link)
        assert sent().startswith("app-agent-prod/temp/")
    assert len(uploads.puts) == 2


def test_tool_output_downloaded_by_the_plugin_is_reused_without_upload(
    uploads, monkeypatch
):
    """完整流程：生图成品下载后结果里没有链接；再把本机副本交给元景工具时换回原链接。"""
    from tests.plugins.desktop_deliverables_http_fixture import serving
    from hermes_cli.plugins import resolve_plugin_command_result

    monkeypatch.setattr("tools.url_safety._global_allow_private_urls", lambda: True)
    uploads.plugin.before_turn(
        session_id="s", turn_id="t", task_id="s", platform="desktop"
    )
    with serving() as (base, _requests):
        url = base + f"/cat.png?Expires={int(time.time()) + 3600}"
        result = resolve_plugin_command_result(
            uploads.hooks["transform_tool_result"][0](
                tool_name="mcp__UniAI_Toolkit__txt2img_generate",
                args={"prompt": "一只小猫"},
                result=json.dumps({"url": url}),
                session_id="s",
                turn_id="t",
            )
        )
    data = json.loads(result)
    assert "url" not in data and "Expires" not in result
    output = data["desktop_deliverables"][0]
    assert before(
        uploads, "mcp__UniAI_Toolkit__img2vid_generate", {"image_url": output}
    ) == {
        "action": "modify",
        "args": {"image_url": url},
    }
    assert not uploads.calls and not uploads.puts
