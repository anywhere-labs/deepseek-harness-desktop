# Agent Note: 固定上游源码与隔离的 Yarn 工作区

Status: implemented

[English](2026-08-15-pinned-upstream-and-isolated-yarn-workspace.md) | 中文

## Problem

DSH Desktop 需要保留可供审查的 DeepSeek Harness 官方精确源码，同时让桌面产品独立演进。若把上游源码作为普通文件跟踪，桌面提交就能改写上游实现，代码归属也会变得模糊。共享同一个包管理图还会把上游的 pnpm 规则与桌面产品的 Yarn 发行流程混在一起。

## Decision

[`deepseek-harness/`](../../../../deepseek-harness/) 是 Git 子模块，固定到 [`upstream.json`](../../../../upstream.json) 记录的官方仓库和精确提交。桌面分支把该子模块视为只读内容。更新上游时，在独立提交中同时修改 gitlink 与元数据。

外层 README 文件和资源由产品仓库拥有，并保留 `anywhere-labs/deepseek-harness-desktop` 已有的 DSH Desktop 落地页；这些内容不从官方源码子模块派生。Desktop package 的初始化与发行文档属于 [`dsh-plugin-desktop/README.md`](../../../../dsh-plugin-desktop/README.md)；规划中的社区互操作 contract 属于 [`dsh-community-fabric/README.zh.md`](../../../../dsh-community-fabric/README.zh.md)；规划中的社区市场产品与信任边界属于 [`dsh-community-market/README.zh.md`](../../../../dsh-community-market/README.zh.md)。

外层仓库是使用 `node_modules` linker 的 Yarn 4 工作区。自有 workspace 成员是 [`dsh-plugin-desktop`](../../../../dsh-plugin-desktop/)、[`dsh-community-fabric`](../../../../dsh-community-fabric/) 和 [`dsh-community-market`](../../../../dsh-community-market/)。Fabric 从私有文档初始化工程开始：在社区 Draft 拥有经过评审的 contract 与一致性证据前，不提供 runtime 入口、SDK、正式 schema 或 DSH bundle。Market 同样从私有文档初始化工程开始：在市场壳具备实现和 Loader 证据前，不提供运行入口或 DSH bundle。上游 checkout 按照自己的[包管理器决策](../../../../deepseek-harness/.agents/notes/implemented/process/2026-06-16-pnpm-over-yarn.zh.md)保持为独立的 pnpm 工作区。根目录的 `upstream:*` 脚本通过 Yarn portable shell 进入子模块，再由 Corepack 调用上游固定的 pnpm 版本。

普通桌面构建从 npm registry 解析已发布的 DSH 包，不从子模块链接源码。`upstream.json` 分别记录源码版本和运行时包 family。固定的 GitHub 公开源码和桌面运行时现在都使用已发布的 `0.1.0-rc.8` family；当 npm artifact 没有发布对应源码提交时，仓库不会虚构两者的对应关系。

`yarn check:layout` 会拒绝变化的子模块 URL、提交、工作树、包管理边界、自有 workspace 成员列表或 DSH 运行时 family。根检查会先运行轻量的 Fabric 和 Market 文档门禁，再运行完整 Desktop 门禁。CI 会初始化子模块，以 immutable 模式安装外层工作区，运行自有 package 检查，并在 Windows 上执行上游命令路径。

## Verification

验收要求 `yarn check:layout`、`yarn upstream:version`、`yarn install --immutable` 和 `yarn check` 全部通过。Fabric 与 Market 门禁会检查各自的私有 manifest、双语 hash 和文档链接。Desktop 门禁中的 Loader smoke 会通过 Cordis 激活构建后的桌面包，但不会打开 Electron 窗口；两个社区 package 在文档阶段都刻意没有 Loader 入口。

## Alternatives considered

**继续在根目录携带可编辑的上游文件。** 这种方式只需要一个 checkout，但无法机械地区分官方源码和桌面自有修改，无法解决本结构要消除的归属问题。

**通过 subtree 或复制快照 vendoring 上游源码。** 副本可以记录来源，但上游文件仍表现为产品自有的普通文件，意外提交补丁仍然很容易。

**把上游 checkout 加入 Yarn workspace 或使用源码链接。** 这会让桌面依赖解析耦合到未修改的 pnpm monorepo，并让产品构建依赖未发布的源码布局，而不是用户实际安装的包。

**把上游 checkout 转换为 Yarn。** 包管理器转换会修改官方源码，并使其 lockfile 和仓库检查失效。因此，上游命令继续使用 pnpm。

**把 npm 运行时版本视为对应源码修订的证明。** 已发布包的元数据没有标识这样的修订。分别记录源码和 artifact 版本可以避免错误的来源声明。

## Consequences

桌面改动有三个边界明确的自有 package tree，官方 checkout 可以与其远端提交直接比较。外层落地页展示 DSH Desktop，Desktop README 负责应用初始化与发行说明，Fabric README 负责规划中的社区 contract 边界，Market README 负责规划中的市场边界。产品安装与检查可由外层 Yarn lockfile 复现，上游验证则继续使用自己的 pnpm lockfile。

克隆时必须初始化子模块，贡献者也需要维护两套有意隔离的包管理器缓存。GitHub 公开修订与 npm 发布 family 可能不对应，因此源码 pin 更新和运行时 family 更新需要分别提供验证证据。
