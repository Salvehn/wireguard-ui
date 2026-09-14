# macOS releases

On an Apple Silicon Mac, commit the source changes on `main`, then run:

```sh
npm run release:mac -- patch
```

This increments the patch version, runs the application and release checks, builds the DMG and ZIP, signs the update manifest, commits the version bump, creates and pushes the tag, uploads a draft, verifies all five asset hashes, and publishes it as the latest release. It then checks the public update manifest and its signature.

Use `minor`, `major`, or an explicit version instead of `patch`. Omit the version argument to publish the current package version. Add `--notes path/to/notes.md` for release notes; otherwise GitHub generates them from commits.

Requirements:

- A clean `main` branch in this repository, with `origin` pointing to `Salvehn/wireguard-ui`.
- `gh auth login` with permission to push and publish releases; an existing `GH_TOKEN` also works.
- The existing macOS build tools and dependencies used by `npm run dist:mac`.
- The existing update signing key at `.update-keys/update-private.pem`, or `UPDATE_PRIVATE_KEY_FILE` / `UPDATE_PRIVATE_KEY_BASE64`. Never replace the key to fix a release: installed apps trust the corresponding public key.

To resume an interrupted upload using the existing build:

```sh
npm run release:mac -- --skip-build --notes path/to/notes.md
```

The script checks the version, manifest signature, ZIP hash, app signature, remote tag, and uploaded asset hashes. It reuses matching draft assets and replaces mismatched assets only while the release is a draft. Already published releases are verified without overwriting them. Tags are never force-pushed.

A failed build stops before tagging or publishing. If a version bump was written, inspect and commit it before retrying the current version. If publication succeeded but public endpoint verification failed, repeat the command with `--skip-build` to verify again.

`node scripts/publish-release.mjs --notes path/to/notes.md` runs only the publication phase for an already tagged and built version. `npm run test:release` runs the local release-validation tests.
