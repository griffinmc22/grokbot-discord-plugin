#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

set -a
if [[ -f "$ROOT/.env" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT/.env"
fi
if [[ -f "$ROOT/.runtime-webhook.env" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT/.runtime-webhook.env"
fi
set +a

if [[ -z "${DISCORD_TOKEN:-}" && -n "${DISCORD_TOKEN_FILE:-}" && -f "$DISCORD_TOKEN_FILE" ]]; then
  DISCORD_TOKEN="$(tr -d '\r\n' < "$DISCORD_TOKEN_FILE")"
  export DISCORD_TOKEN
fi

exec "$@"
