"""真实 Agent 使用隔离生成工具与本机下载服务，供持久化和原生窗口复验。"""

import base64
import io
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch
import wave

from tests.fakes.fake_llm_provider import (
    FakeLLMServer,
    Text,
    ToolCall,
    write_hermes_home,
)
from tests.plugins.desktop_deliverables_http_fixture import serving


def run_scenario(root, kind="fallback", media_dir=None, *, platform="desktop", download_available=True, echo=True):
    """使用独立 Home 和正式插件发现，真实工具执行后关闭重开两种历史投影；echo=False 时父会话不抄 MEDIA。"""
    work, home = root / "workspace", root / "home"
    assert not work.exists() and not home.exists(), "拒绝覆盖已有测试数据"
    work.mkdir(parents=True)
    names = {
        "image": ("txt2img_generate", "png"),
        "video": ("txt2vid_generate", "mp4"),
        "audio": ("tts_synthesize", "wav"),
        "offline": ("txt2img_generate", "png"),
        "background-translation": ("doc_translate", "docx"),
        "background-podcast": ("ai_podcast_generate", "wav"),
        "background-video": ("txt2vid_generate", "mp4"),
        "background-image-video": ("img2vid_generate", "mp4"),
        "background-other": ("tts_synthesize", "wav"),
    }
    leaf, extension = names.get(kind, ("fixture_write", "md"))
    videos = {"video", "background-video", "background-image-video"}
    # 四个附件平台与桌面一样下载（钉钉视频除外）；其他消息平台只缓存后台翻译、播客。
    delivered = platform == "desktop" or (
        platform in {"weixin", "feishu", "wecom", "dingtalk"}
        and not (platform == "dingtalk" and kind in videos)
    )
    uncached = kind == "background-other" or not (
        delivered or kind in {"background-translation", "background-podcast"}
    )
    output = work / "fallback报告.md"
    payload = b"controlled-video-container"
    if media_dir:
        payload = (media_dir / ("sample." + extension)).read_bytes()
    elif extension == "png":
        payload = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
        )
    elif extension == "wav":
        stream = io.BytesIO()
        with wave.open(stream, "wb") as audio:
            audio.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
            audio.writeframes(b"\0\0" * 8000)
        payload = stream.getvalue()
    with serving({"/artifact." + extension: payload}) as (base, requests):
        url = base + "/artifact." + extension
        if kind == "offline" or not download_available:
            # 零端口不可连接，不尝试占用或关闭用户正在使用的端口。
            url = "http://127.0.0.1:0/artifact." + extension
        name = "mcp__fixture__" + leaf
        final = "结果链接：" + url if kind == "offline" else "完成了。"
        returned = json.dumps({"url": url}) if kind != "fallback" else '{"ok":true}'
        body = (
            f"    Path({str(output)!r}).write_text('# 交付测试', encoding='utf-8')\n"
            if kind == "fallback"
            else ""
        )
        def background_reply(request):
            """按父子会话各自的上下文响应，避免异步请求抢占同一脚本序列。"""
            messages = request['body']['messages']
            user = next(row['content'] for row in reversed(messages) if row['role'] == 'user')
            if 'ASYNC DELEGATION' in user and 'COMPLETE' in user:
                media = next((line for line in user.splitlines() if line.startswith('MEDIA:')), '')
                return Text('生成完成。\n' + (media or url) if echo or not media else '生成完成。')
            if '生成测试产物' in user:
                if any(row['role'] == 'tool' for row in messages):
                    return Text('生成完成。' if download_available else '下载失败，结果链接：' + url)
                return ToolCall('tool_call', {'calls': [{'name': name, 'arguments': {}}]})
            if any(row['role'] == 'tool' for row in messages):
                return Text('已提交后台任务。')
            return ToolCall('delegate_task', {'tasks': [{'goal': '生成测试产物'}]})

        with (
            patch.dict(
                os.environ,
                {
                    "HERMES_HOME": str(home),
                    "TERMINAL_ENV": "local",
                    "TERMINAL_CWD": str(work),
                },
            ),
            FakeLLMServer(background_reply if kind.startswith('background-') else [
                ToolCall("tool_call", {"calls": [{"name": name, "arguments": {}}]}),
                Text(final),
            ]) as server,
        ):
            write_hermes_home(
                home,
                server.base_url,
                extra_config=(
                    "plugins:\n  enabled: [desktop-deliverables, delivery-fixture, uniwork-kits]\n"
                    "security:\n  allow_private_urls: true\n"
                    "auxiliary:\n  title_generation:\n    enabled: false\n"
                ),
            )
            plugin = home / "plugins/delivery-fixture"
            plugin.mkdir(parents=True)
            (plugin / "plugin.yaml").write_text(
                'name: delivery-fixture\nversion: "0.1.0"\n', encoding="utf-8"
            )
            (plugin / "__init__.py").write_text(
                "from pathlib import Path\n"
                "def generate(args, **kwargs):\n"
                '    """只写测试产物或返回本机服务链接，不调用真实生成平台。"""\n'
                + body
                + f"    return {returned!r}\n"
                "def register(ctx):\n"
                '    """通过正式插件注册受控工具，不替换原生工具调度。"""\n'
                f"    ctx.register_tool({name!r}, 'delivery_fixture', "
                f"{{'name':{name!r},'description':'fixture output','parameters':{{'type':'object','properties':{{}}}}}}, generate)\n",
                encoding="utf-8",
            )
            from hermes_cli.plugins import discover_plugins
            from hermes_state import SessionDB
            from run_agent import AIAgent
            from tools.terminal_tool import record_session_cwd

            discover_plugins(force=True)
            record_session_cwd("generated-delivery", str(work))
            database = SessionDB(home / "state.db")
            agent = AIAgent(
                provider="custom",
                base_url=server.base_url,
                api_key="sk-fake-e2e",
                model="fake-model",
                session_db=database,
                session_id="generated-delivery",
                platform=platform,
                enabled_toolsets=["delivery_fixture", "delegation"],
                quiet_mode=True,
                max_iterations=6,
                skip_memory=True,
                skip_context_files=True,
            )
            try:
                result = agent.run_conversation(
                    "生成文件。", task_id="generated-delivery"
                )
                if kind.startswith('background-'):
                    from tools.process_registry import process_registry
                    from tools.process_registry_notifications import format_process_notification

                    assert 'MEDIA:' not in result['final_response']
                    event = process_registry.completion_queue.get(timeout=30)
                    assert event['type'] == 'async_delegation'
                    notice = format_process_notification(event)
                    assert ('MEDIA:' in notice) == (not uncached and download_available)
                    result = agent.run_conversation(
                        notice, conversation_history=result['messages'], task_id='generated-delivery',
                    )
                expected = result["final_response"]
                tool_results = [
                    row
                    for request in server.main_requests()
                    for row in request["messages"]
                    if row["role"] == "tool"
                ]
                assert tool_results, "受控工具必须经过真实调度"
                assert all(
                    "does not exist" not in row["content"] for row in tool_results
                ), tool_results
                if uncached:
                    assert 'MEDIA:' not in expected
                    assert not requests
                    assert all('desktop_deliverables' not in row['content'] for row in tool_results)
                    assert any(url in row['content'] for row in tool_results)
                elif kind == "offline" or not download_available:
                    assert url in expected and "MEDIA:" not in expected
                    assert all(
                        "desktop_deliverables" not in row["content"]
                        for row in tool_results
                    )
                else:
                    if kind != "fallback":
                        output = next((work / "outputs").glob("*." + extension))
                        assert output.read_bytes() == payload
                        # tool_call 桥会再次编码 JSON，Windows 路径反斜杠因此转义。
                        assert any(
                            ("desktop_deliverables" if platform == "desktop" else '"deliverables"') in row["content"]
                            and output.name in row["content"]
                            for row in tool_results
                        )
                        assert len(requests) == 1
                        # 桌面和四个附件平台下载成功即去掉链接；其他消息平台照旧保留。
                        assert any(url in row["content"] for row in tool_results) == (not delivered)
                    assert expected.count(f"MEDIA:{output}") == 1
            finally:
                agent.close()
                database.close()
            reopened = SessionDB(home / "state.db")
            try:
                for history in reopened.get_resume_conversations("generated-delivery"):
                    assert (
                        next(
                            row["content"]
                            for row in reversed(history)
                            if row["role"] == "assistant"
                        )
                        == expected
                    )
            finally:
                reopened.close()
            receipt = {"text": expected, "path": str(output), "kind": kind, "url": url}
            (root / "receipt.json").write_text(
                json.dumps(receipt, ensure_ascii=False), encoding="utf-8"
            )
            return receipt


if __name__ == "__main__":
    run_scenario(
        Path(sys.argv[1]),
        sys.argv[2] if len(sys.argv) > 2 else "fallback",
        Path(sys.argv[3]) if len(sys.argv) > 3 else None,
    )
