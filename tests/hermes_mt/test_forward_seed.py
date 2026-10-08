"""转发器的种子文件落盘模式（deploy/hermes-mt/seed/forward.py::_write_seed）。"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

SEED_DIR = Path(__file__).resolve().parents[2] / "deploy" / "hermes-mt" / "seed"


@pytest.fixture
def forward(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    if str(SEED_DIR) not in sys.path:
        sys.path.insert(0, str(SEED_DIR))
    spec = importlib.util.spec_from_file_location("forward_under_test", SEED_DIR / "forward.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_write_seed_modes(forward, tmp_path: Path) -> None:
    (tmp_path / ".env").write_text("USER_KEY=mine\n", encoding="utf-8")
    (tmp_path / "config.yaml").write_text(
        "model:\n  default: \"old\"\n  base_url: \"http://old\"\nproviders:\n  yuanjing:\n    api: \"http://old\"\n"
        "    default_model: \"old\"\n    models:\n      old: {}\n", encoding="utf-8")
    written = forward._write_seed([
        {"path": "config.yaml", "content": "template", "overwrite": "if-pristine"},
        {"path": "config.yaml", "content": json.dumps({"base_url": "http://new", "model": "m", "provider_key": "yuanjing", "models": ["m"]}),
         "overwrite": "patch-model"},
        {"path": ".env", "content": "TERMINAL_ENV=local\nPLATFORM_KEY=k\n", "overwrite": "upsert-lines"},
        {"path": "SOUL.md", "content": "soul", "overwrite": False},
    ])
    assert written == ["config.yaml", ".env", "SOUL.md"]
    cfg = (tmp_path / "config.yaml").read_text(encoding="utf-8")
    assert cfg.startswith("model:")  # 用户的配置没被模板整份覆盖
    import yaml
    doc = yaml.safe_load(cfg)
    assert doc["model"]["default"] == "m" and doc["model"]["base_url"] == "http://new"
    assert list(doc["providers"]["yuanjing"]["models"]) == ["m"]
    assert (tmp_path / ".env").read_text(encoding="utf-8") == "USER_KEY=mine\nTERMINAL_ENV=local\nPLATFORM_KEY=k\n"
    assert (tmp_path / "SOUL.md").read_text(encoding="utf-8") == "soul"
    # 第二次：SOUL.md 已存在不覆盖，patch 无变化不算写入
    written = forward._write_seed([
        {"path": "config.yaml", "content": json.dumps({"base_url": "http://new", "model": "m", "provider_key": "yuanjing", "models": ["m"]}),
         "overwrite": "patch-model"},
        {"path": "SOUL.md", "content": "other", "overwrite": False},
    ])
    assert written == []


def test_write_seed_rejects_traversal(forward) -> None:
    with pytest.raises(ValueError):
        forward._write_seed([{"path": "../etc/passwd", "content": "x", "overwrite": True}])
