#!/usr/bin/env bash
# Pick a previously signed Runtime whose inputs match this checkout.
# Inputs: PLATFORM, BUN_VERSION, OMP_RUNTIME_CHANNEL, REBUILD, GH_TOKEN.
# Outputs: key (upload name), name (matching download name), run_id (empty = build).
set -euo pipefail

vendor="$(git rev-parse --short=12 HEAD:omp-patch/vendor/oh-my-pi)"
# Hash committed inputs so Windows CRLF and Unix checkouts share an identity.
# Include the build/sign/probe implementation and public keys, not desktop UI.
inputs_hash="$(git ls-tree -r HEAD -- \
  omp-patch/overlay omp-patch/patches omp-patch/upstream.json packaging/keys \
  packages/studio-host/src packages/studio-protocol/src packages/runtime-installer/src \
  scripts/build-omp-host.mjs scripts/install-omp-deps.mjs scripts/omp-tooling.mjs \
  scripts/omp-overlay.mjs scripts/omp-seam.mjs scripts/runtime-artifact.mjs \
  scripts/runtime-signing-keys.mjs scripts/target-platform.mjs \
  scripts/windows-architecture.mjs scripts/mac-toolchain.mjs scripts/verify-omp-source.mjs \
  | sha256sum | cut -c1-16)"
key="runtime-${PLATFORM}-${OMP_RUNTIME_CHANNEL}-${vendor}-bun${BUN_VERSION}-${inputs_hash}"
run_id=""
name="$key"
if [ "${REBUILD:-}" != "true" ]; then
  # Older remote runs used a -remote suffix. Both names carry the same source
  # identity; new releases prepare one artifact per platform for all consumers.
  for name in "$key" "$key-remote"; do
    run_id="$(gh api "repos/${GITHUB_REPOSITORY}/actions/artifacts?name=${name}&per_page=20" \
      --jq '[.artifacts[] | select(.expired | not)][0].workflow_run.id // empty' || true)"
    if [ -n "$run_id" ]; then break; fi
  done
  # Migrate older cache names after build orchestration changes. Reuse the
  # immutable signed binary only when its Runtime sources and public keys match.
  # --rebuild bypasses both lookups when a new toolchain build is intended.
  if [ -z "$run_id" ]; then
    source_fingerprint() {
      git ls-tree -r "$1" -- omp-patch/overlay omp-patch/patches \
        omp-patch/upstream.json packaging/keys scripts/runtime-artifact.mjs \
        scripts/omp-overlay.mjs scripts/omp-seam.mjs | sha256sum | cut -c1-16
    }
    source_hash="$(source_fingerprint HEAD)"
    prefix="runtime-${PLATFORM}-${OMP_RUNTIME_CHANNEL}-${vendor}-bun${BUN_VERSION}-"
    candidates="$(gh api "repos/${GITHUB_REPOSITORY}/actions/artifacts?per_page=100" \
      --jq ".artifacts[] | select((.expired | not) and (.name | startswith(\"${prefix}\"))) | [.name, .workflow_run.id, .workflow_run.head_sha] | @tsv" || true)"
    while IFS=$'\t' read -r candidate_name candidate_run candidate_sha; do
      if [ -z "$candidate_sha" ]; then continue; fi
      if ! git cat-file -e "${candidate_sha}^{commit}" 2>/dev/null; then
        git fetch --no-tags --depth=1 origin "$candidate_sha"
      fi
      if [ "$(source_fingerprint "$candidate_sha")" = "$source_hash" ]; then
        name="$candidate_name"
        run_id="$candidate_run"
        break
      fi
    done <<< "$candidates"
  fi
fi

echo "key=${key}" >> "$GITHUB_OUTPUT"
echo "name=${name}" >> "$GITHUB_OUTPUT"
echo "run_id=${run_id}" >> "$GITHUB_OUTPUT"
if [ -n "$run_id" ]; then
  echo "Reusing signed Runtime ${key} from run ${run_id}"
else
  echo "Building Runtime ${key}"
fi
