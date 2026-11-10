"""The installed engine must not depend on either product's application code."""

import importlib
from pathlib import Path
import subprocess
import sys

import pytest


def test_installed_package_runs_without_host_or_uniclaw_imports(candidate, tmp_path):
    script = r'''
import importlib, importlib.abc, importlib.util, pkgutil, sys
from datetime import date
from pathlib import Path
class NoProductImports(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in {'hexagent', 'hermes_cli', 'model_tools', 'langchain'}:
            raise ImportError('Forbidden ambient product dependency: ' + fullname)
sys.meta_path.insert(0, NoProductImports())
path = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('installed_guardrail', path/'__init__.py', submodule_search_locations=[str(path)])
plugin = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin
spec.loader.exec_module(plugin)
for entry in pkgutil.walk_packages(plugin.__path__, plugin.__name__ + '.'):
    importlib.import_module(entry.name)
from installed_guardrail.guardrail.sensitive_protection import SensitivePolicySnapshot, inspect_sensitive_text
result = inspect_sensitive_text('手机号：13800138000', policy=SensitivePolicySnapshot(revision=1, enabled=True, rule_overrides={}, reference_date=date(2026,10,16)))
assert result['findings']
from installed_guardrail.contracts import GuardrailRequest, evaluate_tool_call
from installed_guardrail.guardrail.types import PermissionMode, DecisionBehavior, OperatingSystem
request = GuardrailRequest(tool_name='Write', args={'file_path':'/workspace/a.txt'}, profile=None,
    operating_system=OperatingSystem.LINUX, cwd='/workspace', workspace_root='/workspace', mode=PermissionMode.AUTO)
assert evaluate_tool_call(request).behavior == DecisionBehavior.ALLOW
print('standalone engine and sensitive API passed')
'''
    result = subprocess.run(
        [sys.executable, "-I", "-B", "-c", script, str(Path(candidate.__file__).parent)],
        cwd=tmp_path, capture_output=True, text=True, encoding="utf-8", timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert "standalone engine and sensitive API passed" in result.stdout


@pytest.mark.parametrize("damage", ["missing", "invalid"])
def test_installed_catalog_damage_fails_explicitly(candidate, damage):
    catalog = importlib.import_module(candidate.__name__ + ".guardrail.sensitive_protection.catalog")
    types = importlib.import_module(candidate.__name__ + ".guardrail.sensitive_protection.types")
    path = Path(candidate.__file__).parent / "guardrail/sensitive_protection/assets/catalog.json"
    if damage == "missing":
        path.unlink()
    else:
        path.write_text("{}", encoding="utf-8")
    with pytest.raises(types.SensitiveUnavailableError):
        catalog.get_sensitive_catalog()
