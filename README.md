# WireGuard Desktop

[Русский](README.ru.md) · **English**

Connect to WireGuard VPN on a Mac with Apple Silicon (M1 or later).

[**Download for Mac**](https://github.com/Salvehn/wireguard-ui/releases/latest/download/WireGuard-Desktop-arm64.dmg)

## Install

1. Download and open the DMG.
2. Drag **WireGuard Desktop** into **Applications**.
3. Open the app and approve the system helper installation with your administrator password. You can then connect and disconnect without repeated password prompts.

If macOS blocks the app, open **System Settings → Privacy & Security → Open Anyway**. The app is not yet signed with an Apple Developer ID.

## Connect

1. Click **Add tunnel** or **Import configuration** and select the `.conf` file provided by your VPN provider or administrator.
2. Select the tunnel and click **Connect**.
3. Click **Disconnect** to end the connection.

**Parallel connections are supported:** keep multiple tunnels connected at once and connect or disconnect each independently. Use **Edit** to change a configuration, or the menu bar icon to manage connections.

## Good to know

- The app follows your system language and appearance. You can choose English or Russian, and light or dark theme, manually at the top of the window.
- Your configurations and keys stay on your Mac.
- Closing the window keeps the app and your tunnels running in the menu bar. Quitting the app disconnects all active tunnels; use **Disconnect** to stop a single tunnel.
- Traffic statistics refresh automatically. An active tunnel alone does not guarantee that the server is reachable.

[All releases](https://github.com/Salvehn/wireguard-ui/releases) · [Report an issue](https://github.com/Salvehn/wireguard-ui/issues)

## Publishing an update

The app verifies updates with its own Ed25519 key, so an Apple Developer subscription is not required. Back up `.update-keys/update-private.pem` securely and never commit or share it: every future update must be signed with this key.

Increment `version` in `package.json`, commit the release, then run `GH_TOKEN=… npm run release:mac`. The command builds the DMG and ZIP, signs `update-arm64.json`, uploads all assets to a draft GitHub Release, and publishes it only after every upload succeeds.
