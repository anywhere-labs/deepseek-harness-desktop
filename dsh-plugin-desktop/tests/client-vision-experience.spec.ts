import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconCheckOutline16: () => null,
  IconChevronDownOutline14: () => null,
  IconCloseFill14: () => null,
  IconWarningOutline16: () => null,
}))

import { modelCatalogModelSchema } from '@deepseek-ai/dsh-host-apiproxy/api/sessions.schema'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import {
  attachmentDeliveryState,
  modelCapabilityBadges,
  retryAttachmentDelivery,
} from '../src/client/vision-experience.ts'
import { applyVisionExperience } from '../src/client/vision-registration.ts'

describe('Desktop Vision model metadata', () => {
  it('preserves image modalities through the Host model-directory schema', () => {
    const parsed = modelCatalogModelSchema.parse({
      id: 'visual-model',
      name: 'Visual Model',
      inputModalities: ['text', 'image'],
    })

    expect(parsed).toMatchObject({ inputModalities: ['text', 'image'] })
  })

  it('derives capability badges without coupling to one DeepSeek model id', () => {
    expect(modelCapabilityBadges({
      id: 'vendor-vision-experimental',
      name: 'Vendor Vision Experimental',
      inputModalities: ['text', 'image'],
    })).toEqual(['vision', 'experimental'])
    expect(modelCapabilityBadges({
      id: 'ordinary-text-model',
      name: 'Ordinary Text Model',
      inputModalities: ['text'],
    })).toEqual([])
  })
})

describe('Desktop Vision attachment delivery', () => {
  it('maps the input transaction and prompt error to visible delivery states', () => {
    expect(attachmentDeliveryState('plain', null)).toBe('pending')
    expect(attachmentDeliveryState('adjudicating', null)).toBe('preparing')
    expect(attachmentDeliveryState('submitting', null)).toBe('sending')
    expect(attachmentDeliveryState('plain', { code: 'attachment-error' })).toBe('failed')
  })

  it('retries through the existing input action only from a failed plain draft', () => {
    const submit = vi.fn()

    expect(retryAttachmentDelivery('failed', 'plain', { submit })).toBe(true)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(retryAttachmentDelivery('sending', 'submitting', { submit })).toBe(false)
    expect(submit).toHaveBeenCalledTimes(1)
  })
})

describe('Desktop Vision slot registration', () => {
  it('shadows the upstream model and attachment occupants without replacing their owners', () => {
    const register = vi.fn(() => () => {})
    const inject = vi.fn((_name: string, mount: () => unknown) => mount())
    const effect = vi.fn()
    const ctx = {
      effect,
      inject: vi.fn((_services: readonly string[], mount: (scope: ClientContext) => unknown) => mount(ctx as unknown as ClientContext)),
      locale: {
        bind: () => (key: string) => key,
        register: vi.fn(() => () => {}),
      },
      slots: { inject, register },
    } as unknown as ClientContext

    applyVisionExperience(ctx)

    expect(inject).toHaveBeenCalledWith('conversation.input.model', expect.any(Function))
    expect(inject).toHaveBeenCalledWith('conversation.input.attachments', expect.any(Function))
    const registrations = register.mock.calls as unknown as Array<[Record<string, unknown>, unknown]>
    expect(registrations.map(([options]) => options)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'conversation.input.model', priority: -100 }),
      expect.objectContaining({ name: 'conversation.input.attachments', priority: -100 }),
    ]))
  })
})
