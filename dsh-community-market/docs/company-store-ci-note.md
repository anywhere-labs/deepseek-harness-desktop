# Company-store CI note

Local verification (cloud agent):

```bash
cd dsh-community-market
node ./assemble-default-service.mjs
node ./apply-company-store-wiring.mjs
node ./apply-company-store-docs.mjs
yarn vitest run
# → 22 files / 283 tests passed
```

GitHub Actions on this fork currently shows **0 workflow runs** for
`cursor/company-store-builtin-cb2c` even though `.github/workflows/ci.yml` is
`active`. A repository owner must enable/approve Actions so the product CI gate
can run. Until then, treat local vitest + Store listening smoke as the evidence
trail.

Related Store PR: https://github.com/hopefullstack-collab/awesome-deepseek-harness-plugins/pull/1
