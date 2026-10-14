"""Prepare an interpreter that can run the icon generator without a Hermes install.

Pillow and resvg-py are core runtime dependencies, so builders that have no
Hermes runtime environment (desktop bundles, product staging) render icons on
the locked runtime dependencies alone, without installing the application.
"""
from __future__ import annotations

import os
from pathlib import Path
import sys
import time

# Builders import this file from a separately prepared source tree.
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import pm


def prepare_icon_environment(source: Path, out: Path, cache: Path | None) -> Path:
    """Prepare a fresh interpreter with the locked runtime dependencies only."""
    for attempt in range(3):
        try:
            return pm.build_environment(
                source=source.resolve(), out=out.resolve(), cache=cache.resolve() if cache else None,
                no_install_project=True, explicit=True,
            )
        except pm.InstallError as exc:
            # Windows Defender may briefly lock uv's generated launcher while its PE resources change.
            transient = (os.name == "nt" and "Failed to update Windows PE resources" in exc.cause
                         and "uv-trampoline-" in exc.cause)
            if not transient or attempt == 2:
                raise
            print(f"  icon environment: Windows held a uv launcher; retrying ({attempt + 2}/3)...",
                  flush=True)
            time.sleep(0.5 * 2 ** attempt)
    raise AssertionError("unreachable")
