# Known Gaps and Honest Limits

The architecture can cover substantially more than ACP or RPC alone, but "100%" needs a precise definition.

## 1. Harness behavior vs TUI presentation

Studio targets OMP harness capability parity, not pixel/primitive parity with OMP's terminal UI.

An extension that renders an arbitrary custom TUI component cannot automatically be converted into React. Standard rpc-ui requests can be mapped; unknown custom TUI primitives require an explicit compatibility contract or terminal fallback.

## 2. Private internal APIs

Some Agent Hub controls exist inside OMP but are not public RPC commands. A Companion Extension may bridge them, but any private import is version-sensitive and therefore experimental. It is acceptable only as a quarantined exact-version POC.

## 3. Discovery exactness

Raw filesystem scans cannot always reproduce OMP's effective resolved discovery because precedence, plugin contributions, source toggles and runtime state matter. When a structured OMP introspection surface is absent, Studio must label a view as "configured" rather than "effective".

## 4. Active-session state cannot be controlled through config files

Saving a setting does not guarantee a running session immediately changes. Studio must model immediate/reload/new-session/restart effects.

## 5. No direct mutation of OMP private stores

Studio intentionally refuses to edit `agent.db` or active session JSONL even if doing so might unlock a feature. Safety and state correctness take priority.

## 6. Experimental Collab dependency

Collab agent commands are evidence and a possible temporary transport, not a stable long-term first-party API. It should not become a core dependency.

## 7. OMP changes rapidly

Capability negotiation, real-build integration tests and upstream collaboration are required. Static docs/version assumptions will age quickly.

## 8. No generic RPC tool invocation

Except for dedicated commands such as `bash`, Studio cannot turn arbitrary OMP
tools (LSP, DAP, browser, computer, task/hub, memory, etc.) into deterministic
GUI buttons. OMP can execute them through the Agent and Studio can observe the
events, but direct GUI control requires dedicated upstream RPC.

## 9. TUI-only session and collaboration flows

Full tree picker, fork/drop/clear/resume selectors, current-process collab
start/stop/participants and arbitrary custom TUI components do not have public
rpc-ui equivalents. Do not claim full GUI parity for these surfaces.

## Definition of success

A feature is considered covered when Studio can accurately expose the surfaces that make sense for that feature:

- Execute,
- Observe,
- Control,
- Configure,
- Diagnose.

Not every feature requires all five. For example, a TTSR stream rule may need configuration + observation, not a dedicated "run now" button.
