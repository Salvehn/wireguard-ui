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
4. Creates the signed macOS update manifest.

The Windows x64 job:

1. Runs all tests and builds the renderer.
2. Downloads pinned Node.js, sing-box, and official WireGuard artifacts and verifies their SHA-256 hashes.
3. Compiles the LocalSystem helper host and builds the NSIS installer.
4. Installs the helper and smoke-tests native, wildcard-domain, and application routing on Windows.
5. Creates the signed Windows update manifest.

A final Linux job downloads both artifact sets, verifies both signed manifests and all hashes, creates or resumes one draft, uploads exactly eight assets, publishes it as latest, and verifies both public update endpoints.

The repository must contain an Actions secret named `UPDATE_PRIVATE_KEY_PEM`. It contains the existing `.update-keys/update-private.pem`; installed applications trust the corresponding public key in `electron/update-public-key.pem`. Never generate a replacement key for an existing update channel.

Use `minor`, `major`, or an explicit version instead of `patch`. Omit the version argument to release the current package version. Add `--notes path/to/notes.md` for English release notes; otherwise GitHub generates them from commits. `--skip-checks` skips duplicate local checks, while both Actions runners still run their required checks.

Requirements:

- A clean `main` branch with `origin` pointing to `Salvehn/wireguard-ui`.
- `gh auth login` with permission to push tags, edit releases, and run workflows.
- The `UPDATE_PRIVATE_KEY_PEM` Actions secret.
- Optional Windows Authenticode credentials in `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD`. Without them, Actions produces an unsigned Windows application installer whose update manifest remains cryptographically signed and verified.

To rebuild an existing tag, rerun the **Desktop build and release** workflow with that tag. Published files are immutable: the publisher accepts matching assets and rejects any mismatch or unexpected asset.

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
