import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mapTelegraphPage } from '../src/map.ts'

const page = JSON.parse(readFileSync(new URL('../fixtures/telegraph-page.json', import.meta.url), 'utf8')) as unknown

describe('mapTelegraphPage', () => {
  it('maps a legal telegraph row and rejects an illegal id', () => {
    const batch = mapTelegraphPage(page)

    expect(batch.items).toEqual([
      {
        sourceItemId: '123456',
        publishedAt: '2025-10-13T13:59:12.000Z',
        ctime: 1760363952,
        title: '第一行',
        body: '第一行\n其余',
        url: 'https://www.cls.cn/detail/123456',
        raw: {
          id: 123456,
          ctime: 1760363952,
          title: '',
          content: '第一行\n其余',
          shareurl: 'https://www.cls.cn/detail/123456',
        },
      },
    ])
    expect(batch.items[0]?.publishedAt.endsWith('Z')).toBe(true)
    expect(batch.rejects).toEqual([
      { reason: 'invalid_id', sourceItemId: '../x' },
    ])
  })

  it('keeps a non-empty title', () => {
    const batch = mapTelegraphPage({
      data: {
        roll_data: [
          {
            id: 'item_1',
            ctime: 1760363952,
            title: '已有标题',
            content: '第一行\n其余',
            shareurl: 'https://www.cls.cn/detail/item_1',
          },
        ],
      },
    })

    expect(batch.rejects).toEqual([])
    expect(batch.items[0]).toMatchObject({
      sourceItemId: 'item_1',
      title: '已有标题',
      body: '第一行\n其余',
    })
  })

  it('rejects a page without roll_data as map_failed', () => {
    expect(mapTelegraphPage({})).toEqual({
      items: [],
      rejects: [{ reason: 'map_failed', sourceItemId: '' }],
    })
    expect(mapTelegraphPage({ data: { roll_data: {} } })).toEqual({
      items: [],
      rejects: [{ reason: 'map_failed', sourceItemId: '' }],
    })
    expect(mapTelegraphPage({ data: { roll_data: [] } })).toEqual({
      items: [],
      rejects: [],
    })
  })

  it('rejects an id or body that cannot be stored', () => {
    const batch = mapTelegraphPage({
      data: {
        roll_data: [
          { id: null },
          { id: Number.POSITIVE_INFINITY },
          { id: 'bad-body', ctime: 1760363952 },
          { id: 'bad-time', content: '正文', ctime: 'now' },
          { id: 'one-line', content: '只有一行', ctime: 1760363952 },
        ],
      },
    })

    expect(batch.rejects).toEqual([
      { reason: 'map_failed', sourceItemId: '' },
      { reason: 'map_failed', sourceItemId: '' },
      { reason: 'map_failed', sourceItemId: 'bad-body' },
      { reason: 'map_failed', sourceItemId: 'bad-time' },
    ])
    expect(batch.items).toEqual([
      {
        sourceItemId: 'one-line',
        publishedAt: '2025-10-13T13:59:12.000Z',
        ctime: 1760363952,
        title: '只有一行',
        body: '只有一行',
        url: '',
        raw: { id: 'one-line', content: '只有一行', ctime: 1760363952 },
      },
    ])
  })

  it('rejects one entry without an id and still maps its sibling', () => {
    const batch = mapTelegraphPage({
      data: {
        roll_data: [
          null,
          {
            id: 42,
            ctime: 1760363952,
            title: '标题',
            content: '正文',
            shareurl: 'https://www.cls.cn/detail/42',
          },
        ],
      },
    })

    expect(batch.rejects).toEqual([
      { reason: 'map_failed', sourceItemId: '' },
    ])
    expect(batch.items.map(item => item.sourceItemId)).toEqual(['42'])
  })
})
