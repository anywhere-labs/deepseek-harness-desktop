type Translate = (key: string) => string

export function CompanyStoreDisclaimerBanner({
  builtInProviderKey,
  t,
}: {
  builtInProviderKey: string | undefined
  t: Translate
}) {
  if (builtInProviderKey !== 'company-store') return null
  return (
    <div className="dshMarketBanner" role="status">{t('companyStoreDisclaimer')}</div>
  )
}
