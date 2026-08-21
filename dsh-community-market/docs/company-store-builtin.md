# Company Store built-in (Stage 2)

Optional partner built-in key: `company-store`.

- Not default / not preferred / not a fallback when `dsh-1024store` fails
- Disclaimer (ZH): `公司目录，收录≠安全审核`
- Placeholder apex: `https://plugins.company.example`
- Shared factory: `src/adapters/dsh-1024-style-store.ts`
- Registration: `src/catalog/built-in-providers.ts`

See also README.md / docs/market-shell.md after local doc sync, and PR https://github.com/hopefullstack-collab/deepseek-harness-desktop/pull/19

## README / market-shell

`apply-company-store-docs.mjs` (run from `prepare` / `pretest`) inserts the optional Company Store partner paragraphs into `README.md`, `docs/market-shell.md`, and `docs/market-shell.zh.md` when missing. The paragraphs state the source is not default, not a fallback, and surfaces `公司目录，收录≠安全审核`.
