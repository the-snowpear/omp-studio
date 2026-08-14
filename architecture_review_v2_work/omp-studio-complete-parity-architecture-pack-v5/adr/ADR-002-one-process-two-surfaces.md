# ADR-002: One OMP Process, Two User Surfaces

## Decision

GUI 与 TUI 必须连接同一个 OMP process、AgentSession 和 SessionManager。GUI 使用 Studio Bridge，TUI 使用 PTY。

## Consequences

- 没有 RPC/TUI session 双写；
- arbitrary TUI 仍可使用；
- 需要 Input & Command Arbiter；
- Studio Bridge 必须是 side channel，不能占用 TUI stdin。

## Alternatives rejected

- RPC Runtime 缺能力时启动 TUI：没有安全 handoff/checkpoint/owner lock；
- 将 TUI 输出解析成事件：无法证明语义；
- 只运行 TUI并用宏控制：焦点、modal和时序不可验证。

