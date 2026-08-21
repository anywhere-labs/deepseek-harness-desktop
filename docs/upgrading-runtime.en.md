# Upgrading the DSH runtime — troubleshooting guide

[中文](upgrading-runtime.md)

This page is for users who **already run DSH Desktop or the local Web client and upgrade the `@deepseek-ai/dsh` runtime themselves** (for example switching to a pre-release like `0.1.1-rc.2`). If you only use the Desktop's built-in updater and have never touched `~/.dsh` manually, you can skip this page.

> Note: this is a community-maintained troubleshooting note, not official documentation. The [`dsh-upgrade-toolkit`](https://github.com/TOBYCAI/dsh-upgrade-toolkit) mentioned here is an independent open-source tool maintained by a community author, with no affiliation or endorsement from this project. It codifies the reliable fixes for the problems below into reusable scripts.

## Why things break

DSH has **two independent version tracks**: the "shared install (runtime)" and the "Desktop shell (App)".

- **runtime** = `@deepseek-ai/dsh` inside `~/.dsh/runtime`. It decides actual harness behavior, the adapter API, and plugin compatibility.
- **shell** = the `DeepSeek Harness.app` (Electron package). On launch it uses `healProfilesModuleFallback` to symlink the `@deepseek-ai/*` packages under `~/.dsh/profiles` to the runtime.

The trap: **a shell update can silently overwrite the runtime**, and **a runtime upgrade (especially rc pre-releases) changes the adapter API**, breaking older plugins or an older shell. Typical symptoms are tracked in community Issues #448 and #457.

## Three common failure modes

### 1. Shell update overwrites / desyncs the runtime

Symptoms: after upgrading the runtime, restarting Desktop shows the old `dsh --version` again; or Desktop and the Web client resolve to different runtimes.

Root cause: the shell's heal mechanism symlinks profile packages to the runtime **bundled inside the shell**, not the shared runtime you pinned.

Fix: make the shared runtime the authority so shell and profile symlinks both resolve to it. See [`pin-runtime.sh`](https://github.com/TOBYCAI/dsh-upgrade-toolkit/blob/main/bin/pin-runtime.sh):

```bash
# Pin the shared runtime as authority (shell/profile symlinks → runtime);
# re-run after any shell update.
bash pin-runtime.sh
```

### 2. After upgrading to an rc version, a plugin throws `prepareCall is not a function`

Symptoms: the Web client fails to start with `registration.adapter.prepareCall is not a function`.

Root cause: `0.1.1-rc.2` introduced a **breaking adapter API change** — every LLM adapter must now implement `prepareCall(provider, model, signal)`. Some third-party plugins (e.g. `@liustack/modlens` <= 3.23.0) have not adapted and crash on load. **This is a general rc risk, not limited to one plugin.**

Temporary fix: patch the plugin with a `prepareCall` implementation and freeze it via `pnpm patch`, then remove it once upstream ships a fix. The patch and full steps are in [`patches/modlens-prepareCall.md`](https://github.com/TOBYCAI/dsh-upgrade-toolkit/blob/main/patches/modlens-prepareCall.md).

> For which plugins/versions break on which DSH version, see the [toolkit's compatibility matrix](https://github.com/TOBYCAI/dsh-upgrade-toolkit#compatibility-matrix-plugin--version-vs-dsh-version).

### 3. Updating a plugin via the plugin manager is blocked by a "safe-delete guard"

Symptoms: running the Web client inside a terminal that has a safe-delete guard (e.g. WorkBuddy) and updating a plugin through plugin-manager fails with:

```
ERROR [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":123,"threshold":50,...}
```

Root cause: the host terminal injects `CODEBUDDY_SAFE_DELETE_*` environment variables. When pnpm cleans up its temp directory at the end of an install (123 files), it exceeds the bulk-delete threshold, and the non-interactive call cannot confirm, so it aborts.

Fix: unload those guard variables before launching the Web client (see the [`web` subcommand of `dsh-manage.sh`](https://github.com/TOBYCAI/dsh-upgrade-toolkit/blob/main/bin/dsh-manage.sh)):

```bash
env -u CODEBUDDY_SAFE_DELETE_BULK_GUARD \
    -u CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR \
    -u CODEBUDDY_SESSION_ID \
    -u CODEBUDDY_TOOL_CALL_ID \
    dsh web
```

## All-in-one tool

[`dsh-upgrade-toolkit`](https://github.com/TOBYCAI/dsh-upgrade-toolkit) bundles the fixes for all three problems into a reusable CLI:

| Command | Purpose |
| --- | --- |
| `pin-runtime.sh` | Pin the runtime as authority; shell updates can't overwrite it |
| `dsh-manage.sh update` | Upgrade runtime (pnpm + registry precheck + re-pin) |
| `dsh-manage.sh shell` | Upgrade the Desktop shell (GitHub Releases + backup + replace) |
| `dsh-manage.sh web` | Launch the Web client with the safe-delete guard unloaded |
| `verify-heal.mjs` | Verify key packages still resolve to the runtime after heal |

> The tool is **complementary, not competitive**: it does not modify Desktop source; it only manages the version relationship between runtime and shell on the user's side. If you only use the Desktop's built-in updater, the manual steps in the first three sections are enough.

## Related links

- Community Issue [#448](https://github.com/anywhere-labs/deepseek-harness-desktop/issues/448) (rc.1 adaptation request)
- Community Issue [#457](https://github.com/anywhere-labs/deepseek-harness-desktop/issues/457) (Desktop/Web version desync)
- [dsh-upgrade-toolkit](https://github.com/TOBYCAI/dsh-upgrade-toolkit)
