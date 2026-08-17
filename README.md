# dsh-tui-subagents

dsh-TUI 的只读子 agent 观察器：`/subagents` 列出当前会话的子 agent，Enter 进入全屏轨迹视图，**实时**跟着子 agent 的思考、工具调用和回复滚动。

[English](#english) below.

## 用法

```
/subagents            " 列出当前会话的子 agent，选择后进入轨迹视图
/subagents a1b2       " 按 id 前缀直接进入某个子 agent 的轨迹
```

轨迹视图按键：

| 键 | 作用 |
|---|---|
| ↑ / ↓ | 滚动（滚动后退出跟随模式） |
| PgUp / PgDn | 翻页 |
| G | 跳到末尾并恢复实时跟随 |
| Esc | 返回列表（列表里再按退出） |

列表视图：↑/↓ 选择 · Enter 查看 · r 刷新 · Esc 退出。

## 原理

- 子 agent 与会话事件走同一个 cordis 事件树：插件在根作用域监听 `session/event`，按 session id 过滤出目标子 agent 的事件流（`assistant/chunk` 逐 token、`tool/call`、`tool/result`、思考流全有）。
- 历史回填：子 agent 存活时读 live session 快照；已归档时走 `sessionPersistence.inspect()` 非破坏读取（不会 resume 子 agent）。
- UI 走 dsh-TUI 的 scene 注册缝（`tuiScenes`），全屏展示，崩溃只关界面不拖垮 TUI。
- **只读**：不调用 `followup`/`interrupt`，不向子 agent 注入任何东西。

宿主不支持 scene（web、headless）时退化为文本列表，和内置 `/agents` 一致。

## 安装

```
dsh plugin --profile <你的profile> add dsh-tui-subagents
```

或从源码：`npm pack` 后 `dsh plugin --profile <你的profile> add file:<tgz路径>`。

## 开发

```
node --test              " 单元测试（事件折叠、列表解析）
node scratch/replay-real-log.mjs <session目录>   " 用真实 session 日志冒烟
```

---

## English

A read-only live subagent viewer for dsh-TUI. `/subagents` lists the current session's subagents; Enter opens a full-screen trajectory view that backfills from the persisted session log and then follows the child live — reasoning, tool calls, and replies as they stream.

- Realtime via the cordis `session/event` feed (child-scope events bubble up the scope tree).
- Backfill via the live session snapshot or a non-mutating `sessionPersistence.inspect()` (never resumes the child).
- Full-screen UI through the host's `tuiScenes` seam; degrades to the plain text list on hosts without it.
- Read-only: never calls `followup`/`interrupt`, injects nothing.

Keys: ↑/↓ scroll · PgUp/PgDn page · G jump to end and re-follow · Esc back/quit.

MIT
