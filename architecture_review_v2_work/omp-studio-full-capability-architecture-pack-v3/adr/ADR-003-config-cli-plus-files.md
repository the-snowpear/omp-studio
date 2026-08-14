# ADR-003: Use OMP CLI for Global Settings and Files for Native Project/Provider Config

Status: Accepted for v3 baseline

## Decision

Use `omp config` for global schema-validated settings. Use atomic schema-aware file editing for project `.omp/config.yml`, `models.yml`, `mcp.json` and file-defined capabilities.

## Rationale

The OMP config CLI writes global config, not project config. Provider/model and MCP definitions have their own native files. Studio should respect those ownership boundaries rather than create a parallel database.
