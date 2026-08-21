# Agent Note: Fork ↔ upstream 同步分拣

Status: proposed process + one-shot audit

[English](2026-08-21-fork-upstream-sync-triage.md) | 中文

- 审计时间：`2026-08-21`
- Fork tip：`hopefullstack-collab/deepseek-harness-desktop@fd5981c590`
- Upstream tip：`anywhere-labs/deepseek-harness-desktop@90909c26d4`
- Merge-base：`7ff6c98bc5`
- 分叉：落后 **18** / 超前 **7**（diverged）
- 方法：在 fork `master` 上对 upstream 逐条 `git cherry-pick` 干跑（不永久加 `upstream` remote；临时 fetch 到 `refs/remotes/tmp-upstream/master`）

## 问题

本仓是 `anywhere-labs/deepseek-harness-desktop` 的 fork，同时又有产品侧分叉（AI Buddy 改名、文档、workbench）。GitHub **Sync fork** / 盲合并会在共享入口文件上冲突。需要可重复的方式，只拉有用的 upstream，不冲掉 fork 身份。

## 决策（长期同步策略）

1. 已 diverged 时，**不要**默认 Sync fork。
2. 优先按下方标记做 **cherry-pick 批次**，分支名 `cursor/upstream-cherry-YYYYMMDD-*`。
3. 品牌 / 落地页 / 文档文案 / 托盘图标等产品身份改动留在 fork 自有提交；禁止用强制 sync 覆盖。
4. 落后超过约 10 个 commit，或 upstream 有大块桌面功能落地前，重跑本分拣。
5. 可选临时 fetch（可不加长期 remote）：

```bash
git fetch https://github.com/anywhere-labs/deepseek-harness-desktop.git master:refs/remotes/tmp-upstream/master
git rev-list --reverse origin/master..tmp-upstream/master --oneline
```

6. 以后要整支追平：先在丢弃分支上 merge upstream，只手工解决下方 **manual** 文件集，再开 PR；`yarn check` 绿了再合 `master`。

## 审计结果：哪些能合进来

标记来自对 `fd5981c590` 的 cherry-pick 干跑。

### `[cherry-ok]` — 可干净合入（或按依赖顺序）

想部分同步、又不想碰品牌/入口冲突时，先合这批。

| 标记 | Upstream SHA | 说明 | 备注 |
|------|--------------|------|------|
| cherry-ok | `7247982a9d` | wire profile creation service | 动到 `main.ts` / package tests，仍能干净合 |
| cherry-ok | `5913496fc3` | notification master switch | 独立 |
| cherry-ok | `b0e6b380bb` | private settings API | **仅新模块**；UI 接线仍在 manual |
| cherry-ok | `35035b69f0` | anchor upstream profile modules | |
| cherry-ok | `f03ec4bf6e` | anchor market provider runtimes | **必须在** `35035b69f0` 之后 |
| cherry-ok | `3d7fadc0e6` | checkpoint healthy profile configuration | 新文件 |
| cherry-ok | `a8ceec2f39` | materialize restored profiles | 新文件 |
| cherry-ok | `90909c26d4` | restore profile overlay CI (#456) | **必须在** checkpoint + materializer 之后 |
| cherry-ok | `a4865e2c03` | align CI profile expectations (#452) | |
| cherry-ok | `18dbe31cf9` | create profiles from the tray | |
| cherry-ok | `8dbb94428e` | localize trajectory zh labels (#451) | 含 patch + lock |

建议干净批次顺序：

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

### `[manual]` — 与 fork tip 冲突；要手改移植

和 fork 改名 / workbench 改动撞车。移植意图，不要盲 pick。

| 标记 | Upstream SHA | 说明 | 热点文件 |
|------|--------------|------|----------|
| manual | `8790eaec51` | settings and selectable markets | `src/index.ts`、settings client、`package.json`、`yarn.lock`、`cordis.patch.yml` |
| manual | `bdc6cba820` | align settings actions and market copy | settings UI（依赖 `8790eaec51`） |
| manual | `1d604067a3` | simplify market repository links | settings styles |
| manual | `46b7ba1896` | recover external market profile changes | `main.ts`、`profile.ts`、module-resolution、yarn/patch |
| manual | `fc19482f2d` | resolve profile packages by version overlay | `profile.ts`、module-resolution、lockfile |
| manual | `b5b6f8f4aa` | open terminal from plugin boot failures | `src/index.ts` |

### `[skip]` — 不要 cherry-pick

| 标记 | Upstream SHA | 说明 | 原因 |
|------|--------------|------|------|
| skip | `df0ab0cae2` | merge: adopt desktop settings and profile overlay | merge commit；用上面列出的父提交 |

## 冲突热点（双方都改过）

以后 upstream 再动这些路径，几乎一定要手合：

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

应继续由 fork 主导：品牌资源、README/文档产品名、托盘/图标脚本、AI Buddy 落地页图。

## 以后怎么保持「部分同步」

| 节奏 | 动作 |
|------|------|
| 每周 / GitHub 显示落后 ≥ 10 | 临时 fetch；列新 commit；标 `cherry-ok` / `manual` / `skip` |
| upstream 桌面功能落地后 | 开分支 cherry-pick `cherry-ok` 批次并 PR；`manual` 另开 follow-up |
| fork 发版前 | 确认已采纳的 profile/pnpm/settings 模块没有静默漂移 |
| 品牌 / 文档 | 单独提交，方便 cherry-pick 可 bisect |

硬规则：一次同步 PR 只做一件事（例如「profile checkpoint + materializer」），不要和改名混在一起。

## 本 note 未做

- 没有把 `cherry-ok` 批次合进 `master`
- 没有添加永久 `upstream` remote
- 没有动 `deepseek-harness` submodule 引脚（见 `upstream.json`）

## 验证

```bash
git fetch https://github.com/anywhere-labs/deepseek-harness-desktop.git master:refs/remotes/tmp-upstream/master
git checkout -B cursor/upstream-cherry-trial origin/master
# 按候选 SHA 顺序：
git cherry-pick <sha>
```

任何同步 PR 的验收：`corepack yarn check` 通过。
