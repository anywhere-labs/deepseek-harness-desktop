# Company Store endpoint swap (desktop)

Built-in constants live in `src/adapters/company-store.ts`:

- `COMPANY_STORE_ENDPOINT` — full plugins list URL
- `COMPANY_STORE_HOSTNAME` — host allow-list for the restricted HTTP client

Also wired through `src/catalog/built-in-providers.ts` and
`src/host/company-store-http.ts`.

## Current placeholder (committed)

```text
COMPANY_STORE_ENDPOINT = https://plugins.company.example/api/v1/plugins
COMPANY_STORE_HOSTNAME = plugins.company.example
```

Do **not** change these to a `*.trycloudflare.com` quick-tunnel URL. Those
hostnames are ephemeral (die with the tunnel process) and must not ship in the
built-in.

## When to swap

Swap only after a **durable** public HTTPS origin exists:

1. Company Cloudflare Worker on a real apex (preferred), **or**
2. A stable `https://company-store.<account>.workers.dev` Worker kept as the
   interim Market origin until DNS is ready.

Store-side checklist + secrets-gated deploy (sibling repo):
`hopefullstack-collab/awesome-deepseek-harness-plugins` →
`docs/company-fork-deploy.md` and `.github/workflows/company-fork-deploy.yml`.

## Swap steps

1. Confirm anonymous Market GET against the durable origin:

   ```bash
   curl -sS https://<apex>/api/v1/health
   curl -sS 'https://<apex>/api/v1/plugins?limit=1' | jq 'keys, (.packages|length), .meta'
   ```

2. Edit `src/adapters/company-store.ts`:

   ```ts
   export const COMPANY_STORE_ENDPOINT = 'https://<apex>/api/v1/plugins'
   export const COMPANY_STORE_HOSTNAME = '<apex-host>'
   ```

3. Refresh README / market-shell placeholder mentions (edit templates used by
   `apply-company-store-docs.mjs`, or patch the generated paragraphs).

4. Re-run:

   ```bash
   node ./assemble-default-service.mjs
   node ./apply-company-store-wiring.mjs
   node ./apply-company-store-docs.mjs
   yarn vitest run
   ```

5. Do **not** retarget official `dsh-1024store` constants.

## CI note (this fork)

GitHub Actions lists workflow `CI` as `active`, but the Actions API still shows
**0 workflow runs** and `workflow_dispatch` returns **403** for this integration.
Only Cursor Bugbot / Approval Agent check-suite jobs appear on PR #19. An org/repo
owner must enable or approve Actions for
`hopefullstack-collab/deepseek-harness-desktop` before `ci.yml` can gate the PR —
this cannot be fixed from a write-limited agent token.
