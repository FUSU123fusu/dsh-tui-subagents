/**
 * scene.js — the full-screen subagent viewer scene.
 *
 * Plain createElement, no JSX: the plugin ships zero dependencies and the
 * scene contract requires the HOST's React for every hook and element (see
 * TuiSceneProps in dsh-TUI's scenes.ts). The component receives that React
 * at render time through its props; all non-React dependencies (store, api,
 * t) close over the factory.
 *
 * The visual language mirrors the main conversation: ● bullets for assistant
 * text, ❯ bubbles for user messages, `∴` folded thinking (e toggles), bold
 * tool names with a dim `⎿` result gutter, theme color tokens throughout —
 * the viewer should read as the same app looking at a different session.
 *
 * Two modes: 'list' (children of the current session) and 'detail' (one
 * child's trajectory, backfilled from persistence then live-appended from
 * the cordis `session/event` feed).
 */

import { createFoldState, foldEvent, flush } from './fold.js'
import { childLabel, normalizeId, shortId } from './list.js'

/** Fixed-width id column in the list rows. */
const ID_W = 8

/** 1234 → 1.2k, 1234567 → 1.2M */
function formatTokens(n) {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** Rough display width: CJK/full-width codepoints count as 2 cells. */
function displayWidth(text) {
  let width = 0
  for (const ch of text) width += ch.codePointAt(0) >= 0x2e80 ? 2 : 1
  return width
}

/** Estimated wrapped line count of `text` in a column `width` cells wide. */
function wrapLines(text, width) {
  let lines = 0
  for (const seg of text.split('\n')) lines += Math.max(1, Math.ceil(displayWidth(seg) / Math.max(8, width)))
  return lines
}

/**
 * Estimated visual height of one folded row. Single-line kinds are truncated
 * by the renderer, so they always occupy exactly one line; wrapping kinds pay
 * their real height. Slicing by these estimates is what keeps the frame
 * inside the terminal — slicing by row count lets a few tall bubbles
 * overflow the screen and smear rows over each other.
 */
function rowLines(row, width, expandThinking) {
  switch (row.kind) {
    case 'user':
      // Tag line + bubble (❯ prefix).
      return 1 + wrapLines(row.text, width - 3) + 1 // +1 marginTop
    case 'assistant':
      return wrapLines(row.text, width - 2)
    case 'reasoning':
      return expandThinking ? wrapLines(row.text, width) : 1
    case 'tool':
      return 1 + 1 // marginTop
    default:
      return 1
  }
}

/**
 * Slice `rows` to fit `maxLines` visual lines. `scroll` is in visual lines
 * from the top; follow mode pins the window to the bottom.
 */
function sliceByLines(rows, maxLines, scroll, follow, width, expandThinking) {
  const counts = rows.map((row) => rowLines(row, width, expandThinking))
  if (follow) {
    let used = 0
    let start = rows.length
    while (start > 0 && used + counts[start - 1] <= maxLines) used += counts[--start]
    return { start, end: rows.length, maxScroll: Math.max(0, counts.reduce((a, b) => a + b, 0) - maxLines) }
  }
  const total = counts.reduce((a, b) => a + b, 0)
  const maxScroll = Math.max(0, total - maxLines)
  let remaining = Math.min(scroll, maxScroll)
  let start = 0
  while (start < rows.length && remaining >= counts[start]) remaining -= counts[start++]
  let used = 0
  let end = start
  while (end < rows.length && used + counts[end] <= maxLines) used += counts[end++]
  if (end === start && start < rows.length) end = start + 1 // always show something
  return { start, end, maxScroll }
}

export { displayWidth, rowLines, sliceByLines, wrapLines }

/**
 * Build the scene component. `api` and `store` come from the plugin's apply
 * closure; `t` is the translator.
 */
export function createSceneComponent({ store, api, t }) {
  /**
   * @param {{ React: typeof import('react'), ui: any, channel: any, close(): void }} props
   */
  return function SubagentsScene({ React, ui, close }) {
    const { Box, Text, useInput, useTerminalSize } = ui
    const { columns, rows: termRows } = useTerminalSize()
    const [, bump] = React.useReducer((x) => x + 1, 0)

    const [mode, setMode] = React.useState(store.data.selectedId === undefined ? 'list' : 'detail')
    const [cursor, setCursor] = React.useState(0)
    const [detailId, setDetailId] = React.useState(store.data.selectedId)
    const [status, setStatus] = React.useState('')
    const [scroll, setScroll] = React.useState(0)
    const [follow, setFollow] = React.useState(true)
    const [expandThinking, setExpandThinking] = React.useState(false)
    const [inputMode, setInputMode] = React.useState(false)
    const [inputText, setInputText] = React.useState('')
    const [note, setNote] = React.useState('')

    const foldRef = React.useRef(createFoldState())
    const tokenRef = React.useRef(0)

    // Frame-aligned re-renders: assistant/chunk fires per token, so fold
    // arrivals schedule a trailing bump instead of re-rendering per token.
    const bumpTimerRef = React.useRef(null)
    const scheduleBump = () => {
      if (bumpTimerRef.current !== null) return
      bumpTimerRef.current = setTimeout(() => {
        bumpTimerRef.current = null
        bump()
      }, 50)
    }
    React.useEffect(
      () => () => {
        if (bumpTimerRef.current !== null) clearTimeout(bumpTimerRef.current)
      },
      [],
    )

    /** Transient feedback line above the hint; auto-clears. */
    const noteTimerRef = React.useRef(null)
    const flash = (text) => {
      setNote(text)
      if (noteTimerRef.current !== null) clearTimeout(noteTimerRef.current)
      noteTimerRef.current = setTimeout(() => {
        noteTimerRef.current = null
        setNote('')
        bump()
      }, 4000)
    }

    // ── store sync: a later /subagents invocation re-targets the scene ─────
    React.useEffect(() => store.subscribe(bump), [])

    // ── list refresh on subagent lifecycle edges ───────────────────────────
    React.useEffect(
      () =>
        api.subscribeLifecycle(() => {
          void api.listChildren(store.data.parentId).then((children) => {
            if (children !== undefined) store.set({ children })
          })
        }),
      [],
    )

    const openDetail = (id) => {
      const token = ++tokenRef.current
      const fold = createFoldState()
      foldRef.current = fold
      setDetailId(id)
      setMode('detail')
      setScroll(0)
      setFollow(true)
      setStatus('loading')
      api
        .loadEvents(id)
        .then((events) => {
          if (tokenRef.current !== token) return
          for (const event of events) foldEvent(fold, event, t)
          flush(fold)
          setStatus('ready')
          bump()
        })
        .catch((error) => {
          if (tokenRef.current !== token) return
          setStatus(error instanceof Error ? error.message : String(error))
          bump()
        })
    }

    // A selectedId handed in while the scene was already mounted (e.g.
    // `/subagents <prefix>` re-invocation) opens that detail directly.
    React.useEffect(() => {
      const selected = store.data.selectedId
      if (selected !== undefined && selected !== detailId) openDetail(selected)
    })

    // ── live events for the open detail ────────────────────────────────────
    React.useEffect(() => {
      if (mode !== 'detail' || detailId === undefined) return undefined
      return api.subscribeEvents((sessionId, event) => {
        if (sessionId !== detailId) return
        if (foldEvent(foldRef.current, event, t)) scheduleBump()
      })
    }, [mode, detailId])

    const refreshList = () => {
      void api.listChildren(store.data.parentId).then((children) => {
        if (children !== undefined) store.set({ children })
        bump()
      })
    }

    const children = store.data.children
    const fold = foldRef.current

    // Chrome: title(1) + divider(1) + divider(1) + hint(1).
    const bodyRows = Math.max(3, termRows - 4)
    const innerWidth = Math.max(16, columns - 2)
    // Live stream tail also occupies visual lines; reserve them so the frame
    // never exceeds the terminal height.
    const liveLines =
      (fold.liveReasoning === '' ? 0 : expandThinking ? wrapLines(fold.liveReasoning, innerWidth) : 1) +
      (fold.liveText === '' ? 0 : wrapLines(fold.liveText, innerWidth - 2))
    const slice = sliceByLines(fold.rows, Math.max(1, bodyRows - liveLines), scroll, follow, innerWidth, expandThinking)
    const maxScroll = slice.maxScroll

    const current = children.find((child) => normalizeId(child.id) === detailId)
    const continuable = current?.mode === 'continuable' && store.data.parentAgent !== undefined
    const running = current?.activity === 'running'

    // Sibling navigation (opencode-style): same-parent children in list order.
    const siblingIds = children.map((child) => normalizeId(child.id))
    const siblingIndex = siblingIds.indexOf(detailId)
    const stepSibling = (delta) => {
      if (siblingIndex === -1 || siblingIds.length < 2) return
      const next = (siblingIndex + delta + siblingIds.length) % siblingIds.length
      const id = siblingIds[next]
      store.set({ selectedId: id })
      openDetail(id)
    }

    // Interrupt confirmation (opencode's double-Esc discipline): the first x
    // arms a 3s window, only the second actually interrupts.
    const armedInterruptRef = React.useRef(0)

    const sendMessage = () => {
      const text = inputText.trim()
      setInputMode(false)
      setInputText('')
      if (text === '') return flash(t('input-empty'))
      flash(t('sending'))
      api
        .followup(store.data.parentAgent, detailId, text)
        .then(() => flash(t('sent-ok')))
        .catch((error) => flash(t('sent-failed', { err: error instanceof Error ? error.message : String(error) })))
    }

    const interruptTurn = () => {
      if (!running) return flash(t('interrupt-na'))
      const now = Date.now()
      if (now - armedInterruptRef.current > 3000) {
        armedInterruptRef.current = now
        return flash(t('confirm-interrupt'))
      }
      armedInterruptRef.current = 0
      api
        .interrupt(store.data.parentId, detailId)
        .then(() => flash(t('interrupt-ok')))
        .catch((error) => flash(t('interrupt-failed', { err: error instanceof Error ? error.message : String(error) })))
    }

    useInput((input, key) => {
      // Message composer captures every key while open.
      if (inputMode) {
        if (key.escape) {
          setInputMode(false)
          setInputText('')
          return undefined
        }
        if (key.return) return sendMessage()
        if (key.backspace || key.delete) return setInputText((s) => s.slice(0, -1))
        if (input !== '') return setInputText((s) => s + input)
        return undefined
      }
      if (mode === 'list') {
        if (key.escape) return close()
        if (key.upArrow) return setCursor((c) => Math.max(0, c - 1))
        if (key.downArrow) return setCursor((c) => Math.min(Math.max(0, children.length - 1), c + 1))
        if (input === 'r') return refreshList()
        if (key.return) {
          const child = children[cursor]
          if (child === undefined) return undefined
          const id = normalizeId(child.id)
          store.set({ selectedId: id })
          return openDetail(id)
        }
        return undefined
      }
      // detail — scroll is in visual lines, not rows
      if (key.escape) {
        store.set({ selectedId: undefined })
        setMode('list')
        return undefined
      }
      if (input === 'e' || input === 'E') return setExpandThinking((v) => !v)
      if ((input === 'i' || input === 'I') && continuable) return setInputMode(true)
      if ((input === 'x' || input === 'X') && continuable) return interruptTurn()
      if (key.leftArrow) return stepSibling(-1)
      if (key.rightArrow) return stepSibling(1)
      if (key.upArrow) {
        setFollow(false)
        return setScroll((s) => Math.max(0, s - 1))
      }
      if (key.downArrow) {
        return setScroll((s) => {
          const next = Math.min(maxScroll, s + 1)
          if (next >= maxScroll) setFollow(true)
          return next
        })
      }
      if (key.pageUp) {
        setFollow(false)
        return setScroll((s) => Math.max(0, s - bodyRows))
      }
      if (key.pageDown) {
        return setScroll((s) => {
          const next = Math.min(maxScroll, s + bodyRows)
          if (next >= maxScroll) setFollow(true)
          return next
        })
      }
      if (input === 'g' || input === 'G') {
        setFollow(true)
        return setScroll(maxScroll)
      }
      return undefined
    })

    // Follow-tail: live arrivals re-pin the viewport to the bottom unless the
    // user scrolled away.
    React.useEffect(() => {
      if (mode === 'detail' && follow) setScroll(maxScroll)
    })

    const h = React.createElement
    const divider = (key) => h(Text, { key, dimColor: true, wrap: 'truncate' }, '─'.repeat(Math.max(8, columns - 2)))

    // ── list mode ──────────────────────────────────────────────────────────
    if (mode === 'list') {
      const rows = [
        h(Text, { key: 'title', bold: true, color: 'text' }, t('list-title', { count: children.length })),
        divider('div'),
      ]
      if (children.length === 0) {
        rows.push(h(Text, { key: 'empty', dimColor: true }, t('list-empty')))
      } else {
        const listWindow = Math.max(3, bodyRows - 1)
        const start = Math.max(0, Math.min(cursor - listWindow + 1, children.length - listWindow))
        const windowed = children.slice(start, start + listWindow)
        windowed.forEach((child, index) => {
          const absolute = start + index
          const selected = absolute === cursor
          const id = shortId(child).padEnd(ID_W)
          const modeLabel = child.mode === 'continuable' ? t('mode-continuable') : t('mode-oneshot')
          const running = child.activity === 'running'
          const label = childLabel(child) || id.trim()
          rows.push(
            h(
              Box,
              { key: id || String(absolute), flexDirection: 'row' },
              h(Text, { color: selected ? 'suggestion' : 'inactive' }, selected ? '❯ ' : '  '),
              h(Text, { color: running ? 'success' : 'inactive' }, running ? '● ' : '○ '),
              h(Text, { dimColor: child.mode !== 'continuable' }, `${modeLabel} `),
              h(Text, { bold: selected, wrap: 'truncate' }, `${label} `),
              h(Text, { dimColor: true }, id),
            ),
          )
        })
      }
      rows.push(divider('div2'), h(Text, { key: 'hint', dimColor: true }, t('list-hint')))
      return h(Box, { flexDirection: 'column', paddingX: 1, height: termRows, overflow: 'hidden' }, ...rows)
    }

    // ── detail mode ────────────────────────────────────────────────────────
    const label = current === undefined ? (detailId ?? '').slice(0, 8) : (childLabel(current) || shortId(current))

    const body = []
    if (status === 'loading') {
      body.push(h(Text, { key: 'loading', dimColor: true }, t('detail-loading')))
    } else if (status !== '' && status !== 'ready') {
      body.push(h(Text, { key: 'error', color: 'error' }, t('detail-load-failed', { err: status })))
    } else {
      if (fold.rows.length === 0 && fold.liveText === '' && fold.liveReasoning === '') {
        body.push(h(Text, { key: 'none', dimColor: true }, t('detail-empty')))
      }
      const visible = fold.rows.slice(slice.start, slice.end)
      visible.forEach((row, index) => {
        body.push(renderRow(h, Box, Text, row, `r${slice.start + index}`, expandThinking, t))
      })
      // In-flight stream tail.
      if (fold.liveReasoning !== '') {
        body.push(
          expandThinking
            ? h(Text, { key: 'live-r', dimColor: true, italic: true, wrap: 'wrap' }, fold.liveReasoning)
            : h(Text, { key: 'live-r', dimColor: true, italic: true }, t('thinking-live', { chars: fold.liveReasoning.length })),
        )
      }
      if (fold.liveText !== '') {
        body.push(h(Text, { key: 'live-t', wrap: 'wrap' }, `● ${fold.liveText}`))
      }
    }

    return h(
      Box,
      { flexDirection: 'column', paddingX: 1, height: termRows, overflow: 'hidden' },
      h(
        Box,
        { key: 'header', flexDirection: 'row', columnGap: 1 },
        h(Text, { bold: true, color: 'text' }, t('detail-title', { label })),
        siblingIndex !== -1 && siblingIds.length > 1
          ? h(Text, { dimColor: true }, t('detail-position', { i: siblingIndex + 1, n: siblingIds.length }))
          : null,
        h(Text, { color: running ? 'success' : 'inactive' }, running ? t('detail-live') : t('detail-archived')),
        h(Text, { dimColor: true }, `· ${continuable ? t('detail-interactive') : t('detail-readonly')}`),
        fold.tokens > 0 ? h(Text, { dimColor: true }, `· ${t('detail-tokens', { count: formatTokens(fold.tokens) })}`) : null,
      ),
      divider('div'),
      h(Box, { key: 'body', flexDirection: 'column', flexGrow: 1, overflow: 'hidden' }, ...body),
      divider('div2'),
      note === ''
        ? null
        : h(Text, { key: 'note', color: note.startsWith('✗') ? 'error' : 'success' }, note),
      inputMode
        ? h(
            Text,
            { key: 'input', color: 'suggestion', wrap: 'truncate-end' },
            `${t('input-prompt')} ${inputText}▌`,
          )
        : h(Text, { key: 'hint', dimColor: true }, continuable ? t('detail-hint-talk') : t('detail-hint')),
    )
  }
}

/** Render one folded row in the main conversation's visual language. */
function renderRow(h, Box, Text, row, key, expandThinking, t) {
  switch (row.kind) {
    case 'turn':
      return h(Text, { key, dimColor: true }, row.text)
    case 'user':
      return h(
        Box,
        { key, flexDirection: 'column', marginTop: 1 },
        h(Text, { dimColor: true }, row.tag),
        h(Text, { backgroundColor: 'userMessageBackground', wrap: 'wrap' }, `❯ ${row.text}`),
      )
    case 'assistant':
      return h(Text, { key, wrap: 'wrap' }, `● ${row.text}`)
    case 'reasoning':
      return expandThinking
        ? h(Text, { key, dimColor: true, italic: true, wrap: 'wrap' }, row.text)
        : h(Text, { key, dimColor: true, italic: true }, t('thinking-folded', { chars: row.text.length }))
    case 'tool':
      return h(
        Box,
        { key, flexDirection: 'row', marginTop: 1 },
        h(Text, { bold: true, wrap: 'truncate-end' }, row.name ?? row.text),
        row.args ? h(Text, { dimColor: true, wrap: 'truncate-end' }, ` ${row.args}`) : null,
      )
    case 'tool-result':
      return h(Text, { key, dimColor: true, wrap: 'truncate-end' }, ` ⎿ ${row.text}`)
    case 'inject':
      return h(Text, { key, dimColor: true }, row.text)
    case 'meta':
      return h(Text, { key, dimColor: true }, `· ${row.text}`)
    case 'error':
      return h(Text, { key, color: 'error' }, row.text)
    default:
      return h(Text, { key, wrap: 'wrap' }, row.text)
  }
}
