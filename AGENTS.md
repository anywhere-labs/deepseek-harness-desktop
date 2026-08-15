# AGENTS.md

This repository is a **thin Electron shell** around the official
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) runtime.
It does **not** contain, vendor, or fork any upstream source.

## Architecture invariant

- The official runtime (`@deepseek-ai/dsh`) and its Web UI
  (`@deepseek-ai/dsh-web-frontend`) are **npm dependencies**, pinned in
  `apps/desktop/runtime/package.json`.
- The Electron shell only: spawns the official `dsh web` Host as a subprocess
  (`apps/desktop/src/host-supervisor.ts`), owns the tray/window lifecycle, and
  packages the runtime closure into the installer.
- **Never** add `packages/`, `vendor/`, or copies of upstream sources back into
  this repository. Upstream upgrades are a version bump in the runtime
  manifest — never a source merge.

## Repository layout

```
apps/desktop/           Electron shell (main process, tray, window lifecycle)
apps/desktop/runtime/   npm pin manifest for the packaged Host (not a workspace member)
apps/desktop/scripts/   stage-runtime.ts — standalone npm install into runtime-host/
patches/                pnpm patches (electron-builder tooling only)
assets/                 release art
```

## Build & verify

```bash
pnpm install                 # workspace: shell + tooling only
pnpm typecheck               # desktop shell typecheck
pnpm build                   # bundle Electron main
pnpm --filter @deepseek-ai/dsh-desktop run package   # stage npm runtime + electron-builder --dir
```

Boot check for the staged Host (must print a `dsh web: http://127.0.0.1:<port>` line):

```bash
node --expose-internals apps/desktop/runtime-host/node_modules/@deepseek-ai/dsh/lib/bin.js web --host 127.0.0.1 --port 0
```

## Upstream upgrade procedure

1. Bump `apps/desktop/runtime/package.json` to the new published versions.
2. Re-run `stage-runtime` + the boot check above.
3. Re-run the desktop test suite; fix only `apps/desktop/` if the shell needs it.

If an upgrade requires changes outside `apps/desktop/`, the change belongs
upstream — open an issue/PR there instead.
