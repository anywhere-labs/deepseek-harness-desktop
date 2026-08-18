# Agent Note：基于上游附件链路的桌面端图片选择器

状态：已实现

[English](2026-08-16-desktop-image-picker.md) | 中文

## 问题

已发布的 conversation client 支持粘贴图片和全窗口拖放，但界面上的加号按钮用于打开命令，而且没有点击选择图片的控件。桌面端用户因此无法从输入区发现已经启用的附件能力。

## 决策

Desktop Client 在兼容模式与高级模式中都通过官方 `conversation.input.left` 列表 slot 添加回形针控件。隐藏的浏览器文件输入支持多选与重复选择同一文件，并接受 PNG、JPEG、WebP 与 GIF 图片。

该 contribution 把浏览器草稿注册、对象 URL 所有权、输入状态 id、预览栏、移除、上传序列化、Host 校验、持久化存储、prompt admission 与历史展示委托给现有 `@deepseek-ai/dsh-client-ui-conversation` controller。Desktop 会在创建预览前按照 Host 投影的数量与字节限制校验选择结果；如果输入状态机拒绝新建草稿的 id，则立即释放这些草稿。

该控件不宣称支持通用文件。rc.6 的持久附件 API 与消息内容模型只接受栅格图片。文档附件需要完整的上游附件能力，不能把文件路径或文档字节编码进 prompt 文本来替代。

## 结果

两种 Desktop 呈现模式都会获得同一个可发现的图片操作，同时无需替换上游 composer，也无需修改固定版本的源码子模块。粘贴和拖放继续使用原有链路；已发送消息继续保存现有的持久图片引用，并通过带会话授权的历史读取接口展示。

当前实现使用已发布 conversation controller 的具体类型，因为其公开 service interface 尚未暴露草稿图片创建操作。上游以后提供按 session 定址的 intake 操作时，可以替换这一小段 adapter，而无需修改选择器组件。

## 验证

Desktop client typecheck 覆盖 slot 与 controller 集成。针对性测试覆盖允许的图片格式，以及 Host 投影的数量、单图字节数和总字节数限制。Package build 与 Loader smoke 验证发布后的 client bundle 和 profile 组合。
