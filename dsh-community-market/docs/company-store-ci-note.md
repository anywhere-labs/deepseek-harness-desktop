# Company Store CI note (desktop fork)

## Current state

- Workflow file: `.github/workflows/ci.yml` — Actions API reports `state: active`
- Workflow runs for this fork: **0** (Actions API `total_count=0`)
- PR #19 checks: Cursor Bugbot / Approval Agent only — **no** `CI` job
- Agent token cannot enable Actions:
  - `PUT .../actions/permissions` → **403** Resource not accessible by integration
  - `POST .../actions/workflows/ci.yml/dispatches` → **403**

Local verification remains the merge gate until Actions run:

```bash
cd dsh-community-market
node ./assemble-default-service.mjs
node ./apply-company-store-wiring.mjs
node ./apply-company-store-docs.mjs
yarn vitest run
```

## Owner steps to enable Actions (required)

1. Sign in as an org/repo admin on
   `hopefullstack-collab/deepseek-harness-desktop`.
2. **Settings → Actions → General**
   - Allow Actions (Enable GitHub Actions / Allow all actions and reusable workflows).
   - Workflow permissions: read contents + read/write if the workflow needs it
     (this repo’s `ci.yml` is typically contents-read).
3. If the org uses **Actions approval for first-time workflows** / forked
   workflows, approve pending workflows for this repository.
4. Open PR #19 → **Checks** → confirm a `CI` run starts (or push an empty commit
   on `cursor/company-store-builtin-cb2c`).
5. Optional: **Actions → CI → Run workflow** on branch
   `cursor/company-store-builtin-cb2c`.

Until a green `CI` run appears on the PR, treat local vitest as the only
automated evidence for Stage 2 code.
