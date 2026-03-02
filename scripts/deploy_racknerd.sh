#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY_PATH="${1:-$ROOT_DIR/target/x86_64-unknown-linux-musl/release/axum-piping}"
HOST="107.174.204.124"
USER="root"
PORT="22"
IDENTITY_FILE="/Users/di.wu/.ssh/id_rsa"

if [[ ! -f "$BINARY_PATH" ]]; then
  echo "Binary not found: $BINARY_PATH" >&2
  exit 1
fi

scp -P "$PORT" -i "$IDENTITY_FILE" "$BINARY_PATH" "$USER@$HOST:/tmp/axum-piping"
scp -P "$PORT" -i "$IDENTITY_FILE" "$ROOT_DIR/deploy/systemd/axum-piping.service" "$USER@$HOST:/tmp/axum-piping.service"

ssh -p "$PORT" -i "$IDENTITY_FILE" "$USER@$HOST" <<'EOSSH'
set -euo pipefail
mkdir -p /opt/axum-piping
install -m 0755 /tmp/axum-piping /opt/axum-piping/axum-piping
install -m 0644 /tmp/axum-piping.service /etc/systemd/system/axum-piping.service
systemctl daemon-reload
systemctl enable axum-piping
systemctl restart axum-piping
systemctl --no-pager --full status axum-piping
EOSSH
