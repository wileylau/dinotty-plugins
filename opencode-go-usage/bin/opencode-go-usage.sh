#!/bin/sh
set -eu
case "${1:-}" in
  usage)
    if [ -z "${OPENCODE_GO_KEY:-}" ]; then
      echo '{"error":{"message":"missing API key"}}'
      exit 3
    fi
    exec curl -sS --fail-with-body \
      -H "Authorization: Bearer $OPENCODE_GO_KEY" \
      -H "Accept: application/json" \
      "https://opencode.ai/zen/go/v1/usage"
    ;;
  sessions)
    if [ -z "${OPENCODE_URL:-}" ]; then
      echo '{"error":{"message":"opencode service is not running"}}'
      exit 3
    fi
    exec curl -sS --fail-with-body \
      -u "opencode:${OPENCODE_PASS:-}" \
      "$OPENCODE_URL/api/session"
    ;;
  *)
    echo '{"error":{"message":"unknown command"}}'
    exit 2
    ;;
esac
