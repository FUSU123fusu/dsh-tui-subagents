/**
 * scene.js — the full-screen subagent viewer scene.
 *
 * Plain createElement, no JSX: the plugin ships zero dependencies and the
 * scene contract requires the HOST's React for every hook and element (see
 * TuiSceneProps in dsh-TUI's scenes.ts). The component receives that React
 * at render time through its props; all non-React dependencies (store, api,
 * t) close over the factory.
 *
 * Two modes: 'list' (children of the current session) and 'detail' (one
 * child's trajectory, backfilled from persistence then live-appended from
 * the cordis `session/event` feed).
 */

import { createFoldState, foldEvent, flush } from './fold.js'
import { childLabel, formatChildRow, normalizeId, shortId } from './list.js'

/** Chrome rows around the detail body: header, divider, hint, padding. */
const DETAIL_CHROME = 4
/** Chrome rows around the list body. */
const LIST_CHROME = 4

const ROW_COLORS = {
  meta: 'gray',
  turn: 'blue',
  user: 'green',
  assistant: undefined,
  reasoning: 'gray',
  tool: 'yellow',
  'tool-result': 'gray',
  error: 'red',
}

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
    const { rows: termRows } = useTerminalSize()
    const [, bump] = React.useReducer((x) => x + 1, 0)

    const [mode, setMode] = React.useState(store.data.selectedId === undefined ? 'list' : 'detail')
    const [cursor, setCursor] = React.useState(0)
    const [detailId, setDetailId] = React.useState(store.data.selectedId)
    const [status, setStatus] = React.useState('')
    const [scroll, setScroll] = React.useState(0)
    const [follow, setFollow] = React.useState(true)

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
    const bodyRows = Math.max(3, termRows - DETAIL_CHROME)
    const listRows = Math.max(3, termRows - LIST_CHROME)

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

    // ── list mode ──────────────────────────────────────────────────────────
    if (mode === 'list') {
      const rows = [h(Text, { key: 'title', bold: true, color: 'cyan' }, t('list-title', { count: children.length }))]
      if (children.length === 0) {
        rows.push(h(Text, { key: 'empty', dimColor: true }, t('list-empty')))
      } else {
        const start = Math.max(0, Math.min(cursor - listRows + 1, children.length - listRows))
        const windowed = children.slice(Math.max(0, start), Math.max(0, start) + listRows)
        windowed.forEach((child, index) => {
          const absolute = Math.max(0, start) + index
          rows.push(
            h(
              Text,
              { key: shortId(child) || String(absolute), inverse: absolute === cursor, wrap: 'truncate' },
              `${absolute === cursor ? '❯ ' : '  '}${formatChildRow(child, t)}`,
            ),
          )
        })
      }
      rows.push(h(Text, { key: 'hint', dimColor: true }, t('list-hint')))
      return h(Box, { flexDirection: 'column', paddingX: 1 }, ...rows)
    }

    // ── detail mode ────────────────────────────────────────────────────────
    const current = children.find((child) => normalizeId(child.id) === detailId)
    const label = current === undefined ? (detailId ?? '').slice(0, 8) : (childLabel(current) || shortId(current))
    const running = current?.activity === 'running'
    const header = h(
      Text,
      { key: 'header', bold: true, color: 'cyan' },
      `${t('detail-title', { label })}  ${running ? t('detail-live') : t('detail-archived')} · ${t('detail-readonly')}`,
    )

    const body = []
    if (status === 'loading') {
      body.push(h(Text, { key: 'loading', dimColor: true }, t('detail-loading')))
    } else if (status !== '' && status !== 'ready') {
      body.push(h(Text, { key: 'error', color: 'red' }, t('detail-load-failed', { err: status })))
    } else {
      if (fold.rows.length === 0 && fold.liveText === '' && fold.liveReasoning === '') {
        body.push(h(Text, { key: 'none', dimColor: true }, t('detail-empty')))
      }
      const start = follow ? Math.max(0, fold.rows.length - bodyRows) : scroll
      const visible = fold.rows.slice(start, start + bodyRows)
      visible.forEach((row, index) => {
        body.push(
          h(
            Text,
            { key: `r${start + index}`, color: ROW_COLORS[row.kind], dimColor: row.kind === 'reasoning' || row.kind === 'meta' || row.kind === 'tool-result', wrap: 'wrap' },
            row.text,
          ),
        )
      })
      // In-flight stream tail.
      if (fold.liveReasoning !== '') {
        body.push(h(Text, { key: 'live-r', dimColor: true, wrap: 'wrap' }, fold.liveReasoning))
      }
      if (fold.liveText !== '') {
        body.push(h(Text, { key: 'live-t', wrap: 'wrap' }, fold.liveText))
      }
    }
    body.push(h(Text, { key: 'hint', dimColor: true }, t('detail-hint')))
    return h(Box, { flexDirection: 'column', paddingX: 1 }, header, ...body)
  }
}
