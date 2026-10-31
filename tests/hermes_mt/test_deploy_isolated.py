"""Independent deployment entrypoint: real init and Compose resolution, without a daemon."""

import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest


DEPLOY = Path(__file__).resolve().parents[2] / "deploy" / "hermes-mt"


def _checkout(tmp_path, name):
    root = tmp_path / name
    target = root / "deploy" / "hermes-mt"
    target.mkdir(parents=True)
    for file in ("deploy.sh", "deploy-isolated.sh", "compose.isolated.yaml", ".gitignore"):
        shutil.copyfile(DEPLOY / file, target / file)
    (target / "scripts").mkdir()
    shutil.copyfile(DEPLOY / "scripts" / "image_overlay.py", target / "scripts" / "image_overlay.py")
    shutil.copyfile(DEPLOY / "scripts" / "check-network-subnet.py", target / "scripts" / "check-network-subnet.py")
    shutil.copyfile(DEPLOY / "overlay.list", target / "overlay.list")
    subprocess.run(["git", "init", str(root)], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(root), "add", "."], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(root), "-c", "user.name=Test", "-c",
                    "user.email=test@example.invalid", "commit", "-m", "fixture"],
                   check=True, capture_output=True)
    return target


def _run(target, *args):
    return subprocess.run(
        ["bash", str(target / "deploy-isolated.sh"), *args],
        capture_output=True, text=True,
    )


def test_two_checkouts_resolve_disjoint_resources_and_keep_secrets_local(tmp_path):
    try:
        available = subprocess.run(["docker", "compose", "version"], capture_output=True)
    except FileNotFoundError:
        pytest.skip("Docker Compose is required for offline deployment config validation")
    if available.returncode:
        pytest.skip("Docker Compose is unavailable")
    configs = []
    for name, port, subnet in (("hermes-adaptation", "18082", "172.30.90.0/24"),
                               ("hermes-ch", "18083", "172.30.91.0/24")):
        target = _checkout(tmp_path, name)
        result = _run(target, "init", "--project", name, "--subnet", subnet,
                      "--http-port", f"192.168.1.7:{port}",
                      "--cube-api", "http://cube:3000", "--cube-proxy", "http://proxy")
        assert result.returncode == 0, result.stderr
        env_path = target / "entry.env"
        settings = dict(line.split("=", 1) for line in env_path.read_text().splitlines())
        assert env_path.stat().st_mode & 0o777 == 0o600
        for key in ("MT_CREDENTIAL_KEY", "MT_POSTGRES_PASSWORD"):
            assert settings[key] not in result.stdout + result.stderr
        before = env_path.read_bytes()
        assert _run(target, "init", "--project", name, "--subnet", subnet,
                    "--http-port", f"192.168.1.7:{port}",
                    "--cube-api", "http://cube:3000", "--cube-proxy", "http://proxy").returncode != 0
        assert env_path.read_bytes() == before
        ignored = subprocess.run(["git", "-C", str(target), "check-ignore", "entry.env"], capture_output=True)
        assert ignored.returncode == 0
        # This override must never be loaded by the independent entrypoint.
        (target / "compose.override.yaml").write_text("invalid: [yaml\n")
        result = _run(target, "config")
        assert result.returncode == 0, result.stderr
        clean_env = {k: v for k, v in os.environ.items() if not k.startswith(("MT_", "COMPOSE_"))}
        rendered = subprocess.run(
            ["docker", "compose", "--env-file", str(env_path), "-f",
             str(target / "compose.isolated.yaml"), "--profile", "messaging",
             "config", "--format", "json"],
            check=True, capture_output=True, text=True, env=clean_env,
        )
        config = json.loads(rendered.stdout)
        services = config["services"]
        assert not services["postgres"].get("ports")
        assert not services["entry"].get("volumes")
        assert services["entry"]["environment"]["MT_SELF_CONTAINER"] == services["entry"]["container_name"]
        assert services["nginx"]["ports"][0]["published"] == port
        assert next(iter(config["networks"].values()))["ipam"]["config"][0]["subnet"] == subnet
        configs.append((settings, config))
    left, right = configs
    for key in ("MT_PREFIX", "MT_COOKIE", "MT_CREDENTIAL_KEY", "MT_POSTGRES_PASSWORD"):
        assert left[0][key] != right[0][key]
    for kind in ("networks", "volumes"):
        assert {v["name"] for v in left[1][kind].values()}.isdisjoint(
            v["name"] for v in right[1][kind].values())
    for field in ("container_name", "image"):
        # PostgreSQL's upstream image may be shared; application images may not.
        assert {s[field] for k, s in left[1]["services"].items() if k != "postgres"}.isdisjoint(
            s[field] for k, s in right[1]["services"].items() if k != "postgres")


def test_cleanup_is_refused_and_legacy_config_cannot_start_an_isolated_deployment(tmp_path):
    target = _checkout(tmp_path, "legacy")
    for command in ("purge-old", "purge-templates"):
        result = _run(target, command, "--yes")
        assert result.returncode != 0
        assert "禁用" in result.stderr
        assert not (target / "entry.env").exists()
    (target / "entry.env").write_text("MT_DEPLOY_PROJECT=hermes-mt\n")
    for command in ("up", "all", "template", "image", "config"):
        result = _run(target, command, "--no-pull")
        assert result.returncode != 0
        assert "hermes-mt" in result.stderr
        assert not (target / ".isolated-running").exists()
