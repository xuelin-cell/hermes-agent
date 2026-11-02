"""Cloud-only SDK selection must land in the image's sealed environment."""

import importlib.util
from pathlib import Path
import shlex
import sys

from tests.pm._fixtures import _run, build_worker, client, isolated_python
from tests.pm.test_environment_build import locked_project


def test_cloud_extra_is_importable_from_the_explicit_sealed_destination(locked_project, build_worker, tmp_path):
    import pm

    repo = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location("cloud_base_seed", repo / "deploy/hermes-mt/scripts/base_seed.py")
    seed = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(seed)
    derived = seed.derive_dockerfile((repo / "Dockerfile").read_text())
    stage = derived.split(" AS python_deps\n", 1)[1].split("\nFROM ", 1)[0]
    words = shlex.split(stage.replace("\\\n", " "))
    # Exercise the cloud-only selection with a tiny, offline SDK stand-in.
    extras = [words[i + 1] for i, word in enumerate(words[:-1])
              if word == "--extra" and words[i + 1] == "langfuse"]
    source, uv, env = locked_project
    metadata = source / "pyproject.toml"
    metadata.write_text(metadata.read_text().replace("chosen=", "langfuse="))
    _run([str(uv), "lock", "--python", sys.executable], cwd=source, env=env)
    out = tmp_path / "sealed-image-env"
    python = pm.build_environment(source=source, out=out, python=Path(sys.executable),
                                  cache=tmp_path / "cache", env=env, extras=extras,
                                  no_install_project=True, sealed=True, offline=True, explicit=True)
    assert python.parent.parent == out
    assert _run([str(python), "-I", "-c", "import base_dep, chosen_dep; print(chosen_dep.__version__)"],
                cwd=tmp_path, env=env) == "1.0"
    assert not Path(env["HERMES_HOME"]).exists()
