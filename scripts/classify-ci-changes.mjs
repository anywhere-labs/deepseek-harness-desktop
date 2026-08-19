import { readFileSync } from 'node:fs'

const changedPaths = readFileSync(0)
  .toString('utf8')
  .split('\0')
  .filter(Boolean)

const productCriticalDocument = /(?:^|\/)(?:LICENSE(?:\.[^/]*)?|THIRD_PARTY_NOTICES\.md)$/u
const documentationPath = /^(?:docs\/|\.agents\/notes\/|\.github\/(?:ISSUE_TEMPLATE\/|PULL_REQUEST_TEMPLATE))/u
const nestedDocumentationPath = /\/docs\//u
const documentationFile = /(?:\.mdx?|\.i18n\.ya?ml)$/u

const productChanged = changedPaths.length === 0 || changedPaths.some((path) => {
  if (productCriticalDocument.test(path)) return true
  return !documentationPath.test(path)
    && !nestedDocumentationPath.test(path)
    && !documentationFile.test(path)
})

process.stdout.write(productChanged ? 'true\n' : 'false\n')
