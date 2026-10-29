"""Provider metadata built from the shared desktop credential contract."""
import json
from pathlib import Path

CONTRACT_FILE = Path(__file__).resolve().parents[1] / '.connector-runtime/contract.json'
if not CONTRACT_FILE.is_file():
    CONTRACT_FILE = Path(__file__).resolve().parents[2] / '.connector-runtime/contract.json'


def connector_specs():
    return json.loads(CONTRACT_FILE.read_text())
