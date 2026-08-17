# dsh-tui-subagents

dsh-TUI 的子 agent 会话视图：`/subagents` 列出当前会话的子 agent，Enter 进入全屏轨迹视图，**实时**跟着子 agent 的思考、工具调用和回复滚动；对**可续（continuable）**子 agent 可以直接发消息纠偏、中断当前轮。对应上游 issue [dsh-TUI#223](https://github.com/ccch1mneyyy/dsh-TUI/issues/223)。

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
| e | 展开/收起思考 |
| i | 给可续子 agent 发消息（排入其下一个 turn） |
| x | 中断运行中子 agent 的当前轮 |
| G | 跳到末尾并恢复实时跟随 |
| Esc | 返回列表（列表里再按退出） |

一次性（one-shot）子 agent 保持只读，与官方 Web 端行为一致。

列表视图：↑/↓ 选择 · Enter 查看 · r 刷新 · Esc 退出。

## 原理

- 子 agent 与会话事件走同一个 cordis 事件树：插件在根作用域监听 `session/event`，按 session id 过滤出目标子 agent 的事件流（`assistant/chunk` 逐 token、`tool/call`、`tool/result`、思考流全有）。
- 历史回填：子 agent 存活时读 live session 快照；已归档时走 `sessionPersistence.inspect()` 非破坏读取（不会 resume 子 agent）。
- 发消息走 `ctx.subagents.followup(parent, childId, blocks)`（用户身份 source，排队不抢断当前 turn）；中断走 `ctx.subagents.interrupt(childId, { kind: 'user', parentSessionId })`。
- UI 走 dsh-TUI 的 scene 注册缝（`tuiScenes`），全屏展示，崩溃只关界面不拖垮 TUI；流式渲染 50ms 帧对齐节流。
- 机制层零改动：全部走 dsh 本体既有宿主服务（in-process cordis）。

宿主不支持 scene（web、headless）时退化为文本列表，和内置 `/agents` 一致。

## 安装

```
dsh plugin --profile <你的profile> add dsh-tui-subagents
```

或从源码：`npm pack` 后 `dsh plugin --profile <你的profile> add file:<tgz路径>`。

## 开发

```
node --test              " 单元测试（事件折叠、列表解析、视口切片）
node scratch/replay-real-log.mjs <session目录>   " 用真实 session 日志冒烟
```

---

## English

A subagent session view for dsh-TUI. `/subagents` lists the current session's subagents; Enter opens a full-screen trajectory that backfills from the persisted log and follows the child live — reasoning, tool calls, and replies as they stream. Continuable subagents accept follow-up messages (`i`) and turn interrupts (`x`); one-shots stay read-only, matching the official Web UI. Implements [dsh-TUI#223](https://github.com/ccch1mneyyy/dsh-TUI/issues/223).

- Realtime via the cordis `session/event` feed (child-scope events bubble up the scope tree), 50ms frame-aligned re-renders.
- Backfill via the live session snapshot or a non-mutating `sessionPersistence.inspect()` (never resumes the child).
- Messaging via `ctx.subagents.followup`; interrupts via `ctx.subagents.interrupt` with user authority.
- Full-screen UI through the host's `tuiScenes` seam; degrades to the plain text list on hosts without it.
- Zero mechanism-layer change: everything rides existing dsh host services.

MIT
