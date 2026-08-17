/**
 * dsh-tui-subagents — a read-only live subagent viewer inside dsh-TUI:
 * `/subagents` lists the current session's subagents and opens a full-screen
 * scene that backfills a child's trajectory from persistence, then follows it
 * in real time through the cordis `session/event` feed.
 *
 * Cordis plugin contract: `name` + `apply`, no default export, zero runtime
 * dependencies. Service timing is handled by the row's `inject` (see
 * cordis.patch.yml): cordis activates service fibers asynchronously, so a
 * plain row's apply() would run before `commands` is readable and the
 * registration would silently no-op. The host-only seams (`tuiScenes`,
 * `tuiCommandTrees`) are runtime probes — only dsh-TUI hosts provide them,
 * and the command degrades to a plain text list without them.
 * @module dsh-tui-subagents
 */

import { createT, detectLang } from './i18n.js'
import { formatChildRow, normalizeId, resolvePrefix } from './list.js'
import { createSceneComponent } from './scene.js'

export const name = 'dsh-tui-subagents'

const SCENE_ID = 'subagents'

/** Mutable bridge between the command handler and the mounted scene. */
function createStore() {
  const listeners = new Set()
  return {
    data: { parentId: undefined, children: [], selectedId: undefined },
    set(patch) {
      Object.assign(this.data, patch)
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/**
 * Host-facing operations the scene needs. Everything probes its service at
 * call time so a composition missing one seam degrades instead of crashing.
 */
function createApi(ctx) {
  const eventListeners = new Set()
  const lifecycleListeners = new Set()

  // One cordis subscription fanning out to every mounted consumer. Child
  // sessions live in child scopes; cordis events bubble up the scope tree,
  // so this root-scope listener sees subagent events too.
  ctx.on('session/event', (session, event) => {
    const sessionId = normalizeId(session?.id)
    for (const listener of eventListeners) listener(sessionId, event)
  })
  for (const name of ['subagent/start', 'subagent/end']) {
    ctx.on(name, () => {
      for (const listener of lifecycleListeners) listener()
    })
  }

  return {
    /** List direct children of the parent session; undefined on failure. */
    async listChildren(parentId) {
      if (parentId === undefined) return undefined
      const subagents = ctx.get('subagents', false)
      if (subagents === undefined) return undefined
      try {
        return await subagents.listChildren(parentId)
      } catch {
        return undefined
      }
    },

    /**
     * Backfill a child's event log: the live session's immutable snapshot
     * when resident, else a non-mutating persistence inspection.
     */
    async loadEvents(id) {
      const sessions = ctx.get('sessions', false)
      const live = sessions?.get?.(id)
      if (live !== undefined) return live.events
      const persistence = ctx.get('sessionPersistence', false)
      if (persistence === undefined) return []
      const view = await persistence.inspect(id)
      return view.events
    },

    subscribeEvents(listener) {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },

    subscribeLifecycle(listener) {
      lifecycleListeners.add(listener)
      return () => lifecycleListeners.delete(listener)
    },
  }
}

/**
 * Wire the plugin: register the `/subagents` command with the dsh-commands
 * registry and its completion tree with the TUI seam.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const t = createT(detectLang())
  // With the row's inject this is always present at apply time; the guard
  // only covers direct imports (tests, exotic hosts).
  const commands = ctx.get('commands', false)
  if (commands === undefined) return

  const store = createStore()
  const api = createApi(ctx)
  let sceneRegistered = false

  const ensureScene = () => {
    if (sceneRegistered) return true
    const scenes = ctx.get('tuiScenes', false)
    if (scenes === undefined) return false
    scenes.register({
      id: SCENE_ID,
      title: 'subagents',
      component: createSceneComponent({ store, api, t }),
    })
    sceneRegistered = true
    return true
  }

  commands.register({
    name: 'subagents',
    description: t('cmd-desc'),
    input: { hint: '[<id>]' },
    handler: async ({ agent, rawInput }) => {
      const parentId = normalizeId(agent?.session?.id)
      const subagents = ctx.get('subagents', false)
      if (subagents === undefined) return { kind: 'error', text: t('not-mounted') }

      let children
      try {
        children = await subagents.listChildren(parentId)
      } catch (error) {
        return { kind: 'error', text: t('query-failed', { err: error instanceof Error ? error.message : String(error) }) }
      }
      if (children.length === 0) return { kind: 'success', text: t('none') }

      // Optional id prefix: jump straight into one child's trajectory.
      const prefix = (rawInput ?? '').trim()
      let selectedId
      if (prefix !== '') {
        const resolved = resolvePrefix(prefix, children)
        if (resolved.status === 'not-found') return { kind: 'error', text: t('id-not-found', { prefix }) }
        if (resolved.status === 'ambiguous') return { kind: 'error', text: t('id-ambiguous', { prefix }) }
        selectedId = resolved.id
      }

      store.set({ parentId, children, selectedId })

      // Hosts without the scene seam (web, headless) get the plain list.
      if (!ensureScene() || !ctx.get('tuiScenes', false).open(SCENE_ID)) {
        const lines = [t('no-scene-host'), ...children.map((child) => formatChildRow(child, t))]
        return { kind: 'success', text: lines.join('\n') }
      }
      // Silent success: the scene is the feedback; the transcript stays clean.
      return { kind: 'success' }
    },
  })

  // Tab completion + localized description (host seam; absent on non-TUI hosts).
  const trees = ctx.get('tuiCommandTrees', false)
  trees?.register({
    root: 'subagents',
    descriptions: { zh: '查看子 agent：列出并实时观察轨迹（只读）', en: 'Subagent viewer: list and watch trajectories live (read-only)' },
    children: () => [],
  })
}
