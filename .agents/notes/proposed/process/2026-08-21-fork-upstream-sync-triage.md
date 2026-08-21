# Agent Note: Fork ↔ upstream sync triage

Status: proposed process + one-shot audit

English | [中文](2026-08-21-fork-upstream-sync-triage.zh.md)

- Audit time: `2026-08-21`
- Fork tip audited: `hopefullstack-collab/deepseek-harness-desktop@fd5981c590`
- Upstream tip audited: `anywhere-labs/deepseek-harness-desktop@90909c26d4`
- Merge-base: `7ff6c98bc5`
- Divergence: fork **behind 18** / **ahead 7** (status: diverged)
- Method: dry-run `git cherry-pick` of each upstream commit onto fork `master` (no permanent `upstream` remote; fetched into `refs/remotes/tmp-upstream/master`)

## Problem

This repo is a fork of `anywhere-labs/deepseek-harness-desktop` and also carries product-owned divergence (AI Buddy rebrand, docs, workbench). A GitHub **Sync fork** / blind merge of `anywhere-labs:master` will conflict in shared desktop entry points. Contributors need a repeatable way to pull upstream value without wiping fork identity.

## Decision (ongoing sync policy)

1. **Do not** treat GitHub Sync fork as the default path while the branch is diverged.
2. Prefer **cherry-pick batches** tagged below, in upstream order, on a dedicated branch `cursor/upstream-cherry-YYYYMMDD-*`.
3. Keep product identity changes (brand, landing, docs copy, tray art) on fork-owned commits; never rewrite them by force-syncing upstream.
4. Re-run this triage whenever behind count grows past ~10, or before any large desktop feature land from upstream.
5. Optional local fetch only (no lasting remote if unwanted):

```bash
git fetch https://github.com/anywhere-labs/deepseek-harness-desktop.git master:refs/remotes/tmp-upstream/master
git rev-list --reverse origin/master..tmp-upstream/master --oneline
```

6. When ready for a full catch-up later: merge upstream into a throwaway branch, resolve the **manual** file set below once, then open a PR. Do not merge onto `master` until `yarn check` is green.

## Audit result: what can come in cleanly

Marks from cherry-pick dry-run onto `fd5981c590`.

### `[cherry-ok]` — applies clean alone (or after listed deps)

Bring these first if you want partial sync without fighting brand/entry conflicts.

| Mark | Upstream SHA | Subject | Notes |
|------|--------------|---------|-------|
| cherry-ok | `7247982a9d` | wire profile creation service | touches `main.ts` / package tests; applied clean |
| cherry-ok | `5913496fc3` | notification master switch | isolated |
| cherry-ok | `b0e6b380bb` | private settings API | **new modules only**; UI wiring still needs manual commits |
| cherry-ok | `35035b69f0` | anchor upstream profile modules | |
| cherry-ok | `f03ec4bf6e` | anchor market provider runtimes | apply **after** `35035b69f0` |
| cherry-ok | `3d7fadc0e6` | checkpoint healthy profile configuration | new files |
| cherry-ok | `a8ceec2f39` | materialize restored profiles | new files |
| cherry-ok | `90909c26d4` | restore profile overlay CI (#456) | apply **after** checkpoint + materializer |
| cherry-ok | `a4865e2c03` | align CI profile expectations (#452) | |
| cherry-ok | `18dbe31cf9` | create profiles from the tray | |
| cherry-ok | `8dbb94428e` | localize trajectory zh labels (#451) | includes patch + lock churn |

Suggested pick order for a clean batch:

```text
7247982a9d
5913496fc3
b0e6b380bb
35035b69f0
f03ec4bf6e
3d7fadc0e6
a8ceec2f39
90909c26d4
a4865e2c03
18dbe31cf9
8dbb94428e
```

### `[manual]` — conflicts with fork tip; port by hand

These collide with fork rebrand / workbench edits. Port intent, do not blind-pick.

| Mark | Upstream SHA | Subject | Hot files |
|------|--------------|---------|-----------|
| manual | `8790eaec51` | settings and selectable markets | `src/index.ts`, settings client, `package.json`, `yarn.lock`, `cordis.patch.yml` |
| manual | `bdc6cba820` | align settings actions and market copy | settings UI (needs `8790eaec51` tree) |
| manual | `1d604067a3` | simplify market repository links | settings styles (needs UI tree) |
| manual | `46b7ba1896` | recover external market profile changes | `main.ts`, `profile.ts`, module-resolution, yarn/patch |
| manual | `fc19482f2d` | resolve profile packages by version overlay | `profile.ts`, module-resolution, lockfile |
| manual | `b5b6f8f4aa` | open terminal from plugin boot failures | `src/index.ts` |

### `[skip]` — do not cherry-pick

| Mark | Upstream SHA | Subject | Why |
|------|--------------|---------|-----|
| skip | `df0ab0cae2` | merge: adopt desktop settings and profile overlay | merge commit; use the listed parents instead |

## Conflict hotspots (shared ownership)

These paths changed on **both** sides of the divergence. Expect hand merges whenever upstream touches them again:

- `dsh-plugin-desktop/src/main.ts`
- `dsh-plugin-desktop/src/index.ts`
- `dsh-plugin-desktop/src/client/index.ts`
- `dsh-plugin-desktop/src/profile.ts`
- `dsh-plugin-desktop/src/electron-runtime.ts`
- `dsh-plugin-desktop/src/runtime.ts`
- `dsh-plugin-desktop/src/tray-locale.ts`
- `dsh-plugin-desktop/package.json`
- `dsh-plugin-desktop/cordis.patch.yml`
- `package.json` / `yarn.lock`

Fork-owned surfaces that should stay fork-led (upstream rarely needs to win here): brand assets, README/docs product naming, tray/icon scripts, AI Buddy landing art.

## How to stay partially synced later

| Cadence | Action |
|---------|--------|
| Weekly / when GitHub says behind ≥ 10 | Fetch tmp-upstream; list new commits; classify `cherry-ok` / `manual` / `skip` |
| After each upstream desktop feature land | Cherry-pick `cherry-ok` batch on a branch; open PR; leave `manual` as follow-up issues |
| Before releasing fork builds | Ensure no silent drift in profile/pnpm/settings modules you already adopted |
| Brand / docs work | Keep on separate commits so cherry-picks stay bisectable |

Hard rule: **one concern per sync PR** (for example “profile checkpoint + materializer” or “tray profile create”), never mix a rebrand with an upstream catch-up.

## Out of scope this note

- Actually landing the `cherry-ok` batch on `master`
- Adding a permanent `upstream` git remote
- Syncing the `deepseek-harness` submodule pin (tracked separately in `upstream.json`)

## Verification

Re-validate marks with:

```bash
git fetch https://github.com/anywhere-labs/deepseek-harness-desktop.git master:refs/remotes/tmp-upstream/master
git checkout -B cursor/upstream-cherry-trial origin/master
# for each candidate SHA in order:
git cherry-pick <sha>   # or: git cherry-pick -n <sha> && git reset --hard HEAD
```

Acceptance for any future sync PR: `corepack yarn check` green on the cherry-pick branch.
