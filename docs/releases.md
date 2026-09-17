# macOS and Windows releases

Stable releases contain a macOS arm64 DMG/ZIP and a Windows x64 NSIS installer under the same version and Git tag. GitHub Actions builds both platforms and publishes the release only after both jobs pass.

Commit source changes on `main`, then run:

```sh
npm run release -- patch
```

The command runs local tests and a renderer build, increments the version, commits the version bump, and atomically pushes `main` and the tag. The tag starts `.github/workflows/desktop-release.yml`.

The macOS arm64 job:

1. Runs all tests and assembles the privileged launchd helper.
2. Builds the DMG and ZIP on a native Apple Silicon runner.
3. Verifies the packaged helper, app signature, and bundle version.
4. Uploads the unsigned release files without access to the update-signing key.

The Windows x64 job:

1. Runs all tests and builds the renderer.
2. Downloads pinned Node.js, sing-box, and official WireGuard artifacts, then verifies their SHA-256 hashes and the WireGuard Authenticode signature.
3. Extracts the WireGuard runtime into the helper, compiles the LocalSystem host, and builds a standalone NSIS installer.
4. Installs only the bundled helper and smoke-tests a native tunnel on Windows without a separate WireGuard client.
5. Uploads the unsigned release files without access to the update-signing key.

A protected Linux signing job downloads both artifact sets. GitHub pauses this job for approval by the repository owner, then exposes the update key only to the step that signs both manifests. A final Linux job verifies the manifests and all hashes, creates or resumes one draft, uploads exactly eight assets, publishes it as latest, and verifies both public update endpoints.

The tag-only `release` environment must contain a secret named `UPDATE_PRIVATE_KEY_PEM`. It contains the existing `.update-keys/update-private.pem`; installed applications trust the corresponding public key in `electron/update-public-key.pem`. Keep this key out of repository-level secrets and never generate a replacement key for an existing update channel.

Use `minor`, `major`, or an explicit version instead of `patch`. Omit the version argument to release the current package version. Add `--notes path/to/notes.md` for English release notes; otherwise GitHub generates them from commits. `--skip-checks` skips duplicate local checks, while both Actions runners still run their required checks.

Requirements:

- A clean `main` branch with `origin` pointing to `Salvehn/wireguard-ui`.
- `gh auth login` with permission to push tags, edit releases, and run workflows.
- Approval of the protected `release` environment after both platform builds pass.
- The `UPDATE_PRIVATE_KEY_PEM` secret in that environment.
- Optional Windows Authenticode credentials in `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD`. Without them, Actions produces an unsigned Windows application installer whose update manifest remains cryptographically signed and verified.

To rebuild an existing tag, use `npm run release` while that tag is checked out at `HEAD`; the command dispatches the workflow on the tag itself. Approve the `release` environment when prompted. Published files are immutable: the publisher accepts matching assets and rejects any mismatch or unexpected asset.

Local validation commands:

```sh
npm run test:release
npm test
npm run build
```

Platform package commands remain available for diagnosis:

```sh
npm run dist:mac
npm run dist:win
```

Tags are never force-pushed. A failed platform build leaves the release unpublished. Rerunning the workflow safely resumes a matching draft.
