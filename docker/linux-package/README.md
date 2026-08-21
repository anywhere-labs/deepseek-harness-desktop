# Linux packaging Docker harness

Reproducible Linux packaging and install verification for DSH Desktop, for
developers on a host that lacks `rpmbuild` (or wants an isolated, disposable
build environment). Run all commands from the repository root.

```bash
docker compose -f docker/linux-package/compose.yml build package
docker compose -f docker/linux-package/compose.yml run --rm package
docker compose -f docker/linux-package/compose.yml run --rm verify-deb
docker compose -f docker/linux-package/compose.yml run --rm verify-rpm
```

`package` builds the deb, rpm, and AppImage into `dsh-plugin-desktop/dist/`.
`verify-deb` and `verify-rpm` install the resulting package into a clean
Ubuntu 24.04 / Fedora container and assert the installed layout (executable,
symlink, icons, desktop entry).

## Host UID/GID

The `package` service runs as a non-root user inside the container so the
bind-mounted repository never receives root-owned files. It defaults to
1000:1000, matching the `node` base image. When the host account is not
1000:1000, override it:

```bash
DSH_UID=$(id -u) DSH_GID=$(id -g) docker compose -f docker/linux-package/compose.yml build package
DSH_UID=$(id -u) DSH_GID=$(id -g) docker compose -f docker/linux-package/compose.yml run --rm package
```

## Caches

Two named volumes persist across runs:

- `dsh-cache` — Yarn's package cache and electron-builder's downloaded
  toolsets (fpm, AppImage, 7zip).
- `dsh-home` — the container build user's `$HOME`, including Electron's own
  download caches.

Clear both with:

```bash
docker compose -f docker/linux-package/compose.yml down -v
```

The first `package` run needs network access to install `fpm@2.1.4`, the
AppImage toolset, and `7zip@1.0.0`; later runs reuse the cached copies in
`dsh-cache`.

## Shared `node_modules`

The host and the container share one `node_modules` directory through the
bind mount. The `package` service therefore runs `yarn rebuild` before
packaging, to rebuild the native modules (`node-pty`, `koffi`,
`@deepseek-ai/dsh-subprocess-local`, etc.) against the container's glibc; the
result stays forward-compatible with the host's newer glibc, so the host does
not need to reinstall anything afterward. If the host reports
`GLIBC_... not found` after running the container, re-run the host's own
`corepack yarn install` (and `corepack yarn rebuild` if that alone doesn't
restore working native modules) to rebuild for the host's Node ABI again.

## Limitations

- AppImage mounting requires FUSE, which is not available inside the
  container. Only the file's presence and internal layout are checked here;
  actually launching the AppImage must be tested on the host graphical
  session.
- The container must install `rpm` itself — the GitHub-hosted runner's
  preinstalled `rpm` package does not carry over into this container image.
- CI still builds on the host `ubuntu-24.04` runner. This harness exists for
  local development and install-level verification only.
