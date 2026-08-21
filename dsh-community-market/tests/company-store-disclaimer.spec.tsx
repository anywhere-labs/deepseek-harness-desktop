// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CompanyStoreDisclaimerBanner } from '../src/client/CompanyStoreDisclaimerBanner.js'
import { en, zh } from '../src/client/locales.js'

afterEach(() => {
  cleanup()
})

describe('CompanyStoreDisclaimerBanner', () => {
  it('renders the ZH product disclaimer only for company-store', () => {
    const { rerender } = render(
      <CompanyStoreDisclaimerBanner builtInProviderKey="company-store" t={(key) => zh[key]} />,
    )
    expect(screen.getByRole('status').textContent).toBe('公司目录，收录≠安全审核')

    rerender(
      <CompanyStoreDisclaimerBanner builtInProviderKey="dsh-1024store" t={(key) => zh[key]} />,
    )
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('renders the EN notice for company-store', () => {
    render(
      <CompanyStoreDisclaimerBanner builtInProviderKey="company-store" t={(key) => en[key]} />,
    )
    expect(screen.getByRole('status').textContent).toBe(
      'Company-reviewed catalog. Listing ≠ security audit.',
    )
  })
})
