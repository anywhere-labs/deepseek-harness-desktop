import { describe, expect, it } from 'vitest'
import { maskSecrets } from '../src/mask-secrets.ts'

describe('maskSecrets', () => {
  it('masks API key values', () => {
    const masked = maskSecrets('key is sk-1234abcd5678')
    expect(masked).toContain('sk-****')
    expect(masked).not.toContain('sk-1234abcd')
  })

  it('masks bearer tokens in headers', () => {
    const masked = maskSecrets('Authorization: Bearer abc.def.ghi')
    expect(masked).toContain('Bearer ****')
    expect(masked).not.toContain('abc.def.ghi')
  })

  it('masks basic authorization credentials', () => {
    const masked = maskSecrets('Authorization: Basic dXNlcjpwYXNzd29yZA==')
    expect(masked).toBe('Authorization: Basic ****')
    expect(masked).not.toContain('dXNlcjpwYXNzd29yZA==')
  })

  it('masks cookie header values', () => {
    const masked = maskSecrets('Cookie: session=short-secret; theme=dark')
    expect(masked).toBe('Cookie: ****')
    expect(masked).not.toContain('short-secret')
  })

  it('masks URL userinfo and sensitive query values', () => {
    const masked = maskSecrets('GET https://user:pass@example.com/api?token=short&mode=fast')
    expect(masked).toBe('GET https://****:****@example.com/api?token=****&mode=fast')
    expect(masked).not.toContain('user:pass')
    expect(masked).not.toContain('token=short')
  })

  it('masks named secret fields even when their values are short', () => {
    const masked = maskSecrets('api_key=short password: hunter2 mode=fast')
    expect(masked).toBe('api_key=**** password: **** mode=fast')
    expect(masked).not.toContain('hunter2')
  })

  it('masks quoted secret fields in rendered JSON', () => {
    const masked = maskSecrets(JSON.stringify({
      api_key: 'short-secret',
      code: 'short-code',
      nested: {
        access_token: 'access123',
        authorization: 'custom-auth',
        password: 'hunter2',
        token: 'abc123',
        'x-api-key': 'short-key',
      },
      mode: 'fast',
    }))

    expect(masked).toBe('{"api_key":"****","code":"****","nested":{"access_token":"****","authorization":"****","password":"****","token":"****","x-api-key":"****"},"mode":"fast"}')
    expect(masked).not.toContain('short-secret')
    expect(masked).not.toContain('short-code')
    expect(masked).not.toContain('access123')
    expect(masked).not.toContain('custom-auth')
    expect(masked).not.toContain('short-key')
    expect(masked).not.toContain('hunter2')
    expect(masked).not.toContain('abc123')
  })

  it('leaves ordinary prose untouched', () => {
    expect(maskSecrets('hello world, profile "desktop"')).toBe('hello world, profile "desktop"')
  })
})
