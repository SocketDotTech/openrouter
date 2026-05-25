#!/usr/bin/env bash
# Run Slither inside trailofbits/eth-security-toolbox with Foundry compilation.
# Uses forge in the container instead of solc-select (avoids solc-select 403s on binary list fetch).
# Remappings are read from remappings.txt so npm does not need a multiline tr(1) in package.json.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f remappings.txt ]]; then
  echo "docker-slither.sh: remappings.txt not found in ${ROOT}" >&2
  exit 1
fi

REMAPS=""
while IFS= read -r line || [[ -n "${line}" ]]; do
  if [[ -n "${line}" ]]; then
    if [[ -n "${REMAPS}" ]]; then
      REMAPS+=" "
    fi
    REMAPS+="${line}"
  fi
done < remappings.txt

SLITHER_ARGS=("$@")
if [[ ${#SLITHER_ARGS[@]} -eq 0 ]]; then
  SLITHER_ARGS=(.)
fi
if [[ ${#SLITHER_ARGS[@]} -eq 1 && "${SLITHER_ARGS[0]}" == *.sol ]]; then
  sol_file="${SLITHER_ARGS[0]}"
  base="$(basename "${sol_file}")"
  # --include-paths takes a regex; escape dots so ".sol" is literal.
  include_regex="${base//./\\.}"
  SLITHER_ARGS=(. --include-paths "${include_regex}")
fi

DOCKER_FLAGS=(
  -t
  --rm
  -v "${ROOT}:/poc-openrouter"
  -w /poc-openrouter
  --platform linux/amd64
  --entrypoint slither
)

# Do not mount ~/.foundry: host macOS forge/solc binaries break Linux exec (126 / Exec format error).

exec docker run "${DOCKER_FLAGS[@]}" trailofbits/eth-security-toolbox "${SLITHER_ARGS[@]}" \
  --compile-force-framework forge \
  --solc-remaps "${REMAPS}" \
  --solc-args '--allow-paths /'
