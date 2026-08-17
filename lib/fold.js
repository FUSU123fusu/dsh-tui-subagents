/**
 * fold.js — fold one subagent session's event stream into display rows.
 *
 * Pure logic, zero cordis/React imports: node:test drives it headless, and
 * the scene replays a persisted log through the exact same path live events
 * take, so backfill and streaming can never drift apart.
 *
 * Row shape: { kind, text, at }
 *   kind: 'meta' | 'turn' | 'user' | 'assistant' | 'reasoning'
 *       | 'tool' | 'tool-result' | 'error'
 *
 * Streaming text arrives as `assistant/chunk` deltas and accumulates in
 * `liveText` / `liveReasoning`; the scene renders those buffers as the
 * in-progress tail. They are flushed into real rows at the next structural
 * boundary (user message, tool call, assistant message, step/turn end).
 */

/** Collapse whitespace and cut to `max` chars with an ellipsis. */
export function brief(text, max = 160) {
  if (typeof text !== 'string') return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** Extract joined text from a message content array (or plain string). */
export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  const joined = parts.join('\n')
  return joined === '' ? undefined : joined
}

/**
 * Extract a tool result's text. `tool/result` wraps its payload in a
 * `tool-result` content block whose own content carries the text blocks.
 */
export function textOfToolResult(content) {
  if (!Array.isArray(content)) return undefined
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'tool-result') {
      const inner = textOfContent(block.content)
      if (inner !== undefined) parts.push(inner)
    } else if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  const joined = parts.join('\n')
  return joined === '' ? undefined : joined
}

export function createFoldState() {
  return {
    /** Committed display rows. */
    rows: [],
    /** In-flight assistant text buffer (not yet a row). */
    liveText: '',
    /** In-flight reasoning buffer. */
    liveReasoning: '',
    /** Highest event seq folded so far — live dedup gate. */
    lastSeq: -1,
    /** Last model announced, so request/context repeats don't spam rows. */
    model: undefined,
    /** True once any assistant/chunk was seen in the current step. */
    sawChunks: false,
  }
}

/** Flush both live buffers into committed rows. Returns true on change. */
export function flush(state) {
  let changed = false
  if (state.liveReasoning.trim() !== '') {
    state.rows.push({ kind: 'reasoning', text: state.liveReasoning })
    changed = true
  }
  state.liveReasoning = ''
  if (state.liveText.trim() !== '') {
    state.rows.push({ kind: 'assistant', text: state.liveText })
    changed = true
  }
  state.liveText = ''
  return changed
}

function flushReasoningOnly(state) {
  if (state.liveReasoning.trim() === '') {
    state.liveReasoning = ''
    return false
  }
  state.rows.push({ kind: 'reasoning', text: state.liveReasoning })
  state.liveReasoning = ''
  return true
}

const SRC_KEYS = { user: 'src-user', coordinator: 'src-coordinator', 'skill-invocation': 'src-skill' }

/**
 * Fold one event into the state. Returns true when anything visible changed
 * (rows appended or live buffers mutated) so the scene can skip no-op renders.
 *
 * @param {ReturnType<typeof createFoldState>} state
 * @param {{ type: string, seq?: number, time?: number, data?: unknown }} event
 * @param {(key: string, params?: Record<string, unknown>) => string} t
 */
export function foldEvent(state, event, t) {
  if (event === null || typeof event !== 'object') return false
  if (typeof event.seq === 'number') {
    if (event.seq <= state.lastSeq) return false
    state.lastSeq = event.seq
  }
  const data = event.data === null || typeof event.data !== 'object' ? {} : event.data
  const at = typeof event.time === 'number' ? event.time : undefined

  switch (event.type) {
    case 'turn/start': {
      flush(state)
      state.sawChunks = false
      const turn = typeof data.turn === 'number' ? data.turn : 0
      state.rows.push({ kind: 'turn', text: t('turn-sep', { turn }), at })
      return true
    }

    case 'turn/end': {
      const changed = flush(state)
      const kind = data.reason !== null && typeof data.reason === 'object' ? data.reason.kind : undefined
      if (typeof kind === 'string' && kind !== 'completed') {
        state.rows.push({ kind: 'error', text: t('turn-interrupted', { kind }), at })
        return true
      }
      return changed
    }

    case 'step/start': {
      state.sawChunks = false
      return false
    }

    case 'step/end': {
      state.sawChunks = false
      return flush(state)
    }

    case 'user/message': {
      const text = textOfContent(data.content)
      if (text === undefined || text.trim() === '') return false
      flush(state)
      const sourceKind = data.source !== null && typeof data.source === 'object' ? data.source.kind : undefined
      // Human and parent-agent messages are conversation; everything else
      // (runtime context, skill catalog, hook notices) is injection noise —
      // fold it to a one-line meta row instead of a wall of text.
      if (sourceKind !== 'user' && sourceKind !== 'coordinator' && sourceKind !== undefined) {
        const key = SRC_KEYS[sourceKind] ?? null
        const tag = key !== null ? t(key) : sourceKind
        state.rows.push({ kind: 'inject', text: t('inject-tag', { src: tag, chars: text.length }), at })
        return true
      }
      const tag = sourceKind === 'coordinator' ? t('src-coordinator') : t('src-user')
      state.rows.push({ kind: 'user', tag, text, at })
      return true
    }

    case 'assistant/chunk': {
      const chunk = data.chunk
      if (chunk === null || typeof chunk !== 'object' || typeof chunk.text !== 'string') return false
      state.sawChunks = true
      if (chunk.type === 'reasoning-delta') {
        state.liveReasoning += chunk.text
        return true
      }
      if (chunk.type === 'text-delta') {
        // Reasoning always precedes text in a step: a text delta seals it.
        flushReasoningOnly(state)
        state.liveText += chunk.text
        return true
      }
      return false
    }

    case 'assistant/message': {
      // When chunks already streamed this step, the buffers hold the same
      // content — flush and skip the final message to avoid duplication.
      if (state.liveText !== '' || state.liveReasoning !== '') {
        return flush(state)
      }
      if (state.sawChunks) return false
      const message = data.message
      const content = message !== null && typeof message === 'object' ? message.content : undefined
      if (!Array.isArray(content)) return false
      let pushed = false
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue
        if (typeof block.text !== 'string' || block.text.trim() === '') continue
        if (block.type === 'reasoning') {
          state.rows.push({ kind: 'reasoning', text: block.text, at })
          pushed = true
        } else if (block.type === 'text') {
          state.rows.push({ kind: 'assistant', text: block.text, at })
          pushed = true
        }
      }
      return pushed
    }

    case 'tool/call': {
      flush(state)
      const name = typeof data.name === 'string' ? data.name : 'tool'
      const args = typeof data.arguments === 'string' ? brief(data.arguments, 200) : ''
      state.rows.push({ kind: 'tool', name, args, text: `${name}${args === '' ? '' : ` ${args}`}`, at })
      return true
    }

    case 'tool/result': {
      const message = data.message
      const content = message !== null && typeof message === 'object' ? message.content : undefined
      // Errors surface either as data.error or as an isError tool-result block.
      const blockError = Array.isArray(content) && content.some(
        (block) => block !== null && typeof block === 'object' && block.type === 'tool-result' && block.isError === true,
      )
      const errorText = typeof data.error === 'string' ? data.error
        : data.error !== null && typeof data.error === 'object' && typeof data.error.message === 'string' ? data.error.message
        : undefined
      const resultText = textOfToolResult(content)
      if (errorText !== undefined) {
        state.rows.push({ kind: 'error', text: t('tool-result-error', { err: brief(errorText, 200) }), at })
        return true
      }
      if (resultText === undefined) return false
      if (blockError) {
        state.rows.push({ kind: 'error', text: brief(resultText, 200), at })
      } else {
        state.rows.push({ kind: 'tool-result', text: brief(resultText, 240), at })
      }
      return true
    }

    case 'request/context': {
      const model = typeof data.model === 'string' && data.model !== '' ? data.model : undefined
      if (model === undefined || model === state.model) return false
      state.model = model
      state.rows.push({ kind: 'meta', text: t('model-tag', { model }), at })
      return true
    }

    case 'subagent/descriptor': {
      const label = typeof data.label === 'string' && data.label.trim() !== '' ? data.label.trim() : '?'
      const mode = typeof data.mode === 'string' ? data.mode : '?'
      const provider = typeof data.provider === 'string' ? data.provider : '?'
      state.rows.push({ kind: 'meta', text: t('descriptor-tag', { label, mode, provider }), at })
      return true
    }

    default: {
      if (typeof event.type === 'string' && event.type.startsWith('compaction/')) {
        flush(state)
        state.rows.push({ kind: 'meta', text: t('compaction-tag'), at })
        return true
      }
      return false
    }
  }
}

/** Fold a whole persisted log (backfill) in order. */
export function foldAll(events, t) {
  const state = createFoldState()
  for (const event of events) foldEvent(state, event, t)
  flush(state)
  return state
}
