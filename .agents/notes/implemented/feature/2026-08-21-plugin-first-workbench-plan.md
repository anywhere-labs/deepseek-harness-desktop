# Agent Note: Plugin-first workbench optimization plan

Status: implemented

English | [中文](2026-08-21-plugin-first-workbench-plan.zh.md)

## Problem

AI Buddy already ships official-quality defaults: the Code agent preset, worker-pack recommendations, official MCP settings, and a fail-closed community market. Minke v0.2.0 shows a stronger leave-the-desk workbench (Files, Terminal, Command Palette, local models, remote control plane). Copying those features into `dsh-plugin-desktop` would replace official Web slots, preinstall unaudited code, or close the community install path. The product needs a plan that copies Host capabilities as plugins while keeping official defaults optional.

## Decision

Treat the desktop shell as a thin Host and keep copyable product surfaces as plugins.

**Invariants**

- Do not edit `deepseek-harness/` on a desktop feature branch.
- Compatibility mode must not replace official layout, sidebar, or conversation.
- Worker-pack lists are recommendations, not an install allowlist. The market and `dsh plugin add` stay open.
- Do not preinstall community plugins or ship MCP, DingTalk, or WeCom tokens.
- Desktop-owned Host surfaces stay off by default and must compose with community plugins.
- Do not stack two plugins that own the same capability (two DingTalk Stream bots, two sidebars).
- Keep graphical launch explicit. Builds, typechecks, tests, and Loader smokes stay headless-safe.

**Phase 0 — land the current stack**

Merge the stacked product PRs without widening scope: rebrand, docs, logo, worker pack, office-IM starting recommendations. Keep the community-open contract already recorded in the worker pack.

**Phase 1 — workbench through community plugins**

Do not build a first-party Files / Tabs / Diff IDE. The workbench path is the existing recommendations: `dsh-better-sidebar` and `dsh-context`. Optionally document `dsh-web-mobile` as a later, non-default recommendation for narrow screens. Installation stays market or CLI.

**Phase 2 — Command Palette as a plugin**

Add a Command Palette (`Mod+K`) as a desktop-owned optional client plugin or a community client plugin. It occupies `shell.overlay` and calls existing tray, profile, settings, and session commands. It must not replace the official conversation surface.

**Phase 3 — local model discovery as a Host plugin**

Add an opt-in Host plugin that discovers loopback OpenAI-compatible runtimes (Ollama, LM Studio, and similar). It may start a supported runtime that is not already running. It must not take ownership of an already-running service and must not ship tokens.

**Phase 4 — office IM stays community**

Keep DingTalk official Stream (`dsh-dingtalk-channel`) and WeCom official AI Bot (`dsh-wecom`) as starting recommendations. Do not implement first-party IM channels unless those community plugins cannot compose with the pinned DSH family. If a desktop-owned channel is later required, it stays off by default, uses the official platform SDKs, and does not blocklist community Feishu or aggregator plugins. The user chooses one live channel per platform.

**Phase 5 — data-home migration as a Host plugin**

Add an opt-in Host plugin that previews and merges Sessions, plugins, and settings between DSH homes, then switches only after a successful restart. This closes the gap left by the AI Buddy user-data split. Do not silently migrate.

**Phase 6 — remote control plane last**

Only after Phases 2–4, consider a Minke-style control plane: sync sessions, files, and a real host PTY; do not stream the Electron window. The validated private entrance may be Tailscale Serve over HTTPS. DSH stays on loopback. Remote access stays off by default and must not share a milestone with office IM.

**Out of scope**

- Replacing the official Web workbench with desktop-owned Tabs.
- GitHub-authenticated plugin discovery as the default install path.
- A Linux installer or AppImage.
- Mixing an upstream pin bump with a product feature.
- Teaching users to strip macOS quarantine instead of signed releases.

## Verification

Each phase is done only when:

- `corepack yarn typecheck` and the owned unit tests for the touched package pass.
- Compatibility mode still leaves official layout, sidebar, and conversation in place.
- A community plugin that is not on the worker-pack list still installs through the market or `dsh plugin add`.
- New Host surfaces start disabled and ship no secrets.
- Loader smokes remain headless.

## Alternatives considered

**Copy Minke’s overlay into the desktop package.** This would deliver Files, Terminal, and remote access faster, but it replaces official slots and turns AI Buddy into a second closed workbench.

**Implement first-party DingTalk and WeCom Host channels now.** This duplicates community plugins and risks blocking later community IM packages.

**Ship Tailscale / PWA in the same slice as office IM.** Both solve “the user left the desk.” Doing both at once splits the security budget and the product story.

**Preinstall the recommended community plugins.** This violates the market fail-closed contract and the no-silent-install rule.

## Consequences

Desktop remains the official Host for windows, tray, updates, MCP settings, and packaged runtimes. Copied workbench features arrive as plugins the market can replace. Official defaults stay a starting point, so community plugins remain usable after later Host work.

The workbench Host now lives at `dsh-plugin-desktop/workbench`. Compatibility mode still leaves official layout, sidebar, and conversation in place. The Command Palette occupies `shell.overlay`. Local-model discovery, data-home merge, and the remote control plane start disabled and ship no secrets. Office IM stays a community recommendation, not a first-party lock. Remote access syncs sessions, files, and a host shell; it does not stream the Electron window. DSH remains on `127.0.0.1`.
