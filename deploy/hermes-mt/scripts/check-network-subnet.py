"""Reject Docker subnets that shadow deployment endpoints or host routes (Python 3.6)."""

import argparse
import ipaddress
import json
import subprocess
from urllib.parse import urlsplit


def validate(subnet, endpoints):
    if not subnet:
        raise ValueError("请设置 MT_DOCKER_SUBNET；必须由部署方选择未占用的私有 IPv4 子网")
    network = ipaddress.ip_network(subnet, strict=True)
    private = [ipaddress.ip_network(value) for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")]
    if network.version != 4 or not any(network.overlaps(item) and network.prefixlen >= item.prefixlen for item in private):
        raise ValueError("MT_DOCKER_SUBNET 必须是 RFC1918 私有 IPv4 子网")
    for endpoint in endpoints:
        host = urlsplit(endpoint if "://" in endpoint else "//" + endpoint).hostname
        try:
            address = ipaddress.ip_address(host or "")
        except ValueError:
            continue
        if address in network:
            raise ValueError("子网 {} 覆盖部署依赖地址 {}，会劫持宿主机路由".format(network, address))
    return network


def validate_routes(network, route_text, own_bridge):
    for line in route_text.splitlines():
        fields = line.split()
        if not fields or fields[0] == "default":
            continue
        try:
            route = ipaddress.ip_network(fields[0], strict=False)
        except ValueError:
            continue
        if not network.overlaps(route):
            continue
        device = fields[fields.index("dev") + 1] if "dev" in fields else ""
        if own_bridge and device == own_bridge and route == network:
            continue
        raise ValueError("子网 {} 与现有路由 {} ({}) 重叠".format(network, route, device))


def command(*args):
    return subprocess.check_output(list(args), universal_newlines=True, timeout=30)


def check_host(network, project):
    ids = command("docker", "network", "ls", "-q").split()
    networks = json.loads(command("docker", "network", "inspect", *ids)) if ids else []
    own_bridge = ""
    for item in networks:
        own = item.get("Name") == project
        for config in (item.get("IPAM") or {}).get("Config") or []:
            value = config.get("Subnet")
            if not value:
                continue
            existing = ipaddress.ip_network(value, strict=False)
            if existing.version != network.version:
                continue
            if own:
                if existing != network:
                    raise ValueError("本部署网络仍使用 {}；请先仅对本部署执行 compose down（不加 -v）".format(existing))
                options = item.get("Options") or {}
                own_bridge = options.get("com.docker.network.bridge.name") or "br-" + item["Id"][:12]
            elif network.overlaps(existing):
                raise ValueError("子网 {} 与 Docker 网络 {} 的 {} 重叠".format(network, item["Name"], existing))
    validate_routes(network, command("ip", "-4", "route", "show"), own_bridge)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("subnet")
    parser.add_argument("endpoints", nargs="*")
    parser.add_argument("--host-project")
    args = parser.parse_args()
    try:
        network = validate(args.subnet, args.endpoints)
        if args.host_project:
            check_host(network, args.host_project)
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        parser.exit(1, "[停止] 网络子网检查失败：{}\n".format(exc))


if __name__ == "__main__":
    main()
