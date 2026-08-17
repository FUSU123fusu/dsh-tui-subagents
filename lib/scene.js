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

/** Fixed-width label column in the list rows. */
const MODE_W = 5
const ID_W = 8

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

    const foldRef = React.useRef(createFoldState())
    const tokenRef = React.useRef(0)

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
        if (foldEvent(foldRef.current, event, t)) bump()
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

    // Chrome: title(1) + divider(1) + hint(1) + one breathing line.
    const bodyRows = Math.max(3, termRows - 4)

    useInput((input, key) => {
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
      // detail
      if (key.escape) {
        store.set({ selectedId: undefined })
        setMode('list')
        return undefined
      }
      if (input === 'e' || input === 'E') return setExpandThinking((v) => !v)
      const total = fold.rows.length
      const maxScroll = Math.max(0, total - bodyRows)
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
      if (mode === 'detail' && follow) setScroll(Math.max(0, fold.rows.length - bodyRows))
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
          const modeLabel = (child.mode === 'continuable' ? t('mode-continuable') : t('mode-oneshot')).padEnd(MODE_W)
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
      return h(Box, { flexDirection: 'column', paddingX: 1 }, ...rows)
    }

    // ── detail mode ────────────────────────────────────────────────────────
    const current = children.find((child) => normalizeId(child.id) === detailId)
    const label = current === undefined ? (detailId ?? '').slice(0, 8) : (childLabel(current) || shortId(current))
    const running = current?.activity === 'running'

    const body = []
    if (status === 'loading') {
      body.push(h(Text, { key: 'loading', dimColor: true }, t('detail-loading')))
    } else if (status !== '' && status !== 'ready') {
      body.push(h(Text, { key: 'error', color: 'error' }, t('detail-load-failed', { err: status })))
    } else {
      if (fold.rows.length === 0 && fold.liveText === '' && fold.liveReasoning === '') {
        body.push(h(Text, { key: 'none', dimColor: true }, t('detail-empty')))
      }
      const start = follow ? Math.max(0, fold.rows.length - bodyRows) : scroll
      const visible = fold.rows.slice(start, start + bodyRows)
      visible.forEach((row, index) => {
        body.push(renderRow(h, Box, Text, row, `r${start + index}`, expandThinking, t))
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
      { flexDirection: 'column', paddingX: 1 },
      h(
        Box,
        { key: 'header', flexDirection: 'row', columnGap: 1 },
        h(Text, { bold: true, color: 'text' }, t('detail-title', { label })),
        h(Text, { color: running ? 'success' : 'inactive' }, running ? t('detail-live') : t('detail-archived')),
        h(Text, { dimColor: true }, `· ${t('detail-readonly')}`),
      ),
      divider('div'),
      ...body,
      divider('div2'),
      h(Text, { key: 'hint', dimColor: true }, t('detail-hint')),
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
