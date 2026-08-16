# Agent Note：Desktop 模型图片能力开关

状态：已实现

[English](2026-08-16-desktop-model-image-capability.md)

## 问题

Desktop runtime 使用已发布的 `@deepseek-ai/dsh-client-ui-settings-models` bundle。手动声明的第三方模型默认接受文本，但已发布的模型编辑器没有暴露现有的 `input` 模态声明。否则，用户必须编辑 `settings.yaml`，才能启用实际接受图片的提供方模型。

## 决策

Desktop 对固定的 rc.6 模型设置 bundle 应用 Yarn patch。每个模型行展开的能力区域增加“图片输入”复选框。启用时控件写入 `input: [text, image]`，停用时写入 `input: [text]`。默认值仍然是纯文本，Host 现有的图片 admission 检查继续作为权威校验。

补丁只作用于 Desktop 消费的已发布 Client bundle，不修改固定的 upstream submodule，也不引入第二个 settings service。resolution 固定版本，因此上游 package 发生变化时必须显式刷新补丁。

## 结果

Desktop 用户可以直接在应用内配置第三方视觉模型。Desktop 图片选择器与模型能力开关相互独立：选择器提供图片内容，模型设置声明选中的路由是否可以接收图片。

该声明仍然是用户对端点的明确断言。如果端点拒绝图片，提供方仍可能返回错误，用户需要关闭该能力。

## 验证

Package surface 测试断言 patch resolution 和图片能力 mutation。图片选择器与 package 测试通过，Desktop package 在应用补丁后构建成功。
