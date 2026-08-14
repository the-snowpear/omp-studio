# Slash Command Adapter

## Motivation

OMP has deterministic local slash commands that may expose runtime behavior before a dedicated RPC command exists. RPC itself supports available-command discovery and side-channel command output.

## Safe use

Discovery is necessary but not sufficient: metadata does not declare
`headlessSafe`, idempotency, model invocation or side effects. The adapter
executes only exact commands that are both discovered and present in a
pinned-build Studio manifest describing handler kind, arguments, risk tier,
completion policy and concurrency policy. Extension commands require an
explicit trusted package identity; project commands cannot shadow privileged
Studio routes.

Example abstract call:

```ts
await slash.invoke({
  threadId,
  command: "advisor",
  args: ["status"],
});
```

Implementation sends the canonical slash command through RPC prompt handling and waits for local command completion semantics rather than an agent turn.

Completion must use the route manifest: matching `prompt_result`,
`command_output/config_update`, an explicit event predicate, or a direct
response. Silence, spinner timeout and non-terminal `agent_end` are never proof
of completion. Commands without reliable correlation are single-flight. User
cancellation, elicitation timeout and `runtimeEpoch` change produce explicit
ledger outcomes.

## Never do this

```text
"Please turn on the advisor and then tell me whether it worked."
```

That is model-mediated and nondeterministic.

## Interactive commands

When a slash command requests selection/input/confirmation, `--mode rpc-ui` may emit Extension UI requests. Studio should render them as native forms and return the corresponding response.

## Discovery

Use `get_available_commands` and `available_commands_update`. UI command palettes should reflect the live process, including commands contributed by extensions and skills.

## Compatibility

Do not hard-code a command merely because one OMP version had it. The adapter's route is active only when discovery confirms the command/subcommand or a version-specific probe succeeds.
