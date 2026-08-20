# Agent Note：桌面端聊天输入历史

状态：已实现

[English](2026-08-20-desktop-composer-prompt-history.md) | 中文

## 问题

上游输入框在 `@` 或 `/` 候选菜单不消费按键时，会把 `↑` 与 `↓` 交给原生 textarea 光标移动。DSH Desktop 需要按会话取回已提交的提示词和斜杠命令行，但不能修改固定版本的 DeepSeek Harness checkout，也不能替换完整输入框。

## 决策

Desktop Client 会在兼容与高级两种模式中安装一个 effect。它的 document 冒泡监听在上游 React 键盘处理之后运行，只处理未被 composer 阻止的无修饰方向键；只有光标位于输入框开头时，`↑` 才会开始向旧记录导航。历史导航开始后，`↓` 会向最新记录移动，并在越过最新记录后恢复开始导航前的草稿。

该 effect 会在每次开始导航时，从当前会话已加载的 user、steering 与 command 节点生成历史。只有已被会话记录接受的节点才会进入取回视图，因此乐观清空输入框以及随后被拒绝的提交都不会写入未发送草稿。历史按当前会话分组；连续相同的记录只保存一次。

恢复历史会通过 `ctx.get()` 解析既有的 `sessions` 与 `conversation` service，再调用 conversation input resolver 的标准 `setDraft()` 写入路径。它不会直接赋值 textarea、伪造 input event，或复制上游 `InputBar`。因此输入机仍是草稿权威，恢复斜杠命令也不会重新打开候选菜单。冒泡阶段的方向键监听会尊重标准 composer 的 `preventDefault()` 结果，因此候选菜单的按键归属遵循上游输入机，而不是复制 DOM 启发式判断。

## 验证

桌面端 prompt-history 单测覆盖前后遍历、恢复原草稿、会话隔离、持久节点刷新、去除连续重复记录、排除被拒绝提交、候选菜单与 IME 的按键归属，以及 effect disposal。定向单测已通过。

package typecheck 目前会在 source 检查完成前失败，因为已安装的 `dsh-client-runtime` 声明为 `Context.sessions` 提供了两个不兼容的类型。该功能没有访问此属性，而是使用 service lookup 路径；依赖声明冲突仍在本改动范围之外。

## 结果

桌面用户可在两种呈现模式中取回当前会话已加载且已接受的文本，包括桌面端重启后；官方输入框仍拥有候选菜单方向键、提交准入、草稿状态和全部渲染。会话日志继续作为持久消息记录，桌面能力不会新增另一种存储格式。
