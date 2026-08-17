import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { displayWidth, rowLines, sliceByLines, wrapLines } from '../lib/scene.js'

describe('displayWidth / wrapLines', () => {
  it('counts CJK as double width', () => {
    assert.equal(displayWidth('abc'), 3)
    assert.equal(displayWidth('三体'), 4)
    assert.equal(displayWidth('a三'), 3)
  })

  it('estimates wrapped lines with newlines and width', () => {
    assert.equal(wrapLines('short', 80), 1)
    assert.equal(wrapLines('x'.repeat(200), 80), 3) // 80+80+40
    assert.equal(wrapLines('a\nb\n', 80), 3) // trailing newline = one blank line (overestimate is the safe direction)
    assert.equal(wrapLines('三体'.repeat(50), 40), 5) // 200 cells / 40
  })
})

describe('rowLines', () => {
  const width = 80
  it('single-line kinds always cost one line', () => {
    for (const kind of ['turn', 'inject', 'meta', 'tool-result', 'error']) {
      assert.equal(rowLines({ kind, text: 'x'.repeat(500) }, width, false), 1, kind)
    }
    // tool pays its marginTop too.
    assert.equal(rowLines({ kind: 'tool', name: 'bash', args: 'x'.repeat(500), text: '' }, width, false), 2)
  })

  it('wrapping kinds pay their real height', () => {
    const long = 'x'.repeat(200)
    assert.equal(rowLines({ kind: 'assistant', text: long }, width, false), wrapLines(long, width - 2))
    // user = tag + bubble + margin
    assert.equal(rowLines({ kind: 'user', tag: '用户', text: long }, width, false), 1 + wrapLines(long, width - 3) + 1)
    // collapsed thinking costs one line regardless of length
    assert.equal(rowLines({ kind: 'reasoning', text: long }, width, false), 1)
    assert.equal(rowLines({ kind: 'reasoning', text: long }, width, true), wrapLines(long, width))
  })
})

describe('sliceByLines', () => {
  const rows = [
    { kind: 'turn', text: '── 1 ──' },          // 1 line
    { kind: 'user', tag: '用户', text: 'x'.repeat(200) }, // 1 + 3 + 1 = 5 lines @80
    { kind: 'assistant', text: 'y'.repeat(200) },  // ceil(202/78)=3 lines
    { kind: 'meta', text: 'model' },               // 1 line
  ]

  it('follow mode pins the window to the bottom by lines, not rows', () => {
    const { start, end } = sliceByLines(rows, 4, 0, true, 80, false)
    // From the tail: meta(1) + assistant(3) = 4 fits; adding user(5) would not.
    assert.equal(start, 2)
    assert.equal(end, 4)
  })

  it('scroll mode walks row boundaries and always shows something', () => {
    const top = sliceByLines(rows, 4, 0, false, 80, false)
    assert.equal(top.start, 0)
    // turn(1) fits, user(5) would exceed 4 → only the turn row.
    assert.equal(top.end, 1)

    const deep = sliceByLines(rows, 4, 6, false, 80, false)
    // 6 lines consumed: turn(1)+user(5) → start at assistant.
    assert.equal(deep.start, 2)
    assert.ok(deep.end > deep.start)
    assert.ok(deep.maxScroll >= 6 - 4)
  })

  it('clamps overscroll and handles tiny windows', () => {
    const clamped = sliceByLines(rows, 4, 9999, false, 80, false)
    assert.ok(clamped.end > clamped.start)
    const tiny = sliceByLines(rows, 1, 0, true, 80, false)
    assert.equal(tiny.end - tiny.start >= 1, true)
  })
})
