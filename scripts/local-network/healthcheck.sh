#!/usr/bin/env bash
set -euo pipefail

web_port="${LIBERDUS_WEB_BIND_PORT:-${LIBERDUS_WEB_CLIENT_PORT:-8080}}"
proxy_port="${LIBERDUS_PROXY_BIND_PORT:-${LIBERDUS_PROXY_HTTP_PORT:-3030}}"
zero_account="0000000000000000000000000000000000000000000000000000000000000000"
web_url="http://127.0.0.1:${web_port}/network.js"
proxy_url="http://127.0.0.1:${proxy_port}/account/${zero_account}"
cycle_url="http://127.0.0.1:4000/cycleinfo/1"

say() {
  echo "healthcheck: $*"
}

if ! curl -fsS "${web_url}" >/dev/null 2>&1; then
  say "waiting for web network.js (${web_url})"
  exit 1
fi

if ! account_json="$(curl -fsS "${proxy_url}" 2>/dev/null)"; then
  say "waiting for proxy zero account (${proxy_url})"
  exit 1
fi

if ! jq -e '.account.type == "NetworkAccount"' >/dev/null <<<"${account_json}"; then
  account_type="$(jq -r '.account.type // "missing"' <<<"${account_json}" 2>/dev/null || echo "unknown")"
  say "waiting for proxy NetworkAccount response (account.type=${account_type})"
  exit 1
fi

if ! cycle_json="$(curl -fsS "${cycle_url}" 2>/dev/null)"; then
  say "waiting for archiver cycle (${cycle_url})"
  exit 1
fi

cycle_summary="$(
  jq -r '
    (.cycleInfo // [])[0] as $cycle
    | if $cycle then
        "mode=\($cycle.mode // "missing") active=\($cycle.active // "missing") desired=\($cycle.desired // "missing") target=\($cycle.target // "missing") networkId=\(if ($cycle.networkId | type) == "string" then "present" else "missing" end)"
      else
        "cycleInfo=missing"
      end
  ' <<<"${cycle_json}" 2>/dev/null || echo "cycleInfo=unreadable"
)"

if ! jq -e '((.cycleInfo // []) | length) > 0 and .cycleInfo[0].mode == "processing" and (.cycleInfo[0].networkId | type == "string")' >/dev/null <<<"${cycle_json}"; then
  say "waiting for archiver processing cycle (${cycle_summary})"
  exit 1
fi

say "healthy: web network.js reachable; proxy zero account is NetworkAccount; archiver ${cycle_summary}"
