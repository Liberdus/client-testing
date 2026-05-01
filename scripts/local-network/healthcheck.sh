#!/usr/bin/env bash
set -euo pipefail

web_port="${LIBERDUS_WEB_BIND_PORT:-${LIBERDUS_WEB_CLIENT_PORT:-8080}}"
proxy_port="${LIBERDUS_PROXY_BIND_PORT:-${LIBERDUS_PROXY_HTTP_PORT:-3030}}"
zero_account="0000000000000000000000000000000000000000000000000000000000000000"

curl -fsS "http://127.0.0.1:${web_port}/network.js" >/dev/null
curl -fsS "http://127.0.0.1:${proxy_port}/account/${zero_account}" \
  | jq -e '.account.type == "NetworkAccount"' >/dev/null
curl -fsS "http://127.0.0.1:4000/cycleinfo/1" \
  | jq -e '((.cycleInfo // []) | length) > 0 and .cycleInfo[0].mode == "processing" and (.cycleInfo[0].networkId | type == "string")' >/dev/null
