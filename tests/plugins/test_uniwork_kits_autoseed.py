"""The bundled kits and experts going into an account by themselves.

A new desktop account gets them when its backend starts; later starts only
compare fingerprints. Packages are built in a temp dir and installed into a
temp HERMES_HOME through the real installer.
"""

import importlib
import sys
from pathlib import Path

import pytest

from tests.plugins.test_uniwork_kits_plugin import (  # noqa: F401 - fixtures
    _zip_dir,
    expert_pkg,
    kit_pkg,
    kits,
    profile_env,
)


def _part(name: str):
    """按插件系统导入后的模块名取插件里的一个子模块。"""
    return importlib.import_module(f"hermes_plugins.uniwork_kits.{name}")


@pytest.fixture
def bundle(profile_env, kit_pkg, expert_pkg):
    """在临时目录里做一套内置包（一个套件、一个专家），并在默认档案配置里指向它。"""
    directory = profile_env.parent / "bundle" / "uniwork-bundled"
    _zip_dir(kit_pkg, directory / "plugins" / "demo-kit.zip")
    _zip_dir(expert_pkg, directory / "plugins" / "demo-expert.zip")
    config = profile_env / "config.yaml"
    config.write_text(
        config.read_text(encoding="utf-8") + f"uniwork_kits:\n  bundled_dir: '{directory.parent.as_posix()}'\n",
        encoding="utf-8",
    )
    return directory


def _wait(autoseed, timeout=60.0):
    """等后台安装线程结束，并确认状态已经不是「安装中」。"""
    thread = autoseed._thread
    assert thread is not None
    thread.join(timeout)
    assert not thread.is_alive(), f"bundled install still running: {autoseed.status()}"
    assert autoseed.status()["running"] is False


@pytest.fixture
def autoseed(kits, monkeypatch, tmp_path):
    """每个测试都从「这个进程还没装过」开始；开发机 bundled/ 里可能有真实的包，测试一律用自己的。"""
    module = _part("autoseed")
    monkeypatch.setattr(module, "_started", set())
    # A developer checkout may carry real packages in bundled/; tests use their own.
    monkeypatch.setattr(module, "BUNDLED_DIR", tmp_path / "no-bundled-dir")
    return module


def test_a_new_account_gets_the_bundled_kits_and_experts_once(kits, autoseed, profile_env, bundle):
    """新账号启动时自动装上内置套件和专家，同一进程里不会再装第二次，装完锁文件被删掉。"""
    assert autoseed.start(profile_env) is True
    _wait(autoseed)
    status = autoseed.status()
    assert status["installed"] == 2 and status["failed"] == [] and status["error"] == ""
    plugins = kits.store.load_index(profile_env)["plugins"]
    assert plugins["demo-kit"]["kind"] == "kit" and plugins["demo-expert"]["kind"] == "expert"
    assert not (kits.store.imported_root(profile_env) / autoseed.LOCK_NAME).exists()

    # Once per process for a home.
    assert autoseed.start(profile_env) is False


def test_a_kit_the_user_uninstalled_stays_out_while_new_built_ins_still_arrive(
    kits, autoseed, profile_env, bundle, tmp_path, monkeypatch
):
    """用户卸载过的内置套件下次启动不会被装回，而应用更新新增的内置包照样装上。"""
    assert autoseed.start(profile_env) is True
    _wait(autoseed)
    kits.installer.uninstall(profile_env, "demo-kit")

    # An app update ships one more kit.
    other = tmp_path / "pkgs" / "other-kit"
    (other / "skills" / "other-probe").mkdir(parents=True)
    (other / "plugin.json").write_text('{"name": "other-kit", "version": "1.0.0"}', encoding="utf-8")
    (other / "skills" / "other-probe" / "SKILL.md").write_text(
        "---\nname: other-probe\ndescription: 另一个演示技能\n---\n做点事。\n", encoding="utf-8"
    )
    _zip_dir(other, bundle / "plugins" / "other-kit.zip")

    monkeypatch.setattr(autoseed, "_started", set())  # the next app start
    assert autoseed.start(profile_env) is True
    _wait(autoseed)
    plugins = kits.store.load_index(profile_env)["plugins"]
    assert "demo-kit" not in plugins, "an uninstalled built-in came back"
    assert "other-kit" in plugins and "demo-expert" in plugins
    status = autoseed.status()
    assert (status["installed"], status["unchanged"], status["failed"]) == (1, 1, [])


def test_an_expert_backend_and_a_home_without_a_bundle_do_nothing(kits, autoseed, profile_env, bundle, tmp_path):
    """专家自己的后端、以及找不到内置目录的档案都不安装。"""
    expert_home = profile_env / "profiles" / "someone"
    expert_home.mkdir(parents=True)
    assert autoseed.start(expert_home) is False

    bare = tmp_path / "bare-home"
    bare.mkdir()
    assert autoseed.start(bare) is False


def test_a_backend_that_finds_another_one_installing_skips(kits, autoseed, profile_env, bundle):
    """另一个后端正在安装（锁文件在）时跳过，并且不动别人的锁。"""
    lock = kits.store.imported_root(profile_env) / autoseed.LOCK_NAME
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text("{}", encoding="utf-8")
    assert autoseed.start(profile_env) is True
    _wait(autoseed)
    assert "demo-kit" not in (kits.store.load_index(profile_env).get("plugins") or {})
    assert lock.exists(), "the other backend's lock is left alone"


def test_later_starts_recognise_installed_zips_without_unpacking(kits, profile_env, bundle, monkeypatch):
    """以后的启动按文件指纹认出已装的 zip，完全不解包，所以每次启动都很快。"""
    seed = _part("seed")
    first = seed.seed(profile_env, bundle, generate_triggers=False)
    assert {item.status for item in first} == {"installed"}, [(i.name, i.status, i.detail) for i in first]

    def no_unpacking(path):
        """替身：一旦被调用就说明解包了，测试失败。"""
        raise AssertionError(f"unpacked {path.name} although its bytes were already installed")

    monkeypatch.setattr(seed, "_identity", no_unpacking)
    again = seed.seed(profile_env, bundle, generate_triggers=False)
    assert [item.status for item in again] == ["unchanged", "unchanged"]


def test_progress_is_reported_before_each_install(kits, profile_env, bundle):
    """每装一个包之前都报一次进度，套件先于专家，总数一致。"""
    seen = []
    _part("seed").seed(profile_env, bundle, generate_triggers=False, progress=lambda *args: seen.append(args))
    assert [name for name, _done, _total in seen] == ["demo-kit", "demo-expert"]
    assert [done for _name, done, _total in seen] == [0, 1] and {total for *_, total in seen} == {2}


def test_status_route_reports_the_bundled_install(kits, profile_env):
    """后端接口 /bundled 返回套件页需要的全部状态字段。"""
    import importlib.util

    from fastapi import FastAPI
    from starlette.testclient import TestClient

    plugin_dir = Path(__file__).resolve().parents[2] / "plugins" / "uniwork-kits"
    name = "uniwork_kits_dashboard_api_bundled_test"
    sys.modules.pop(name, None)
    spec = importlib.util.spec_from_file_location(name, plugin_dir / "dashboard" / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    app = FastAPI()
    app.include_router(module.router, prefix="/api/plugins/uniwork-kits")
    body = TestClient(app).get("/api/plugins/uniwork-kits/bundled").json()
    assert set(body) >= {"ran", "running", "done", "total", "installed", "unchanged", "failed", "error"}
