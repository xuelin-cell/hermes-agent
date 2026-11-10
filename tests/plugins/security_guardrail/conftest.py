"""Load the candidate as an independently installed, arbitrarily named plugin."""

import importlib.util
from pathlib import Path
import shutil
import sys
import uuid

import pytest


@pytest.fixture
def candidate(tmp_path):
    source = Path(__file__).resolve().parents[3] / "plugins/security-guardrail"
    installed = tmp_path / "installed-plugin"
    shutil.copytree(source, installed, ignore=shutil.ignore_patterns("__pycache__"))
    name = "guardrail_candidate_" + uuid.uuid4().hex
    spec = importlib.util.spec_from_file_location(name, installed / "__init__.py", submodule_search_locations=[str(installed)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
        yield module
    finally:
        for key in list(sys.modules):
            if key == name or key.startswith(name + "."):
                del sys.modules[key]
