# Recommended Module Tree

```text
apps/
  desktop/
    main/
    preload/
    renderer/
  web/
  host/

packages/
  protocol/
    commands/
    queries/
    durable-events/
    streams/
    versioning/

  domain/
    environment/
    project/
    workspace/
    thread/
    run/
    message/
    agent-projection/
    approval/
    change/
    preview/

  application/
    command-orchestrator/
    runtime-ingestion/
    recovery/
    receipt-registry/

  host-authority/
    discovery/
    lease/
    fencing/
    process-reaper/

  command-ledger/
  event-journal/
  read-models/
  push/
    durable-push/
    stream-mux/
    backpressure/

  runtime-gateway/
    contracts/
    session-binding/
    runtime-actor/
    launch-plan/
    capability-router/

  omp-rpc/
  omp-slash/
  omp-config/
  omp-cli/
  omp-companion-introspection/
  omp-collab-experimental/
  omp-sdk-backend/

  capabilities/
    descriptors/
    slash-manifest/
    debt-registry/
    fingerprint/

  environment/
  workspace/
  git/
    worktrees/
    diff/
    snapshots/
  terminal/
    authorization/
    spool/
  preview/
    supervisor/
    proxy/
    browser/
  security/
    auth/
    grants/
    execution-policy/
    path-policy/
    content-sanitization/
    secrets/
  diagnostics/
  telemetry/

  testkit/
    fake-omp/
    real-omp-harness/
    protocol-conformance/
    compatibility-matrix/
    chaos/
    security/
```

## Dependency direction

```text
domain <- application <- protocol handlers/apps
domain <- gateway contracts <- gateway implementations

domain must not import:
  Electron, WebSocket, HTTP, OMP RPC, Slash, CLI, Config, Companion, Collab

application may import:
  domain, gateway contracts, ledger/receipt interfaces

OMP adapters may import:
  runtime-gateway contracts and OMP-specific libraries

Renderer may import:
  generated protocol types and shared presentation types only
```

Circular dependencies between `domain`, `application`, `runtime-gateway`, and
`protocol` are architecture-test failures.

