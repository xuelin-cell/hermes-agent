"""PM caches are writable; shipped dependency environments stay immutable."""

from __future__ import annotations

import zipfile

import pm.packages as pkgs





def test_uv_cache_dir_seeds_from_payload(monkeypatch, tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    payload = tmp_path / "payload"
    (payload / "uv-cache" / "wheels-v5").mkdir(parents=True)
    (payload / "uv-cache" / "wheels-v5" / "some.pkg").write_text("x", encoding="utf-8")

    import hermes_constants

    monkeypatch.setattr(hermes_constants, "get_default_hermes_root", lambda: home)
    import pm.paths as paths_mod

    monkeypatch.setattr(paths_mod, "store_root", lambda: payload / "tools")

    machine = pkgs.uv_cache_dir()
    assert machine == home / "cache" / "uv"
    # seed copied out
    assert (machine / "wheels-v5" / "some.pkg").read_text(encoding="utf-8") == "x"
    # seeded marker written → second call doesn't re-copy
    assert (machine / ".seeded").is_file()
    (payload / "uv-cache" / "wheels-v5" / "some.pkg").write_text("changed", encoding="utf-8")
    pkgs.uv_cache_dir()
    assert (machine / "wheels-v5" / "some.pkg").read_text(encoding="utf-8") == "x"


def test_uv_cache_dir_seeds_from_single_archive(monkeypatch, tmp_path):
    """新安装包从单个压缩种子恢复缓存，避免安装阶段释放数万个文件。"""
    home = tmp_path / "home"
    home.mkdir()
    payload = tmp_path / "payload"
    payload.mkdir()
    with zipfile.ZipFile(payload / "uv-cache.zip", "w") as archive:
        archive.writestr("archive-v0/bucket/module.py", "seeded = True\n")

    import hermes_constants
    import pm.paths as paths_mod

    monkeypatch.setattr(hermes_constants, "get_default_hermes_root", lambda: home)
    monkeypatch.setattr(paths_mod, "store_root", lambda: payload / "tools")

    machine = pkgs.uv_cache_dir()

    assert (machine / "archive-v0" / "bucket" / "module.py").read_text() == "seeded = True\n"
    assert (machine / ".seeded").is_file()


def test_uv_cache_dir_cold_machine_no_payload(monkeypatch, tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    import hermes_constants

    monkeypatch.setattr(hermes_constants, "get_default_hermes_root", lambda: home)
    import pm.paths as paths_mod

    monkeypatch.setattr(paths_mod, "store_root", lambda: tmp_path / "nowhere" / "tools")

    machine = pkgs.uv_cache_dir()
    assert machine == home / "cache" / "uv"
    assert (machine / ".seeded").is_file()


def test_bundle_uses_shipped_environment_until_an_extension_is_committed(monkeypatch, tmp_path):
    import json
    import pm.paths as paths

    home = tmp_path / "home"
    monkeypatch.setenv("HERMES_HOME", str(home))
    payload = tmp_path / "payload"
    core = payload / "hermes-agent"
    core.mkdir(parents=True)
    shipped = payload / "venv"
    shipped.mkdir()
    (payload / "manifest.json").write_text(json.dumps({"repo": "hermes-agent", "venv": "venv"}))
    monkeypatch.setattr(paths, "repo_root", lambda: core)

    assert pkgs.Venv().venv_dir() == shipped
    assert not home.exists(), "selecting shipped dependencies must not copy or mutate them"
