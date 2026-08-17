import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { childLabel, formatChildRow, normalizeId, resolvePrefix, shortId } from '../lib/list.js'
import { createT } from '../lib/i18n.js'

const t = createT('zh')

const children = [
  { id: 'a1b2c3d4-0000-0000-0000-000000000000', mode: 'continuable', label: '研究员', activity: 'running' },
  { id: { value: 'b2c3d4e5-0000-0000-0000-000000000000' }, mode: 'one-shot', activity: 'inactive' },
]

describe('normalizeId', () => {
  it('accepts strings and branded { value } objects', () => {
    assert.equal(normalizeId('abc'), 'abc')
    assert.equal(normalizeId({ value: 'xyz' }), 'xyz')
    assert.equal(normalizeId(undefined), '')
    assert.equal(normalizeId(null), '')
    assert.equal(normalizeId({}), '')
  })
})

describe('resolvePrefix', () => {
  it('resolves unique prefixes case-insensitively', () => {
    assert.deepEqual(resolvePrefix('A1B2', children), { status: 'ok', id: 'a1b2c3d4-0000-0000-0000-000000000000' })
    assert.deepEqual(resolvePrefix('b2', children), { status: 'ok', id: 'b2c3d4e5-0000-0000-0000-000000000000' })
  })

  it('resolves a full id exactly even when it prefixes others', () => {
    const list = [
      { id: 'aaaa-1' },
      { id: 'aaaa-12' },
    ]
    assert.deepEqual(resolvePrefix('aaaa-1', list), { status: 'ok', id: 'aaaa-1' })
  })

  it('reports not-found and ambiguous', () => {
    assert.deepEqual(resolvePrefix('zz', children), { status: 'not-found' })
    assert.deepEqual(resolvePrefix('', children), { status: 'not-found' })
    const list = [{ id: 'aa-x' }, { id: 'aa-y' }]
    assert.deepEqual(resolvePrefix('aa', list), { status: 'ambiguous' })
  })
})

describe('row formatting', () => {
  it('formats the same row shape as built-in /agents', () => {
    const row = formatChildRow(children[0], t)
    assert.ok(row.includes('可续'))
    assert.ok(row.includes('「研究员」'))
    assert.ok(row.includes('运行中'))
    assert.ok(row.includes('a1b2c3d4'))
  })

  it('handles missing labels and branded ids', () => {
    const row = formatChildRow(children[1], t)
    assert.ok(row.includes('一次性'))
    assert.ok(!row.includes('「'))
    assert.equal(shortId(children[1]), 'b2c3d4e5')
  })

  it('childLabel trims and wraps', () => {
    assert.equal(childLabel({ label: '  hi  ' }), '「hi」')
    assert.equal(childLabel({}), '')
  })
})
