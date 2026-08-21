# 公司插件目录内置来源（Stage 2）

可选合作内置 key：`company-store`。

- 不是默认 / 不是优先 / 不会在 `dsh-1024store` 失败时兜底
- 免责声明：`公司目录，收录≠安全审核`
- 占位 apex：`https://plugins.company.example`
- 共享工厂：`src/adapters/dsh-1024-style-store.ts`
- 注册：`src/catalog/built-in-providers.ts`

另见 README.zh.md / docs/market-shell.zh.md，以及
https://github.com/hopefullstack-collab/deepseek-harness-desktop/pull/19

## 端点常量

在出现**持久**的公司公开 HTTPS Store 源之前，保持
`COMPANY_STORE_ENDPOINT` / `COMPANY_STORE_HOSTNAME` 为占位值。
**不要**把它钉到短暂的 `*.trycloudflare.com` 快速隧道。
切换步骤与 Actions 启用说明见
[`company-store-endpoint-swap.md`](./company-store-endpoint-swap.md)。

## README / market-shell

`apply-company-store-docs.mjs`（由 `prepare` / `pretest` 调用）会在缺失时把可选
Company Store 说明写入 `README.md`、`docs/market-shell.md`、
`docs/market-shell.zh.md`。段落明确：非默认、非兜底，并展示
`公司目录，收录≠安全审核`。
