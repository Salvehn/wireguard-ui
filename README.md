# WireGuard Desktop

[Русский](README.ru.md) · **English** · [Download for Mac](https://github.com/Salvehn/wireguard-ui/releases/latest/download/WireGuard-Desktop-arm64.dmg)

A WireGuard client for macOS on Apple Silicon. Import `.conf` profiles, run multiple connections independently, and monitor traffic and peer handshakes. Manage tunnels from the window or menu bar; configurations and keys stay on your Mac.

## Split tunneling

Open **Smart tunneling** on a disconnected profile to choose what goes through that connection. Each profile has its own rules; they only narrow the original `AllowedIPs`.

| Mode | Traffic through this connection |
| --- | --- |
| Configuration routes | The routes from the imported `.conf` |
| Only listed addresses | Selected domains, IP addresses and CIDR networks |
| Except listed addresses | Original routes excluding the listed addresses |
| Only selected applications | Processes inside selected macOS `.app` bundles |
| Except selected applications | Processes outside the selected bundles |

**Domains and subdomains.** `example.com` matches the domain itself. `*.example.com` matches subdomains at any depth, such as `api.example.com` and `a.b.example.com`, but not the domain itself. Add both entries, or use the **Subdomains** button to add the wildcard alongside a domain. Wildcards learn IPv4/IPv6 addresses from system DNS queries and keep them until disconnection. Sites sharing an IP follow the same address rule; applications using their own DNS-over-HTTPS can bypass wildcard rules.

**Applications and multiple VPNs.** Choose `.app` bundles with the native macOS picker. Application rules and address rules are alternative modes within one profile; different profiles can use different modes at the same time. Specific work subnets of ordinary VPNs retain priority. When application rules overlap, the most recently connected profile wins. Excluded or unmatched traffic can use another active VPN; it is not necessarily sent directly. Disconnecting one profile preserves the others.

Address-list modes use system DNS. In application mode, system DNS follows ordinary routes, shared system services may not be identified as part of an app, and WireGuard peer statistics are unavailable. Restart selected applications after connecting. Connection or domain-route changes briefly restart the shared application engine and may interrupt its traffic. Updating the system helper may require an administrator password.

Wildcard and application routing are experimental: automated checks pass, but live VPN integration has not yet been verified.

Includes English and Russian, light and dark themes, and in-app updates with download progress and restart.

![WireGuard Desktop with a fictional demo connection](docs/images/desktop-macos-window.png)

*Demo data; no real VPN connection or private keys are shown.*

Release automation: [macOS release script](docs/releases.md).
