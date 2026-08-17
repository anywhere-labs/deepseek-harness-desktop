# 参与贡献

感谢你愿意参与 DSH Desktop。这是一个社区项目，无论你是普通用户、插件作者还是开发者，都有适合你的贡献方式。

## 普通用户：使用、反馈与传播

- 遇到问题或异常，[提 issue](https://github.com/anywhere-labs/deepseek-harness-desktop/issues)：说明操作系统（macOS / Windows）、应用版本和复现步骤。
- 有功能想法或改进建议，也欢迎提 issue 讨论。
- 参与[社区交流](README.md#社区交流)（微信群、QQ 群、Discord），帮助其他用户解决问题。
- 写使用教程、体验文章，或帮助完善和翻译文档。
- 在[友情链接](README.md#友情链接)中收录生态项目。

## 插件作者：扩展生态

DSH 的核心是插件。如果你写插件，请先阅读：

- [插件开发](docs/plugin-development.md)：如何编写普通 DSH 插件和 Desktop 插件。
- [DSH 插件生态倡议书](docs/plugin-ecosystem.md)：开放、可组合、可持续的生态愿景，以及组合优先、声明清晰、兼容优先三条原则。
- [DSH Community Fabric Draft](dsh-community-fabric/README.zh.md)：参与 Manifest、Capability、Host Descriptor 和事件 contract 的公开讨论。
- [Community Market 设计](dsh-community-market/docs/market-shell.zh.md)：未来市场如何发现插件，以及为什么收录不等于安全审核。

遵循倡议书的插件更容易与其他插件共存，也会在未来上线时更容易在插件市场中被发现和信任。

## 开发者：贡献代码

### 开发环境

```sh
git submodule update --init --recursive
corepack yarn install --immutable
corepack yarn check   # 完整 headless gate：构建、类型检查、测试与冒烟
corepack yarn dev     # 有图形环境时启动应用
```

### 仓库边界（开始前务必了解）

- `deepseek-harness/` 是固定版本的上游子模块，**桌面开发不修改其中的任何文件**；上游内容更新走独立的 pin 提交。
- 桌面代码位于 `dsh-plugin-desktop/`；`dsh-community-fabric/` 保存社区标准 Draft，`dsh-community-market/` 保存市场壳设计。两个社区 package 当前都只有文档、尚不可加载，三个自有 package 共用外层 Yarn workspace。
- 构建、类型检查、单元测试和冒烟检查必须保持 headless-safe。

### 提交与 PR

- 提交信息使用 conventional commits 风格（例如 `fix(desktop): ...`、`docs: ...`）。
- 提交前运行 `yarn check` 并保证全绿。
- 变更生产依赖后，运行 `yarn workspace dsh-plugin-desktop verify:notices` 刷新第三方许可清单，并提交更新后的 `dsh-plugin-desktop/THIRD_PARTY_NOTICES.md`。
- 文档改动请中英同步，并更新 `README.i18n.yaml` 的双语 hash 记录。
- PR 描述说明改动内容、动机和验证方式；CI 通过后再合并。

## 加入技术团队

如果你希望加入我们的技术团队，欢迎通过 [t4wefan@qq.com](mailto:t4wefan@qq.com) 联系我们。

## 行为准则

请保持友善与尊重，就事论事。我们希望这是一个欢迎新人的社区。完整的[参与者公约](CODE_OF_CONDUCT.md)适用于所有项目空间。
