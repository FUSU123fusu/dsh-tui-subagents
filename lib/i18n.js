/**
 * dsh-tui-subagents i18n — zh (default) / en, flat dict with {{name}} params.
 *
 * Language resolution follows the dsh-TUI surface this plugin lives in:
 * `DSH_TUI_LANG` (pinned at TUI start) over `CC_TUI_LANG`, then the persisted
 * `/lang` choice in ~/.dsh-tui/lang.json, else zh.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dict = {
  'cmd-desc': { zh: '查看子 agent：列出并实时观察子 agent 轨迹（只读）', en: 'Subagent viewer: list and watch subagent trajectories live (read-only)' },
  'tree-desc': { zh: '查看子 agent 轨迹', en: 'Watch subagent trajectories' },

  'not-mounted': { zh: '子代理服务未挂载（当前组合没有 subagent 能力）', en: 'Subagent service is not mounted in this composition' },
  'none': { zh: '当前会话没有子 agent', en: 'No subagents in this session' },
  'query-failed': { zh: '子代理查询失败：{{err}}', en: 'Subagent query failed: {{err}}' },
  'no-scene-host': { zh: '当前宿主不支持全屏界面（需要 dsh-TUI），改用文本列表：', en: 'This host has no full-screen scene support (needs dsh-TUI); falling back to a text list:' },
  'id-not-found': { zh: '没有 id 以「{{prefix}}」开头的子 agent', en: 'No subagent whose id starts with "{{prefix}}"' },
  'id-ambiguous': { zh: '「{{prefix}}」匹配到多个子 agent，请输入更长的前缀', en: '"{{prefix}}" matches several subagents; type a longer prefix' },

  'mode-continuable': { zh: '可续', en: 'continuable' },
  'mode-oneshot': { zh: '一次性', en: 'one-shot' },
  'activity-running': { zh: '运行中', en: 'running' },
  'activity-inactive': { zh: '已归档', en: 'archived' },
  'row': { zh: '{{mode}} {{label}}{{activity}} · {{id}}', en: '{{mode}} {{label}}{{activity}} · {{id}}' },

  'list-title': { zh: '子 agent（{{count}}）', en: 'Subagents ({{count}})' },
  'list-empty': { zh: '当前会话没有子 agent。按 r 刷新，Esc 退出。', en: 'No subagents in this session. r to refresh, Esc to quit.' },
  'list-hint': { zh: '↑/↓ 选择 · Enter 查看轨迹 · r 刷新 · Esc 退出', en: '↑/↓ select · Enter watch · r refresh · Esc quit' },

  'detail-title': { zh: '轨迹：{{label}}', en: 'Trajectory: {{label}}' },
  'detail-hint': { zh: '↑/↓ 滚动 · PgUp/PgDn 翻页 · G 到末尾 · Esc 返回列表', en: '↑/↓ scroll · PgUp/PgDn page · G jump to end · Esc back to list' },
  'detail-loading': { zh: '加载轨迹中…', en: 'Loading trajectory…' },
  'detail-load-failed': { zh: '轨迹加载失败：{{err}}', en: 'Failed to load the trajectory: {{err}}' },
  'detail-empty': { zh: '（还没有任何事件）', en: '(no events yet)' },
  'detail-live': { zh: '● 实时', en: '● live' },
  'detail-archived': { zh: '○ 已结束', en: '○ finished' },
  'detail-readonly': { zh: '只读', en: 'read-only' },

  'turn-sep': { zh: '── 第 {{turn}} 轮 ──', en: '── turn {{turn}} ──' },
  'turn-interrupted': { zh: '⚠ 本轮被中断（{{kind}}）', en: '⚠ turn interrupted ({{kind}})' },
  'src-user': { zh: '用户', en: 'user' },
  'src-coordinator': { zh: '主 agent', en: 'parent agent' },
  'src-skill': { zh: '技能', en: 'skill' },
  'model-tag': { zh: '模型 {{model}}', en: 'model {{model}}' },
  'descriptor-tag': { zh: '子 agent「{{label}}」· {{mode}} · {{provider}}', en: 'subagent "{{label}}" · {{mode}} · {{provider}}' },
  'tool-result-error': { zh: '✗ 工具出错：{{err}}', en: '✗ tool error: {{err}}' },
  'compaction-tag': { zh: '⟳ 上下文压缩', en: '⟳ compaction' },
}

const LANGS = new Set(['zh', 'en'])

function isLang(value) {
  return typeof value === 'string' && LANGS.has(value)
}

/**
 * Resolve the active language: env vars first (the TUI pins DSH_TUI_LANG at
 * start), then the persisted /lang choice, else zh.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {(path: string) => string} [readFile] - injectable for tests.
 */
export function detectLang(env = process.env, readFile = readFileSync) {
  if (isLang(env.DSH_TUI_LANG)) return env.DSH_TUI_LANG
  if (isLang(env.CC_TUI_LANG)) return env.CC_TUI_LANG
  try {
    const parsed = JSON.parse(readFile(join(homedir(), '.dsh-tui', 'lang.json'), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && isLang(parsed.lang)) return parsed.lang
  } catch {
    // No readable lang pref — fall through to the default.
  }
  return 'zh'
}

/**
 * Translate `key` in `lang`, substituting {{name}} placeholders. Missing keys
 * render the key itself so a typo is visible instead of silently blank.
 */
export function createT(lang) {
  return (key, params = {}) => {
    const entry = dict[key]
    const template = entry?.[lang] ?? entry?.zh ?? key
    return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
      name in params ? String(params[name]) : match)
  }
}
