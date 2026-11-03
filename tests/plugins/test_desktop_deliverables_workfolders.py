"""验证桌面工作根对本机消息和定时任务生效。"""
import copy
import json
import threading
from pathlib import Path

import pytest

from tests.plugins.test_desktop_deliverables_image_hints import attached, hints  # noqa: F401
from tests.plugins.test_desktop_deliverables_uploads import uploads  # noqa: F401
from tests.plugins.test_desktop_deliverables_fallback import delivery  # noqa: F401


@pytest.fixture
def routes(delivery, tmp_path):
    """用独立账号文件和真实终端登记接口，结束时释放测试任务。"""
    from fallback_delivery import workfolders
    from tools.terminal_tool import clear_task_env_overrides

    plugin, _ = delivery
    root = tmp_path / "root"
    fallback = tmp_path / "fallback"
    config = tmp_path / "home" / "desktop-work-root.json"
    config.write_text(json.dumps({"root": str(root), "fallback": str(fallback)}))
    workfolders._assigned.clear()
    yield plugin, workfolders, config, root, fallback
    for task in ("wx", "fs", "compressed", "timer", "child"):
        clear_task_env_overrides(task)
    workfolders._assigned.clear()


def test_im_and_cron(routes):
    """两种平台共享目录；下一轮保留 cd，换编号仍落在同目录。"""
    from tools.terminal_tool import get_session_cwd, record_session_cwd

    plugin, mod, _, root, _ = routes
    folder = root / "IM"
    for task, platform in [("wx", "weixin"), ("fs", "feishu"), ("compressed", "weixin")]:
        assert str(folder / ".tmp") in mod.route(platform=platform, task_id=task)["context"]
        assert plugin.workspace(task) == folder
        assert str(folder / ".tmp") in plugin.scratch_reminder(folder)
        assert (folder / ".tmp").is_dir()
    record_session_cwd("wx", str(folder / ".tmp"))
    mod.route(platform="weixin", task_id="wx")
    assert get_session_cwd("wx") == str(folder / ".tmp")
    assert plugin.workspace("wx") == folder
    for _ in range(2):
        assert str(root / "cron" / ".tmp") in mod.route(platform="cron", task_id="timer")["context"]
        assert plugin.workspace("timer") == root / "cron"


def test_skip_and_fallback(routes):
    """手选目录、其它平台与坏配置不登记；依次尝试两个位置。"""
    from tools.terminal_tool import get_session_cwd, record_session_cwd

    _, mod, config, root, fallback = routes
    record_session_cwd("timer", str(root))
    assert mod.route(platform="cron", task_id="timer") is None
    for platform in ("desktop", "tui"):
        mod.route(platform=platform, task_id="wx")
    assert not mod._assigned
    root.touch()
    mod.route(platform="feishu", task_id="fs")
    assert get_session_cwd("fs") == str(fallback / "IM")
    (fallback / "cron").touch()
    assert mod.route(platform="cron", task_id="wx") is None
    for malformed in (None, "[", "null", '{}'):
        if malformed is None:
            config.unlink()
        else:
            config.write_text(malformed)
        mod.route(platform="weixin", task_id="wx")
        assert get_session_cwd("wx") is None


@pytest.mark.parametrize("known", [False, True])
def test_slow_disk_does_not_block_requests(routes, monkeypatch, known):
    """建目录卡住时，其它会话的模型请求不用等；新任务和已登记任务都一样。"""
    _, mod, _, root, _ = routes
    mod.route(platform="feishu", task_id="fs")
    if known:
        mod.route(platform="weixin", task_id="wx")
    entered, release = threading.Event(), threading.Event()
    real_mkdir = Path.mkdir

    def slow_mkdir(self, *args, **kwargs):
        """模拟很慢的盘：等测试放行后才真正建目录。"""
        entered.set()
        assert release.wait(5)
        return real_mkdir(self, *args, **kwargs)

    monkeypatch.setattr(Path, "mkdir", slow_mkdir)
    results = []
    router = threading.Thread(target=mod.route, kwargs={"platform": "weixin", "task_id": "wx"})
    router.start()
    assert entered.wait(5)
    request = threading.Thread(target=lambda: results.append(
        mod.rewrite_prompt({"system": "Current working directory: OLD"}, "fs")))
    request.start()
    request.join(2)
    finished_while_stuck = not request.is_alive()
    release.set()
    router.join(5)
    request.join(5)
    assert finished_while_stuck
    assert results[0]["system"] == f"Current working directory: {root / 'IM'}"
    assert mod._assigned["wx"] == root / "IM"


@pytest.mark.parametrize("blocks", [True, False])
def test_request_and_child(routes, blocks):
    """多种系统内容仅改目录行，子任务复用父目录且保留原请求。"""
    from tools.terminal_tool import record_session_cwd, resolve_task_overrides

    plugin, mod, _, root, _ = routes
    mod.route(platform="feishu", task_id="fs")
    record_session_cwd("child", str(root / "IM"))
    before = dict(resolve_task_overrides("child"))
    mod.route(platform="subagent", task_id="child")
    assert resolve_task_overrides("child") == before
    original = "intro\nCurrent working directory: OLD\nend"
    content = [{"text":original}] if blocks else original
    request = {"messages":[{"role":"developer", "content":content},{"role":"user","content":original}],
               "instructions": content, "system": content}
    snapshot = copy.deepcopy(request)
    assert mod.rewrite_prompt(request, "unknown") is None
    result = plugin.rewrite_llm_request(request=request, task_id="child")["request"]
    for text in (result["system"], result["instructions"], result["messages"][0]["content"]):
        assert (text[0]["text"] if blocks else text) == original.replace("OLD", str(root / "IM"))
    assert result["messages"][1]["content"] == original
    assert request == snapshot

def test_registered_hooks_compose(routes, hints):
    """经正式注册顺序路由后，同一请求可同时替换工作目录、图片提示并移除深度参数。"""
    plugin, mod, _, root, _ = routes
    hooks = hints.hooks["pre_llm_call"]
    assert hooks.index(mod.route) < hooks.index(plugin.before_turn)
    mod.route(platform="feishu", task_id="fs")
    image = hints.home / "sample.png"
    image.write_bytes(b"png")
    request = {"reasoning_effort":"medium", "messages":[
        {"role":"system","content":"Current working directory: OLD"},
        {"role":"user","content":attached(image)}]}
    result = hints.rewrite(request=request, platform="desktop", task_id="fs", model="glm-5.2")["request"]
    assert "reasoning_effort" not in result
    assert str(root / "IM") in result["messages"][0]["content"]
    assert "analyze_image" in result["messages"][1]["content"]
