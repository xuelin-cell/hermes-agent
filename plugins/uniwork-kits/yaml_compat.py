"""YAML for this plugin on either Hermes line.

Newer Hermes (``desktop-mt`` and upstream since 2026-09) dropped PyYAML for
ruamel.yaml behind ``hermes_yaml``, which keeps PyYAML's ``safe_load`` /
``safe_dump`` / ``YAMLError`` names and arguments. ``develop-uni`` still ships
PyYAML. Importing ``yaml`` directly would break the plugin on the newer line.
"""

from __future__ import annotations

try:
    import hermes_yaml as _yaml
except ImportError:  # develop-uni: PyYAML is a core dependency there
    import yaml as _yaml  # type: ignore[no-redef]

safe_load = _yaml.safe_load
safe_dump = _yaml.safe_dump
YAMLError = _yaml.YAMLError
