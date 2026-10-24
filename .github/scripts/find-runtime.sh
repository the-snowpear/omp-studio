#!/usr/bin/env bash
# Pick a previously signed Runtime whose inputs match this checkout.
# Inputs: PLATFORM, INPUTS_HASH, BUN_VERSION, OMP_RUNTIME_CHANNEL, REBUILD, GH_TOKEN.
# Outputs: key (artifact name to upload under), run_id (empty = build it).
set -euo pipefail

vendor="$(git rev-parse --short=12 HEAD:omp-patch/vendor/oh-my-pi)"
key="runtime-${PLATFORM}-${OMP_RUNTIME_CHANNEL}-${vendor}-bun${BUN_VERSION}-${INPUTS_HASH:0:16}"
run_id=""
if [ "${REBUILD:-}" != "true" ]; then
  run_id="$(gh api "repos/${GITHUB_REPOSITORY}/actions/artifacts?name=${key}&per_page=20" \
    --jq '[.artifacts[] | select(.expired | not)][0].workflow_run.id // empty' || true)"
fi

echo "key=${key}" >> "$GITHUB_OUTPUT"
echo "run_id=${run_id}" >> "$GITHUB_OUTPUT"
if [ -n "$run_id" ]; then
  echo "Reusing signed Runtime ${key} from run ${run_id}"
else
  echo "Building Runtime ${key}"
fi
