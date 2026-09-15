# Repository instructions

## GitHub changelog

- Write all changelog entries and release notes published on GitHub in English.

## Releases

- Start a release through `npm run release`. Its tag triggers the desktop release workflow, which builds verified macOS arm64 and Windows x64 assets together. Approve the protected `release` environment to sign and publish them.
