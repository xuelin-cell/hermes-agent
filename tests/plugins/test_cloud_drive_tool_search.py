"""Cloud drive MCP tools stay discoverable through tool_search.

Regression: the shipped descriptions were Chinese-only, tool_search indexes ASCII words only,
so "upload this file to my 个人云盘" resolved to Youdao Note (English descriptions) instead of
UniWork-Drive.
"""
import json
from pathlib import Path

from tools.tool_search_catalog import build_catalog, search_catalog

TOOLS = json.loads((Path(__file__).resolve().parents[2] / "plugins/cloud_drive/tools.json").read_text())
NOTE_TOOLS = {
    "create_note": "Create a Youdao note in the default location or a selected folder.",
    "create_folder": "Create a folder inside a selected Youdao Note directory.",
}


def _catalog():
    defs = [{"type": "function", "function": {
        "name": f"mcp__UniWork-Drive__{tool['name']}", "description": tool["description"],
        "parameters": tool["inputSchema"]}} for tool in TOOLS]
    defs += [{"type": "function", "function": {
        "name": f"mcp__connector_youdao_note__{name}", "description": description,
        "parameters": {"type": "object", "properties": {}}}} for name, description in NOTE_TOOLS.items()]
    return build_catalog(defs)


def test_every_drive_tool_is_found_by_its_purpose():
    catalog = _catalog()
    for tool in TOOLS:
        query = "cloud drive " + tool["name"].replace("_", " ")
        found = [entry.name for entry in search_catalog(catalog, query, len(TOOLS))]
        assert f"mcp__UniWork-Drive__{tool['name']}" in found, (query, found)


def test_saving_to_cloud_drive_prefers_drive_over_note_connector():
    found = [entry.name for entry in search_catalog(_catalog(), "save file to cloud drive", 3)]
    assert found and found[0] == "mcp__UniWork-Drive__upload", found
