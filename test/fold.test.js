import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { brief, createFoldState, foldAll, foldEvent, textOfContent } from '../lib/fold.js'
import { createT } from '../lib/i18n.js'

const t = createT('zh')
const te = createT('en')

/** Shorthand builders for the event shapes the harness actually writes. */
const ev = (type, data, seq) => ({ type, seq, time: 1000 + (seq ?? 0), data })
const chunk = (text, type = 'text-delta') => ({ chunk: { type, text }, turn: 1, step: 0 })
const userMsg = (text, kind = 'user') => ({ content: [{ type: 'text', text }], source: { kind } })
const assistantMsg = (blocks) => ({ message: { content: blocks } })

describe('brief / textOfContent', () => {
  it('brief flattens whitespace and truncates', () => {
    assert.equal(brief('a\nb\tc'), 'a b c')
    assert.equal(brief('x'.repeat(300), 10), `${'x'.repeat(10)}…`)
    assert.equal(brief(undefined), '')
  })

  it('textOfContent joins text blocks and skips others', () => {
    assert.equal(textOfContent('plain'), 'plain')
    assert.equal(textOfContent([{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'r' }, { type: 'text', text: 'b' }]), 'a\nb')
    assert.equal(textOfContent([]), undefined)
    assert.equal(textOfContent(undefined), undefined)
  })
})

describe('foldEvent', () => {
  it('dedupes by seq', () => {
    const s = createFoldState()
    assert.equal(foldEvent(s, ev('turn/start', { turn: 1 }, 0), t), true)
    assert.equal(foldEvent(s, ev('turn/start', { turn: 1 }, 0), t), false)
    assert.equal(s.rows.length, 1)
  })

  it('streams chunks into live buffers and flushes at boundaries', () => {
    const s = createFoldState()
    foldEvent(s, ev('turn/start', { turn: 1 }, 0), t)
    foldEvent(s, ev('assistant/chunk', chunk('想一', 'reasoning-delta'), 1), t)
    foldEvent(s, ev('assistant/chunk', chunk('想一下', 'reasoning-delta'), 2), t)
    assert.equal(s.liveReasoning, '想一想一下')
    assert.equal(s.rows.length, 1) // only the turn separator so far

    foldEvent(s, ev('assistant/chunk', chunk('你好'), 3), t)
    // Text seals the reasoning buffer.
    assert.equal(s.liveReasoning, '')
    assert.equal(s.liveText, '你好')
    assert.equal(s.rows.at(-1).kind, 'reasoning')

    foldEvent(s, ev('assistant/chunk', chunk('世界'), 4), t)
    assert.equal(s.liveText, '你好世界')

    foldEvent(s, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5), t)
    assert.equal(s.liveText, '')
    assert.equal(s.rows.at(-1).kind, 'assistant')
    assert.equal(s.rows.at(-1).text, '你好世界')
  })

  it('skips assistant/message content already covered by chunks', () => {
    const s = createFoldState()
    foldEvent(s, ev('assistant/chunk', chunk('hi'), 0), t)
    const before = s.rows.length
    foldEvent(s, ev('assistant/message', assistantMsg([{ type: 'text', text: 'hi' }]), 1), t)
    // Buffer flushed into exactly one assistant row; no duplicate.
    assert.equal(s.rows.length, before + 1)
    assert.equal(s.rows.filter((r) => r.kind === 'assistant').length, 1)
  })

  it('renders assistant/message content when no chunks streamed (cold path)', () => {
    const s = createFoldState()
    foldEvent(s, ev('assistant/message', assistantMsg([
      { type: 'reasoning', text: '想一下' },
      { type: 'text', text: '答案' },
    ]), 0), t)
    assert.deepEqual(s.rows.map((r) => r.kind), ['reasoning', 'assistant'])
  })

  it('tags user messages by source kind', () => {
    const s = createFoldState()
    foldEvent(s, ev('user/message', userMsg('干这个'), 0), t)
    foldEvent(s, ev('user/message', userMsg('后续指令', 'coordinator'), 1), t)
    assert.ok(s.rows[0].text.startsWith('[用户]'))
    assert.ok(s.rows[1].text.startsWith('[主 agent]'))
  })

  it('pairs tool calls with results (nested tool-result blocks)', () => {
    const s = createFoldState()
    foldEvent(s, ev('tool/call', { callId: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' }, 0), t)
    // Real harness shape: content wraps a tool-result block carrying text blocks.
    foldEvent(s, ev('tool/result', {
      message: {
        source: { kind: 'tool', callId: 'c1' },
        content: [{ type: 'tool-result', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'ok' }] }],
      },
    }, 1), t)
    assert.equal(s.rows[0].kind, 'tool')
    assert.ok(s.rows[0].text.includes('bash'))
    assert.equal(s.rows[1].kind, 'tool-result')
    assert.ok(s.rows[1].text.includes('ok'))
  })

  it('marks isError tool-result blocks as error rows', () => {
    const s = createFoldState()
    foldEvent(s, ev('tool/result', {
      message: {
        source: { kind: 'tool', callId: 'c2' },
        content: [{ type: 'tool-result', toolCallId: 'c2', isError: true, content: [{ type: 'text', text: 'permission denied' }] }],
      },
    }, 0), t)
    assert.equal(s.rows[0].kind, 'error')
    assert.ok(s.rows[0].text.includes('permission denied'))
  })

  it('surfaces tool errors and interrupted turns as error rows', () => {
    const s = createFoldState()
    foldEvent(s, ev('tool/result', { error: { message: 'boom' }, message: { source: { callId: 'c9' } } }, 0), t)
    foldEvent(s, ev('turn/end', { turn: 2, reason: { kind: 'interrupted' } }, 1), t)
    assert.deepEqual(s.rows.map((r) => r.kind), ['error', 'error'])
    assert.ok(s.rows[0].text.includes('boom'))
    assert.ok(s.rows[1].text.includes('interrupted'))
  })

  it('announces model changes once', () => {
    const s = createFoldState()
    foldEvent(s, ev('request/context', { model: 'deepseek-v4-pro' }, 0), t)
    foldEvent(s, ev('request/context', { model: 'deepseek-v4-pro' }, 1), t)
    foldEvent(s, ev('request/context', { model: 'other' }, 2), t)
    assert.equal(s.rows.filter((r) => r.kind === 'meta').length, 2)
  })

  it('renders descriptor and compaction as meta rows', () => {
    const s = createFoldState()
    foldEvent(s, ev('subagent/descriptor', { version: 2, mode: 'one-shot', provider: 'spawn', label: 'distill' }, 0), t)
    foldEvent(s, ev('compaction/start', {}, 1), t)
    assert.equal(s.rows[0].kind, 'meta')
    assert.ok(s.rows[0].text.includes('distill'))
    assert.equal(s.rows[1].kind, 'meta')
  })

  it('ignores unknown and malformed events', () => {
    const s = createFoldState()
    assert.equal(foldEvent(s, ev('session/title', { title: 'x' }, 0), t), false)
    assert.equal(foldEvent(s, null, t), false)
    assert.equal(foldEvent(s, ev('assistant/chunk', { chunk: null }, 1), t), false)
    assert.equal(s.rows.length, 0)
  })
})

describe('foldAll', () => {
  it('replays a full log in order and flushes trailing buffers', () => {
    const events = [
      ev('subagent/descriptor', { version: 2, mode: 'continuable', provider: 'in-process', label: 'worker' }, 0),
      ev('turn/start', { turn: 1 }, 1),
      ev('user/message', userMsg('开始', 'coordinator'), 2),
      ev('assistant/chunk', chunk('好的'), 3),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4),
    ]
    const s = foldAll(events, te)
    assert.deepEqual(s.rows.map((r) => r.kind), ['meta', 'turn', 'user', 'assistant'])
    assert.equal(s.lastSeq, 4)
  })
})
