import { describe, expect, it } from 'vitest'
import { assertHttpsHost } from '../src/policy.ts'
import { canonicalHash, signQuery, stableJson } from '../src/sign.ts'

describe('signQuery', () => {
  it('signs sorted telegraph params as sha1 hex then md5 hex', () => {
    expect(signQuery({
      sv: '8.7.9',
      os: 'web',
      name: 'telegraph',
      app: 'CailianpressWeb',
    })).toBe('6c73b056a64891cdc257dcf1914464ad')
  })
})

describe('stableJson', () => {
  it('sorts nested keys and renders undefined as null', () => {
    expect(stableJson({ z: null, a: [{ b: 1, a: 2 }] })).toBe('{"a":[{"a":2,"b":1}],"z":null}')
    expect(stableJson(undefined)).toBe('null')
  })
})

describe('canonicalHash', () => {
  it('hashes title, body, and url as sorted compact JSON', () => {
    expect(canonicalHash({
      url: 'https://www.cls.cn/detail/123456',
      title: '第一行',
      body: '第一行\n其余',
    })).toBe('2424c703acf0e76856d28508d1d157050fe6658ef8aad9cf4bbb8c4f58f73c96')
  })
})

describe('assertHttpsHost', () => {
  const allowedHosts = ['www.cls.cn']

  it('rejects a non-HTTPS URL', () => {
    expect(() => assertHttpsHost(new URL('http://www.cls.cn/nodeapi/telegraphList'), allowedHosts)).toThrow()
  })

  it('rejects a host outside allowedHosts', () => {
    expect(() => assertHttpsHost(new URL('https://evil.example/telegraph'), allowedHosts)).toThrow()
  })

  it('accepts an HTTPS URL on an allowed host', () => {
    expect(() => assertHttpsHost(new URL('https://www.cls.cn/nodeapi/telegraphList'), allowedHosts)).not.toThrow()
  })
})
