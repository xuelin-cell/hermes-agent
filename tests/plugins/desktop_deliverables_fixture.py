"""供 Python 回归和独立 Electron 验收复用的真实对话夹具；不连接公网模型。"""

import json
import os
from pathlib import Path
import sys
from unittest.mock import patch

from tests.fakes.fake_llm_provider import (
    FakeLLMServer,
    Text,
    ToolCall,
    write_hermes_home,
)


def run_scenario(root, kind="workspace"):
    """只在新测试目录创建 Home 和产物，执行原生工具后关闭、重开数据库取得显示历史。"""
    work = root / "workspace"
    home = root / "home"
    assert not work.exists() and not home.exists(), "测试目录已有数据，拒绝覆盖"
    work.mkdir(parents=True)
    destination = (
        work if kind in {"workspace", "terminal", "execute_code"} else root / kind
    )
    destination.mkdir(exist_ok=True)
    output = destination / ("报告 (1).md" if kind == "wrapped" else kind + "报告.md")
    command = f"printf '# 交付测试' > '{output.as_posix()}'"
    call = ToolCall("write_file", {"path": str(output), "content": "# 交付测试"})
    if kind == "terminal":
        call = ToolCall("terminal", {"command": command})
    elif kind == "execute_code":
        call = ToolCall(
            "execute_code",
            {
                "code": "from hermes_tools import terminal\nterminal("
                + repr(command)
                + ")"
            },
        )
    with (
        patch.dict(
            os.environ,
            {
                "HERMES_HOME": str(home),
                "TERMINAL_ENV": "local",
                "TERMINAL_CWD": str(work),
            },
        ),
        FakeLLMServer([
            call,
            Text(f"![报告](<MEDIA:{output}>)" if kind == "wrapped" else "完成了。"),
        ]) as server,
    ):
        write_hermes_home(
            home,
            server.base_url,
            extra_config="plugins:\n  enabled: [desktop-deliverables]\n",
        )
        from hermes_cli.plugins import discover_plugins
        from hermes_state import SessionDB
        from run_agent import AIAgent
        from tools.terminal_tool import record_session_cwd

        discover_plugins(force=True)
        record_session_cwd("native-delivery", str(work))
        database = SessionDB(home / "state.db")
        agent = AIAgent(
            provider="custom",
            base_url=server.base_url,
            api_key="sk-fake-e2e",
            model="fake-model",
            session_db=database,
            session_id="native-delivery",
            platform="desktop",
            enabled_toolsets=["file", "terminal", "code_execution"],
            quiet_mode=True,
            skip_memory=True,
            skip_context_files=True,
        )
        try:
            result = agent.run_conversation(
                f"把文件写到 {output}。", task_id="native-delivery"
            )
            assert output.read_text(encoding="utf-8") == "# 交付测试"
            assert f"MEDIA:{output}" in result["final_response"]
            expected = result["final_response"]
        finally:
            agent.close()
            database.close()
        reopened = SessionDB(home / "state.db")
        try:
            model, display = reopened.get_resume_conversations("native-delivery")
            for history in (model, display):
                assert (
                    next(
                        row["content"]
                        for row in reversed(history)
                        if row["role"] == "assistant"
                    )
                    == expected
                )
            receipt = {"text": expected, "path": str(output), "kind": kind}
            (root / "receipt.json").write_text(
                json.dumps(receipt, ensure_ascii=False), encoding="utf-8"
            )
            return receipt
        finally:
            reopened.close()


if __name__ == "__main__":
    run_scenario(Path(sys.argv[1]), sys.argv[2] if len(sys.argv) > 2 else "workspace")
