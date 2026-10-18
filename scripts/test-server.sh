#!/usr/bin/env bash
# Start or stop the official Wealthfolio server image for integration tests.
#
#   scripts/test-server.sh up     # prints WF_TEST_URL and WF_TEST_PASSWORD exports
#   scripts/test-server.sh down
#
# The image tag comes from UPSTREAM_TAG without the leading "v".
# WF_TEST_PORT (default 8088) and WF_TEST_TTL_MINUTES (default 60) are optional.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="wf-cli-test"
PORT="${WF_TEST_PORT:-8088}"
TAG="$(tr -d '[:space:]' <"$ROOT/UPSTREAM_TAG")"
IMAGE="${WF_TEST_IMAGE:-wealthfolio/wealthfolio:${TAG#v}}"
PASSWORD="wf-test-password"
# Argon2id hash of $PASSWORD. Test-only credential.
HASH='$argon2id$v=19$m=65536,t=3,p=4$MmjLEewIk4DVBqvLmF5+Dg$0yHuiPF4d7YOOS9+tnOVoUfwQ5hDqfgEVJrOiJdhQUo'

case "${1:-}" in
  up)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8088" \
      -e WF_LISTEN_ADDR=0.0.0.0:8088 \
      -e WF_DB_PATH=/data/wealthfolio.db \
      -e "WF_SECRET_KEY=$(openssl rand -base64 32)" \
      -e "WF_AUTH_PASSWORD_HASH=$HASH" \
      -e "WF_AUTH_TOKEN_TTL_MINUTES=${WF_TEST_TTL_MINUTES:-60}" \
      -e "WF_CORS_ALLOW_ORIGINS=http://localhost:$PORT" \
      -e WF_MCP_ENABLED=true \
      "$IMAGE" >/dev/null
    for _ in $(seq 60); do
      if curl -sf "http://127.0.0.1:$PORT/api/v1/auth/status" >/dev/null; then
        echo "export WF_TEST_URL=http://127.0.0.1:$PORT"
        echo "export WF_TEST_PASSWORD=$PASSWORD"
        exit 0
      fi
      sleep 1
    done
    docker logs "$NAME" >&2
    echo "Server did not start" >&2
    exit 1
    ;;
  down)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    ;;
  *)
    echo "usage: $0 up|down" >&2
    exit 2
    ;;
esac
