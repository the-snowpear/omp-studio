# Review Notes for Codex

Please attack the architecture rather than merely confirming it.

Highest-risk assumptions:

1. Is a multi-channel Capability Broker justified, or is it over-engineering?
2. Are any proposed fallback channels capable of changing semantics relative to real OMP?
3. Is slash-command-over-RPC sufficiently deterministic for the proposed uses?
4. Which current OMP capabilities have a better native API than this pack assumes?
5. Which features listed as gaps are already reachable through existing RPC events/commands?
6. Can a Companion Extension safely reach Agent Hub operations using supported extension APIs, or would it require private imports?
7. Is the experimental Collab adapter a bad architectural dependency even as a temporary fallback?
8. Does one active Thread per OMP process remain the correct isolation model?
9. Can project config writes preserve OMP merge/precedence behavior correctly?
10. Are provider/model/MCP/profile path rules complete across platforms?
11. Does the plan accidentally create a second source of truth for OMP state?
12. What is the smallest upstream RPC patch set that would eliminate most compatibility code?
13. Are Host Tools the correct boundary for Preview/browser integration?
14. Are there OMP subsystems omitted from the capability matrix?
15. Which TUI-only extension surfaces should Studio explicitly refuse to emulate?

Review against current OMP source, not historical assumptions.
