# GitHub Copilot 支持进度

## 目标

在 DSH Desktop 的 Models 设置中提供 GitHub Copilot OAuth 登录，采用与 Zed 类似的 GitHub 设备码授权体验，并复用项目已有的 pi-ai / DSH 授权流程；授权后的 Copilot 模型应能进入现有模型选择器。Ubuntu/Linux 上点击窗口 `X` 应优雅退出，而非只最小化。完成后构建 Ubuntu/Linux 可用发行包。

## 进度

- [x] 调研依赖与授权能力：`@deepseek-ai/dsh-llm-pi-ai` 已注册 `github-copilot` 授权 flow，底层 pi-ai 负责 GitHub 设备码登录、授权令牌刷新、模型适配与凭据保存。
- [x] 确认缺口：Desktop Models UI 无授权入口，现成 Remote 未导出通用 authorization API；采用 Desktop 私有、同源校验的 Host API 桥接 DSH `ctx.authorization`，不改上游 submodule、不重写 OAuth。
- [x] Beta：完成固定 Copilot OAuth 授权 API、模型卡片设备码登录交互和交互测试；Beta typecheck 与新增测试通过。
- [x] 同步共享变更到 Stable，并保留 `product-identity.ts` 通道差异；变体检查通过，207 个共享源码文件对齐。
- [x] 验证：Stable/Beta typecheck、package build 和桌面变体检查通过；Linux close/runtime 与 platform 定向测试 Stable 122/122、Beta 117/117 通过（此前 Copilot 定向测试 Stable 98、Beta 8 项通过）。历史全量测试中 Beta 有一个 macOS entitlement fixture 缺失、Stable 有同一项及一个无关的 Windows NSIS A/B 模板断言失败；随后已初始化 pinned submodule，本次未重跑全量测试。
- [x] 构建 Ubuntu/Linux x64 AppImage 与 Debian `.deb`：`market:check` 和 5 项市场发布策略测试已通过，Stable/Beta/Next 均为 `dshmarket@1.66.8`；根 `dist:linux` 成功生成两种 Linux x64 包，并由内置 verifier 验证通过。
- [x] 核对 Linux x64 包格式、Debian 元数据、SHA-256 和内置发行校验结果。
- [x] Linux 点窗口 `X` 时请求 Desktop shutdown coordinator 优雅退出；Stable/Beta 回归测试覆盖此行为。
- [x] 更新最终结果；根进度与模块文档/归档文档同步。

## 当前进展

- 2026-10-02：确认 `ctx.authorization.begin()` 可通过会话回调承载 OAuth 通知/提示；凭据状态通过 `ctx.credentials.describeRecord()` 读取，仅向 UI 返回布尔配置状态。
- 2026-10-02：确认 Host 私有路由已有同源 loopback 校验，Copilot 接入将复用该校验并只允许固定 `llm-pi-ai/github-copilot` key 和固定 `oauth` 方法。
- 2026-10-02：Host 已新增固定 Copilot flow 的同源 API（状态、开始、prompt 回答、取消），并桥接已存在的授权/凭据服务；API 不返回 token，设备通知只接受 HTTPS URL。
- 2026-10-02：Models `llm-pi-ai/github-copilot` 卡片已接入设备码、提示回答、取消、连接状态轮询及中英文文案。
- 2026-10-02：Beta typecheck 通过；Copilot 授权路由与 UI 测试共 7 项通过。首次复测暴露的是 mock 凭据状态/取消状态与预期不一致，已修正测试场景，未改变运行时代码。
- 2026-10-02：Copilot Host/Client 源码与两项测试已同步到 Stable；`corepack yarn check:desktop-variants` 通过，207 个共享源码文件对齐；Stable 与 Beta typecheck 均通过。
- 2026-10-02：Stable 与 Beta package build 均通过；两个通道各自的 Copilot route、provider card、Host route fence 和 Client slot 定向测试共 60 项均通过。
- 2026-10-02：Stable/Beta 全量测试分别为 1,739/1,711 项通过、11/9 项跳过。两通道都因未初始化的 `deepseek-harness` pinned submodule 缺少 `apps/desktop/scripts/macos-entitlements.plist` 导致一项 macOS-only 测试失败；Stable 另有一项 Windows NSIS A/B 测试断言与当前模板不匹配。Copilot 接入相关新增与调整的路由、UI、Host fence、Client slot 测试均通过。
- 2026-10-02：根据仓库前置条件初始化 `deepseek-harness` recursive submodule，检出仓库 pin `639ed015397290b3745d163aafe02ffee4aa3f84`，没有更改子模块内容。
- 2026-10-02：首次根 `dist:linux` 按规则运行 `market:prepare`，发现 npm 最新 `dshmarket@1.66.8` 与现有 `.yarn/patches/dshmarket-desktop.patch` 的 hunk 2 不兼容；市场准备脚本已回滚本次版本/锁文件更新，未继续打包。
- 2026-10-02：将 Desktop patch 重基到 `dshmarket@1.66.8`：Host 的 `catalogNpmByRepo` 保留为第 6 参数，Desktop 的宿主提供版本为第 7 参数；更新缓存键与虚拟安装版本投影。路由检查保留市场 catalog，trial validation 同时传入 `hostAnchorOption`，并保留对既有错误基线的差异检查。
- 2026-10-02：新 patch 已通过 1.66.8 pristine tarball 的 `patch --dry-run -p1` 全量应用校验；`lib/routes.js` 和 `lib/updates.js` 也通过 `node --check`。
- 2026-10-02：`corepack yarn market:prepare` 成功，Stable、Beta、Next 全部解析至 `dshmarket@1.66.8`；Yarn 重新生成对应 patch locator/lockfile，市场准备脚本报告最新版本一致。此前显示的 peer dependency warnings 是项目已有 workspace peer 提示。
- 2026-10-02：`corepack yarn market:check` freshness 检查通过；`corepack yarn test:market-release` 5/5 通过，涵盖 Stable/Beta/Next 更新与 tag、只读检查、失败恢复、offline fail-closed 及入口强制准备。
- 2026-10-02：开始运行根 `corepack yarn dist:linux`，目标为 Linux x64 AppImage 与 Debian `.deb`。
- 2026-10-02：`corepack yarn dist:linux` 成功，期间更新 Agents Anywhere release artifact 至 `main` commit `7df5b31f3fe23d4be92ccd5ae5e0aeb6a3744c0e`、构建市场和 Stable 桌面包，产物为 `dsh-plugin-desktop/dist/DSH-Desktop-2.0.17-x86_64.AppImage` 与 `dsh-plugin-desktop/dist/DSH-Desktop-2.0.17-amd64.deb`；内置 `Linux artifact verification passed`。
- 2026-10-02：最终产物格式检查通过：AppImage 为 x86-64 ELF，可执行，约 306 MB；`.deb` 为 Debian 2.0 amd64 package，版本 `2.0.17`，约 230 MB。最终 SHA-256：AppImage `20e348440fa47a44253fa67a807f4a59ce2e83158dd91a9e9a2d6c85198751c7`；`.deb` `ea00f090bb8a2c4363e9d6fcf60dac994fa02c92bd26031459a7a6af0b6e0abe`。
- 2026-10-02：构建后确认 `corepack yarn check:desktop-variants` 通过（207 个共享源码文件对齐）；Stable/Beta typecheck 通过；Copilot 授权路由、模型卡片、插件路由与相关 Client 测试 Stable 97/97、Beta 95/95 通过；`corepack yarn aa:check` 通过，全部 Desktop channels 锁定至上游 commit `7df5b31f3fe23d4be92ccd5ae5e0aeb6a3744c0e`。
- 2026-10-02：全量测试之前报告过少量非 Copilot 测试失败（初始化 submodule 前的 macOS entitlement fixture 缺失；Stable 另有 Windows NSIS A/B 模板断言不匹配）。submodule 后续已初始化；本次未重跑全量 suite。未启动 GUI，登录仍需用户在图形环境中实际操作验证。
- 2026-10-02：用户指出登录界面仍暴露 `GitHub Enterprise URL/domain`。核实这是 pi-ai 面向 Enterprise 的可选提示，但 Desktop 原样呈现且 UI 将空值设为必填，导致我此前建议“留空”实际上无法继续。现已在 Beta 中默认对该可选提示提交空值（走 github.com），同步至 Stable；新增回归测试确保授权流程直接进入 GitHub 设备码步骤，不再显示企业域输入框。两通道 typecheck、变体检查和 build 通过；最新定向测试 Stable 98 项、Beta 8 项通过。开始重新构建 Linux 发行包，使产物包含该 UX 修复。
- 2026-10-02：开发环境通过 Node 24.21.0 调起 Corepack Yarn 4.18.0，构建命令可运行。
- 2026-10-02：用户反馈 Ubuntu 上点击 `X` 后 DSH 进程仍在。定位为 Linux 原先把关闭事件映射到最小化；现改为拦截该事件并调用 `spec.requestQuit(0)`，复用 shutdown coordinator 完整释放 Host/窗口后退出。Windows/macOS 行为未改。
- 2026-10-02：close 行为定向回归测试通过：Stable 122/122、Beta 117/117；Stable/Beta typecheck、Beta package build 和 207 个共享源码变体检查均通过。
- 2026-10-02：用户要求后续打包前先结束正在运行的桌面实例；Stable DSH 主进程、旧 AppImage 残留 helper 及对应 Crashpad 已发送 `SIGTERM` 并确认退出。随后重新运行根 `yarn dist:linux` 成功，内置 Linux artifact verifier 通过；本次没有启动 GUI。

## 方案和安全边界

- 登录目标固定为凭据键 `llm-pi-ai/github-copilot`，不允许客户端指定任意 provider 或 credential key。
- Host API 只暴露授权 flow 的方法/状态/设备码提示，不暴露凭据内容；写入仍由既有 pi-ai flow 完成。
- POST 仅允许 loopback、精确同源和 JSON 请求；支持取消、`text`/`secret`/`select` 提示、设备码/验证 URL 通知。
- 模型目录与请求处理沿用已安装的 pi-ai Copilot provider；确认授权后的运行时目录行为并在验证中覆盖。
