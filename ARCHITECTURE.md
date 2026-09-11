# Frontend architecture

The renderer uses Feature-Sliced Design. Imports cross slice boundaries only through public `index.ts` entry points, and only towards lower layers.

```text
src/
  app/                    Composition, window routing, global styles and system theme
  pages/
    workspace/            Full management window
    tray/                 Menu-bar popover
  widgets/
    tunnel-navigation/    Independent scrolling tunnel list
    tunnel-stats/         Peer handshake and transfer statistics
    event-log/            Session event journal
  features/
    edit-tunnel/          Masked configuration editor and save workflow
    manage-tunnels/       Pending operations and action error handling
  entities/
    tunnel/               Tunnel/peer models, IPC API, synchronized state polling
  shared/
    ui/card/              Generic value card
    ui/brand-icon/        Shared brand asset component
    ui/select/            Custom listbox select for header controls
    lib/format/           Byte and elapsed-time formatting
  main.tsx                Renderer bootstrap
```

`@/` resolves to `src/` in Vite and TypeScript. Modules inside a slice use relative imports; other slices consume its public API. `npm run check:architecture` checks static import/export boundaries and is part of `npm run build`.

Global layout styles are in `app/styles/base.css`; interaction states and the light theme overrides are in `app/styles/theme.css`. The resolved theme (`light`/`dark`) is set on `html[data-theme]` from a persisted preference (`system`/`light`/`dark`); Electron keeps `nativeTheme.themeSource = system`, resolves the system preference against macOS appearance, and updates window backgrounds to match.

`electron/` is a separate privileged runtime, outside renderer FSD. It owns configuration files, permissions, command execution, tray windows and IPC validation. Renderer code uses the preload API via `entities/tunnel`; it has no Node.js access. Existing IPC channel names and on-disk profiles remain compatible.

Validation: `npm run build`, `npm test`, `npm run package`.

Reference: https://fsd.how/docs/reference/layers/ and https://fsd.how/docs/reference/public-api/.

## Privileged runtime

`helper/` is a separate launchd service. `electron/helper-client.cjs` is the only IPC client and owns the one-time installation workflow. `scripts/prepare-helper.mjs` assembles a self-contained, immutable runtime under `build/helper`, shipped as an Electron extra resource. The root server accepts a narrow validated JSON protocol over a UID-restricted Unix socket. All backend binaries are copied into the root-owned installation and checked for external dylib dependencies at build time.

Renderer `shared/lib/view-transition` batches React updates with `flushSync` inside `document.startViewTransition`, handles interrupted transitions and respects reduced motion. Routine polling animates only structural/status changes, not every traffic counter increment.
