# ADR-003: Full Parity Uses Three Presentation Levels

## Decision

Full Parity 由 Native GUI、Generic Remote UI 和 TUI Compatibility 三层共同提供。

## Consequences

- 所有 OMP 内置能力必须 Native；
- 标准扩展无需定制页面即可使用；
- arbitrary custom TUI 仍在 Studio 内可达；
- Full Parity 表示能力可达和语义正确，不表示所有第三方 TUI 都被翻译成 React。

