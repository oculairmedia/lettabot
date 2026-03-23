#!/usr/bin/env python3
"""Pull stats from an ASUS router via its HTTP API.

Usage:
  router-stats.py [--host HOST] [--user USER] [--pass PASS] [SECTION...]

Sections (default: summary):
  summary    - Quick overview (CPU, RAM, WAN, uptime)
  clients    - Connected devices list
  traffic    - Network traffic per interface
  cpu        - CPU usage details
  memory     - RAM usage details
  wan        - WAN connection info
  ports      - Port/NAT forwarding rules
  vpn        - VPN status (OpenVPN/WireGuard)
  wifi       - Wireless radio info
  all        - Everything

Environment variables (fallback for flags):
  ASUS_ROUTER_HOST  (default: 192.168.50.1)
  ASUS_ROUTER_USER  (default: admin)
  ASUS_ROUTER_PASS  (required)
"""

import argparse
import asyncio
import json
import os
import sys

try:
    from asusrouter import AsusRouter, AsusData
except ImportError:
    print("Error: asusrouter not installed. Run: pip3 install asusrouter", file=sys.stderr)
    sys.exit(1)


def env(name, default=None):
    return os.environ.get(name, default)


async def get_stats(host, username, password, sections):
    router = AsusRouter(
        hostname=host,
        username=username,
        password=password,
        use_ssl=False,
    )

    try:
        await router.async_connect()
    except Exception as e:
        print(f"Error connecting to {host}: {e}", file=sys.stderr)
        sys.exit(1)

    results = {}

    try:
        if "all" in sections:
            sections = ["summary", "clients", "traffic", "cpu", "memory", "wan", "wifi"]

        for section in sections:
            try:
                if section == "summary":
                    cpu = await router.async_get_data(AsusData.CPU)
                    ram = await router.async_get_data(AsusData.RAM)
                    wan = await router.async_get_data(AsusData.WAN)
                    sysinfo = await router.async_get_data(AsusData.SYSINFO)
                    results["summary"] = {
                        "cpu": _serialize(cpu),
                        "ram": _serialize(ram),
                        "wan": _serialize(wan),
                        "sysinfo": _serialize(sysinfo),
                    }
                elif section == "clients":
                    data = await router.async_get_data(AsusData.CLIENTS)
                    results["clients"] = _serialize(data)
                elif section == "traffic":
                    data = await router.async_get_data(AsusData.NETWORK)
                    results["traffic"] = _serialize(data)
                elif section == "cpu":
                    data = await router.async_get_data(AsusData.CPU)
                    results["cpu"] = _serialize(data)
                elif section == "memory":
                    data = await router.async_get_data(AsusData.RAM)
                    results["memory"] = _serialize(data)
                elif section == "wan":
                    data = await router.async_get_data(AsusData.WAN)
                    results["wan"] = _serialize(data)
                elif section == "wifi":
                    data = await router.async_get_data(AsusData.GWLAN)
                    results["wifi"] = _serialize(data)
                elif section == "ports":
                    data = await router.async_get_data(AsusData.PORT_FORWARDING)
                    results["ports"] = _serialize(data)
                elif section == "vpn":
                    data = await router.async_get_data(AsusData.OPENVPN_CLIENT)
                    results["vpn"] = _serialize(data)
                else:
                    results[section] = {"error": f"Unknown section: {section}"}
            except Exception as e:
                results[section] = {"error": str(e)}

    finally:
        await router.async_disconnect()

    print(json.dumps(results, indent=2, default=str))


def _serialize(obj):
    """Convert asusrouter data objects to JSON-safe dicts."""
    if obj is None:
        return None
    if isinstance(obj, dict):
        return {str(k): _serialize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_serialize(i) for i in obj]
    if hasattr(obj, "__dict__"):
        return {k: _serialize(v) for k, v in obj.__dict__.items() if not k.startswith("_")}
    return obj


def main():
    parser = argparse.ArgumentParser(description="Pull ASUS router stats")
    parser.add_argument("sections", nargs="*", default=["summary"],
                        help="Sections to pull (summary, clients, traffic, cpu, memory, wan, wifi, ports, vpn, all)")
    parser.add_argument("--host", default=env("ASUS_ROUTER_HOST", "192.168.50.1"))
    parser.add_argument("--user", default=env("ASUS_ROUTER_USER", "manysplace"))
    parser.add_argument("--pass", dest="password", default=env("ASUS_ROUTER_PASS"))

    args = parser.parse_args()

    if not args.password:
        print("Error: Router password required. Set ASUS_ROUTER_PASS or use --pass", file=sys.stderr)
        sys.exit(1)

    asyncio.run(get_stats(args.host, args.user, args.password, args.sections))


if __name__ == "__main__":
    main()
