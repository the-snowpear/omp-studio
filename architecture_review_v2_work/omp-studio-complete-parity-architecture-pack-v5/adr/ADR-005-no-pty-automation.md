# ADR-005: PTY Is Never an Automation API

## Decision

PTY 只承载真实用户的 TUI 操作和终端展示。Studio 自动控制永远使用 typed Bridge operation。

## Consequences

- 不使用 row/focus/key macro；
- 不从 ANSI/回显推断成功；
- arbitrary TUI 仍可人工访问；
- 需要 shared semantic services 和 Remote UI；
- PTY 断开不影响 Runtime semantic channel。

