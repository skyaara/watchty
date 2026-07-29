#!/usr/bin/env bash
# Project-local watchty hook — runs this checkout's CLI (not a global install).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUN_BIN="${BUN_INSTALL:-$HOME/.bun}/bin/bun"
if [[ ! -x "$BUN_BIN" ]]; then
  BUN_BIN="$(command -v bun 2>/dev/null || true)"
fi
if [[ -z "${BUN_BIN}" || ! -x "$BUN_BIN" ]]; then
  echo "watchty: bun not found" >&2
  exit 127
fi

exec "$BUN_BIN" "$ROOT/src/cli.ts" hook
