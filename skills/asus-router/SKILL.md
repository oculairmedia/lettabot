---
name: asus-router
description: Pull stats from ASUS RT-AX82U router on demand — connected clients, CPU, memory, WAN, traffic, WiFi, VPN status. Use when the user asks about router stats, network devices, connected clients, bandwidth usage, or router health.
---

# ASUS Router Stats

Pull real-time stats from the ASUS RT-AX82U router via its HTTP API using the `asusrouter` Python library.

## Prerequisites

- Python package: `pip3 install asusrouter`
- Env vars set in `/opt/stacks/lettabot/.env`: `ASUS_ROUTER_HOST`, `ASUS_ROUTER_USER`, `ASUS_ROUTER_PASS`
- Source the env before running: `set -a; source /opt/stacks/lettabot/.env; set +a`

## Usage

```bash
# Quick summary (CPU, RAM, WAN, uptime)
python3 scripts/router-stats.py summary

# Connected devices
python3 scripts/router-stats.py clients

# Multiple sections
python3 scripts/router-stats.py cpu memory traffic

# Everything
python3 scripts/router-stats.py all

# With explicit credentials
python3 scripts/router-stats.py --host 192.168.50.1 --user admin --pass SECRET summary
```

## Available Sections

| Section   | Data                                          |
|-----------|-----------------------------------------------|
| `summary` | CPU, RAM, WAN status, system info (default)   |
| `clients` | Connected devices with names, IPs, MACs       |
| `traffic` | Network traffic per interface (rx/tx)          |
| `cpu`     | CPU usage breakdown                           |
| `memory`  | RAM usage details                             |
| `wan`     | WAN connection info (IP, DNS, gateway, status)|
| `wifi`    | Wireless radio info and guest networks        |
| `ports`   | Port forwarding / NAT rules                   |
| `vpn`     | OpenVPN / WireGuard client status             |
| `all`     | All of the above                              |

## Output

JSON to stdout. Parse or present as appropriate for the user's question.

## Credential Setup

Store the router password so it persists across sessions:

```bash
# Add to the host environment or a .env file
echo 'ASUS_ROUTER_PASS=your_password_here' >> /opt/stacks/lettabot/.env
```

## Troubleshooting

- **Connection refused**: Ensure "Enable Web Access from WAN" is off but LAN access is enabled in router settings
- **Auth failure**: Verify username (default: `admin`) and password match the router's web UI login
- **Timeout**: Router may be under load; retry after a few seconds
