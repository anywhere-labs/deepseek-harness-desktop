# Company Store built-in (Stage 2)

Optional partner built-in key: `company-store`.

- Not default / not preferred / not a fallback when `dsh-1024store` fails
- Disclaimer (ZH): `公司目录，收录≠安全审核`
- Placeholder apex: `https://plugins.company.example`
- Shared factory: `src/adapters/dsh-1024-style-store.ts`
- Registration: `src/catalog/built-in-providers.ts`

Chinese mirror: [`company-store-builtin.zh.md`](./company-store-builtin.zh.md).
See also README.md / docs/market-shell.md after local doc sync, and PR https://github.com/hopefullstack-collab/deepseek-harness-desktop/pull/19

## Endpoint constants

Keep `COMPANY_STORE_ENDPOINT` / `COMPANY_STORE_HOSTNAME` on the placeholder until a
**durable** public HTTPS Store origin exists. Do **not** pin them to an ephemeral
`*.trycloudflare.com` quick tunnel. Swap steps, verification curls, and the
Actions-enablement note live in
[`company-store-endpoint-swap.md`](./company-store-endpoint-swap.md) and
[`company-store-ci-note.md`](./company-store-ci-note.md).

## README / market-shell

`apply-company-store-docs.mjs` (run from `prepare` / `pretest`) inserts the optional Company Store partner paragraphs into `README.md`, `docs/market-shell.md`, and `docs/market-shell.zh.md` when missing. The paragraphs state the source is not default, not a fallback, and surfaces `公司目录，收录≠安全审核`.

## Tests

- `tests/company-store-adapter.spec.ts` — origin pin, paging, `q`, installable vs browse-only
- `tests/company-store-host-routes.spec.ts` — add disabled, coexistence select, no auto-fallback
- `tests/company-store-disclaimer.spec.tsx` — banner EN/ZH + only for `company-store`
