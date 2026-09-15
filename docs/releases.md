# macOS and Windows releases

Stable releases contain a macOS arm64 DMG/ZIP and a Windows x64 NSIS installer under the same version and Git tag.

On an Apple Silicon Mac, commit source changes on `main`, then run:

```sh
npm run release:mac -- patch
```

The command increments the version, runs tests, builds the macOS artifacts, signs the macOS update manifest, commits the version bump, creates and atomically pushes `main` and the tag, verifies the uploaded assets, and publishes the GitHub release.

The tag starts `.github/workflows/windows-release.yml` on a Windows runner. That job:

1. Runs all tests and builds the renderer.
2. Downloads pinned Node.js, sing-box, and official WireGuard for Windows artifacts and verifies their SHA-256 hashes.
3. Compiles the Windows helper service host.
4. Builds the x64 NSIS installer.
5. Signs `update-windows-x64.json` with the existing update key.
6. Adds the installer, blockmap, and manifest to the same published GitHub release and verifies their remote hashes.

The repository must contain an Actions secret named `UPDATE_PRIVATE_KEY_PEM`. It contains the existing `.update-keys/update-private.pem`; installed applications trust the corresponding public key in `electron/update-public-key.pem`. Never generate a replacement key for an existing update channel.

Use `minor`, `major`, or an explicit version instead of `patch`. Omit the version argument to publish the current package version. Add `--notes path/to/notes.md` for English release notes; otherwise GitHub generates them from commits.

Requirements:

- A clean `main` branch with `origin` pointing to `Salvehn/wireguard-ui`.
- `gh auth login` with permission to push and publish releases, or an appropriate `GH_TOKEN`.
- The macOS build dependencies used by `npm run dist:mac`.
- The update signing key at `.update-keys/update-private.pem`, `UPDATE_PRIVATE_KEY_FILE`, or `UPDATE_PRIVATE_KEY_BASE64`.
- The `UPDATE_PRIVATE_KEY_PEM` GitHub Actions secret for Windows manifests.
- A Windows code-signing certificate in the optional `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD` Actions secrets for public distribution. An unsigned development installer can be built without these values.

To resume an interrupted macOS upload using an existing build:

```sh
npm run release:mac -- --skip-build --notes path/to/notes.md
```

To rerun the Windows job for the current tag, use the **Windows release** workflow in GitHub Actions. Existing matching assets are reused; differing published assets are rejected.

Local validation commands:

```sh
npm run test:release
npm test
npm run build
# On Windows x64:
npm run dist:win
npm run update:manifest:win
```

Tags are never force-pushed. A failed macOS build stops before tagging. The Windows publisher only adds the three verified Windows assets to the matching published release and never changes its tag or release notes.
