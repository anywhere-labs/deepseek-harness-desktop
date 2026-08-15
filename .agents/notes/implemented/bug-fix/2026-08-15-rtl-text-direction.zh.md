# Agent Note: 用主导脚本判定 RTL 消息的文本方向

Status: implemented

[English](2026-08-15-rtl-text-direction.md) | 中文

## Problem

Web 客户端没有为任何元素设置 `dir` 属性，因此消息的基准方向回落到浏览器默认的 LTR。对于以拉丁单词开头、主体却是阿拉伯语的混合脚本文本（例如 `Hello كيف حالك اليوم`），浏览器的 `dir="auto"` first-strong 规则（UAX #9 P2/P3）同样会判定为 LTR，从而打乱阿拉伯语的词序，使句子无法阅读。该缺陷即 issue #20。

## Decision

`packages/client/ui-primitives/src/markdown/text-direction.ts` 中的 `textDirection(text)` 通过统计强 RTL 与强 LTR 脚本码点、取多数的一方来判定一段文本的基准方向。它有意区别于浏览器的 first-strong 启发式：以拉丁单词开头、后接阿拉伯语的句子仍判定为 RTL，而偶尔夹带阿拉伯语词元的拉丁语句子仍判定为 LTR。纯中性字符和空输入回落为 LTR。

判定结果作为显式 `dir` 属性应用：

- `MessageText`（用户与 steering 的字面文本）应用于其容器。
- `MarkdownText` 应用于其容器，并在 `render.tsx` 中按块应用于 `paragraph` 与 `heading` 节点，使单条回复可以混合 RTL 正文与 LTR 代码块、表格。
- `InputBar` 的草稿输入区，以及 `QuestionComposer` 的提问标题和自定义答案输入框。

## Alternatives considered

- **依赖浏览器的 `dir="auto"`。** first-strong 会把报告中的典型场景——拉丁单词开头后接阿拉伯语——误判为 LTR，而报告本身正把它指认为根因。
- **只在 markdown 容器上设置方向。** 对单段落回复正确，但对混合回复错误：RTL 容器会把代码块和表格一并拖入 RTL 基准方向，也无法让一段 RTL、另一段 LTR。
- **实现完整的 Unicode bidi 算法。** 精确复刻 UAX #9 P2/P3 只会重新引入那个有问题的 first-strong 启发式；主导脚本计数是更小、可测试、且直指所报故障的启发式。

## Consequences

RTL 占优的消息在消息、段落与输入三个层面都按从右到左渲染。RTL 回复中的代码块与表格仍保持自然的 LTR 基准，因为其强拉丁内容在 bidi 算法下依旧按 LTR 渲染，而混合回复由按块的 `dir` 覆盖容器方向。流式消息在文本增长过程中方向发生翻转时可能中途重排；这是内容派生方向所固有的，消息完成后即稳定。枚举的 RTL 与 LTR 集合之外的脚本（阿拉伯、希伯来、叙利亚、塔纳、恩科之于拉丁、希腊、西里尔、亚美尼亚）为中性，不参与投票。

## Testing

`markdown.client.spec.tsx` 中的 `text-direction` 单元测试覆盖拉丁单词开头后接阿拉伯语的 RTL 占优文本、LTR 占优文本、夹带阿拉伯词元的拉丁语句、纯中性与空输入，以及平局。`markdown-render-units.client.spec.tsx` 钉住按段与标题的 `dir`，以及 `inlineText` 对强调、链接、行内代码、图片 alt（含缺失 alt）的抽取。`input-bar.client.spec.tsx` 与 `user-questions-composer.client.spec.tsx` 钉住输入框与提问器两个界面。
