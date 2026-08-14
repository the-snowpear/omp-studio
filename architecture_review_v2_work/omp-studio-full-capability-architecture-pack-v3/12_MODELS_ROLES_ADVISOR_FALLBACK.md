# Models, Providers, Roles, Advisor and Fallback

## Providers and models

Runtime availability should come from real OMP model resolution:

- RPC `get_available_models` for active process,
- `omp models ... --json` for admin/list views when useful,
- `models.yml` for custom provider/model definitions,
- OMP auth flows for credentials.

Studio should never maintain its own canonical model catalog as the source of truth.

## Model roles

Roles are OMP configuration, not Agent definitions.

Examples include:

```text
@default
@smol
@slow
@vision
@plan
@designer
@commit
@tiny
@task
@advisor
```

Configuration channels:

- global: `omp config set` where possible,
- project: schema-aware `.omp/config.yml` edit.

Current session model changes remain RPC runtime operations and are separate from persistent Role mapping.

## Fallback

Fallback is OMP's automatic model failover when the active model/provider is temporarily unavailable, rate-limited, quota-blocked or cooling down.

Studio configuration surfaces:

- role fallback chains,
- exact model fallback chains,
- provider wildcard fallback chains,
- revert policy.

Fallback execution stays entirely inside OMP.

## Advisor

Advisor is a second-model review runtime, not a normal peer Agent.

Coverage strategy:

- configure model via `modelRoles.advisor`,
- configure runtime settings via OMP config,
- runtime on/off/status via dedicated RPC if added, otherwise deterministic slash command,
- detailed stats through slash/companion until structured RPC exists.

Do not list Advisor as a chat/kill/revive Agent in the same control tree unless OMP itself changes that model.

## Service tiers / fast mode

Persistent provider/service-tier policy is configuration. Session Fast Mode is runtime state and uses RPC.
