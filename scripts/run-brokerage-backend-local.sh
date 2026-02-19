#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend-brokerage"

cd "$BACKEND_DIR"

echo "Starting Brokerage backend on http://localhost:10001"
node src/server.js
