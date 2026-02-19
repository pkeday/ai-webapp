#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-5173}"
HOST="0.0.0.0"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

echo "Starting local server..."
echo "Local:   http://localhost:${PORT}"

if command -v ipconfig >/dev/null 2>&1; then
  LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
  if [[ -n "$LAN_IP" ]]; then
    echo "Device:  http://${LAN_IP}:${PORT} (same Wi-Fi)"
  fi
fi

python3 -m http.server "$PORT" --bind "$HOST"
