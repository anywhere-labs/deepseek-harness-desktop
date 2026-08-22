/** Model metadata needed by the desktop selector without coupling to one provider. */
export interface VisionCatalogModel {
  id: string
  name: string
  inputModalities?: readonly string[]
}

export type ModelCapabilityBadge = 'vision' | 'experimental'

/** Derive display badges from advertised capabilities and release-stage naming. */
export function modelCapabilityBadges(model: VisionCatalogModel): ModelCapabilityBadge[] {
  const badges: ModelCapabilityBadge[] = []
  if (model.inputModalities?.includes('image') === true) badges.push('vision')
  const releaseName = `${model.id} ${model.name}`
  if (/(?:^|[-_\s])(?:exp|experimental)(?:$|[-_\s])/i.test(releaseName)) badges.push('experimental')
  return badges
}

export type AttachmentDeliveryState = 'pending' | 'preparing' | 'sending' | 'failed'
export type AttachmentInputPhase = 'plain' | 'adjudicating' | 'claimed' | 'submitting'

/** Map the existing input transaction to one user-facing attachment state. */
export function attachmentDeliveryState(
  phase: AttachmentInputPhase,
  promptError: { readonly code: string } | null,
): AttachmentDeliveryState {
  if (promptError !== null) return 'failed'
  if (phase === 'adjudicating') return 'preparing'
  if (phase === 'submitting') return 'sending'
  return 'pending'
}

/** Re-enter the existing submission transaction without creating a second send path. */
export function retryAttachmentDelivery(
  state: AttachmentDeliveryState,
  phase: AttachmentInputPhase,
  actions: { submit(): void } | undefined,
): boolean {
  if (state !== 'failed' || phase !== 'plain' || actions === undefined) return false
  actions.submit()
  return true
}
