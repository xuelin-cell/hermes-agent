"""Deployment subnets must not shadow cluster endpoints or existing routes."""

import importlib.util
import ipaddress
from pathlib import Path
import subprocess
import sys

import pytest


SCRIPT = Path(__file__).resolve().parents[2] / "deploy/hermes-mt/scripts/check-network-subnet.py"


def test_subnet_cli_rejects_cluster_overlap_before_any_network_is_created():
    for subnet in ("", "192.168.208.0/20", "192.168.0.0/16", "8.8.8.0/24", "172.30.89.1/24"):
        result = subprocess.run([sys.executable, str(SCRIPT), subnet,
                                 "http://192.168.212.23:3000", "192.168.0.7:18082"],
                                capture_output=True, text=True)
        assert result.returncode != 0, subnet
        assert "网络子网检查失败" in result.stderr
    result = subprocess.run([sys.executable, str(SCRIPT), "172.30.89.0/24",
                             "http://192.168.212.23:3000", "192.168.0.7:18082"],
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_routes_only_allow_the_exact_existing_bridge_owned_by_this_deployment():
    spec = importlib.util.spec_from_file_location("deploy_network", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    network = ipaddress.ip_network("172.30.89.0/24")
    routes = "default via 192.168.2.1 dev eth1\n172.30.88.0/24 dev br-other\n"
    module.validate_routes(network, routes, "")
    own = "172.30.89.0/24 dev br-owned proto kernel scope link src 172.30.89.1\n"
    module.validate_routes(network, routes + own, "br-owned")
    for conflict in (own.replace("br-owned", "eth0"),
                     own.replace("172.30.89.0/24", "172.30.0.0/16"),
                     "172.30.89.50 via 192.168.0.1 dev eth0\n"):
        with pytest.raises(ValueError, match="重叠"):
            module.validate_routes(network, routes + conflict, "br-owned")
