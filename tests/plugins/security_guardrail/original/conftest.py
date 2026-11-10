"""Run original pure-engine scenarios with explicit execution capabilities."""

import importlib
import importlib.util
from pathlib import Path
import sys

import pytest


_ROOT = Path(__file__).resolve().parents[4] / "plugins/security-guardrail"
_SPEC = importlib.util.spec_from_file_location("_guardrail_migrated", _ROOT / "__init__.py", submodule_search_locations=[str(_ROOT)])
_PLUGIN = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = _PLUGIN
_SPEC.loader.exec_module(_PLUGIN)


@pytest.fixture(autouse=True)
def original_execution_capabilities():
    """Original scenarios assume a trusted local reader, not a Hermes default."""
    runtime = importlib.import_module(_SPEC.name + ".guardrail.runtime")
    types = importlib.import_module(_SPEC.name + ".guardrail.types")

    def read_script(path, limit):
        try:
            with Path(path).open("rb") as stream:
                return stream.read(limit)
        except (OSError, ValueError):
            return None

    def exists(path):
        return Path(path).exists() or Path(path).is_symlink()

    environment = runtime.ExecutionEnvironment(
        product_exemptions=True, script_reader=read_script, exists=exists,
        is_directory=lambda path: Path(path).is_dir(),
        operating_system=types.operating_system_from_platform(sys.platform),
    )
    with runtime.use_execution_environment(environment):
        yield
