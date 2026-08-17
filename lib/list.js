/**
 * list.js — subagent list helpers: id normalization, prefix resolution, and
 * row formatting. Pure; shared by the command handler, the scene, and tests.
 */

/** Session ids arrive as plain strings or `{ value }` branded objects. */
export function normalizeId(id) {
  if (typeof id === 'string') return id
  if (id !== null && typeof id === 'object' && typeof id.value === 'string') return id.value
  return ''
}

/**
 * Resolve a user-typed id prefix against the child list.
 * Returns { status: 'ok', id } | { status: 'not-found' } | { status: 'ambiguous' }.
 * An empty prefix never matches.
 */
export function resolvePrefix(prefix, children) {
  const needle = prefix.trim().toLowerCase()
  if (needle === '') return { status: 'not-found' }
  const matches = children.filter((child) => normalizeId(child.id).toLowerCase().startsWith(needle))
  if (matches.length === 0) return { status: 'not-found' }
  const exact = matches.find((child) => normalizeId(child.id).toLowerCase() === needle)
  if (exact !== undefined) return { status: 'ok', id: normalizeId(exact.id) }
  if (matches.length > 1) return { status: 'ambiguous' }
  return { status: 'ok', id: normalizeId(matches[0].id) }
}

/** Display label of one child row: 「label」 or a bare fallback. */
export function childLabel(child) {
  const label = typeof child.label === 'string' ? child.label.trim() : ''
  return label === '' ? '' : `「${label}」`
}

/** One-line row, the same shape the built-in /agents prints. */
export function formatChildRow(child, t) {
  const id = normalizeId(child.id).slice(0, 8)
  const mode = child.mode === 'continuable' ? t('mode-continuable') : t('mode-oneshot')
  const activity = child.activity === 'running' ? t('activity-running') : t('activity-inactive')
  return t('row', { mode, label: childLabel(child), activity, id })
}

/** Sort/identify helper: stable short id for React keys and matching. */
export function shortId(child) {
  return normalizeId(child.id).slice(0, 8)
}
