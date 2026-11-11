"""Stage the supplied Windows PPT runtime as a complete, unmodified sidecar."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

SLIDEP = "node/node_modules/@tencent/slidep"
REQUIRED_FILES = (
    "engine/editor_sdk.exe",
    "node/node.exe",
    f"{SLIDEP}/package.json",
    f"{SLIDEP}/dist/index.js",
    f"{SLIDEP}/dist/resources/pptx/blank.pptx",
    f"{SLIDEP}/node_modules/@swc/core-win32-x64-msvc/swc.win32-x64-msvc.node",
    f"{SLIDEP}/node_modules/canvas/build/Release/canvas.node",
    f"{SLIDEP}/node_modules/gl/build/Release/webgl.node",
    f"{SLIDEP}/node_modules/skia-canvas/lib/skia.node",
    f"{SLIDEP}/node_modules/yoga-wasm-web/dist/yoga.wasm",
    f"{SLIDEP}/node_modules/@fortawesome/fontawesome-free/webfonts/fa-solid-900.woff2",
)


def probe_node(source: Path) -> dict[str, Any]:
    """Check the bundled Node platform and ABI rather than the build host's Node."""
    env = dict(os.environ)
    env.pop("NODE_OPTIONS", None)
    result = subprocess.run(
        [str(source / "node/node.exe"), "-p", "JSON.stringify({version:process.versions.node,abi:process.versions.modules,platform:process.platform,arch:process.arch})"],
        capture_output=True, text=True, check=True, timeout=15, env=env,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    node = json.loads(result.stdout)
    if (node["platform"], node["arch"], node["abi"]) != ("win32", "x64", "127"):
        raise ValueError(f"PPT运行时需要配套的Windows x64 Node 22 / ABI 127，实际为：{node}")
    return node


def stage_runtime(source: Path, destination: Path) -> dict[str, Any]:
    """Copy engine and Node dependencies, excluding host logs, state and accounts.

    The destination must be new, so an upgrade cannot silently mix two releases.
    The normal backend build already creates a fresh backend_dist directory.
    """
    source, destination = source.resolve(), destination.resolve()
    if destination == source or source in destination.parents or destination in source.parents:
        raise ValueError("PPT运行时来源与打包目录不能相互包含")
    missing = [name for name in REQUIRED_FILES if not (source / name).is_file()]
    if missing:
        raise FileNotFoundError("PPT运行时不完整：" + ", ".join(missing))
    node = probe_node(source)
    package = json.loads((source / SLIDEP / "package.json").read_text(encoding="utf-8"))
    if package["name"] != "@tencent/slidep":
        raise ValueError("PPT运行时中的slidep包身份不正确")
    destination.mkdir(parents=True, exist_ok=False)
    for folder in ("engine", "node"):
        shutil.copytree(source / folder, destination / folder)
    files = {}
    for file in sorted(destination.rglob("*")):
        if file.is_file():
            with file.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            files[file.relative_to(destination).as_posix()] = {"bytes": file.stat().st_size, "sha256": digest}
    manifest = {"schema": 1, "node": node, "slidep_version": package["version"], "files": files}
    (destination / "bundle-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def main() -> None:
    """Prepare the sidecar consumed by all Windows backend_dist installers."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--destination", required=True, type=Path)
    args = parser.parse_args()
    manifest = stage_runtime(args.source, args.destination)
    print(f"PPT运行时已打包：slidep {manifest['slidep_version']}，Node {manifest['node']['version']}，{len(manifest['files'])}个文件")


if __name__ == "__main__":
    main()
