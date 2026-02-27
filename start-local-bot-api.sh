#!/usr/bin/env bash
set -euo pipefail

if [[ -f .env ]]; then
	set -a
	# shellcheck disable=SC1091
	source .env
	set +a
fi

PORT="${1:-${BOT_API_LOCAL_HTTP_PORT:-8081}}"
WORKDIR="${2:-${BOT_API_LOCAL_WORKDIR:-.botapi}}"

if [[ -z "${TELEGRAM_API_ID:-}" ]]; then
	echo "TELEGRAM_API_ID is required to run local telegram-bot-api." >&2
	exit 1
fi
if [[ -z "${TELEGRAM_API_HASH:-}" ]]; then
	echo "TELEGRAM_API_HASH is required to run local telegram-bot-api." >&2
	exit 1
fi
BINARY="${BOT_API_LOCAL_BIN:-telegram-bot-api}"

if ! command -v "$BINARY" >/dev/null 2>&1; then
	echo "telegram-bot-api binary was not found in PATH. Set BOT_API_LOCAL_BIN or install '$BINARY'." >&2
	exit 1
fi

mkdir -p "$WORKDIR"

echo "Starting local telegram-bot-api on port $PORT"
echo "Workdir: $WORKDIR"

exec "$BINARY" \
	--api-id "$TELEGRAM_API_ID" \
	--api-hash "$TELEGRAM_API_HASH" \
	--local \
	--http-port "$PORT" \
	--dir "$WORKDIR"
