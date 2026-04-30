#!/usr/bin/env bash
set -Eeuo pipefail

log() {
  printf '[liberdus-local] %s\n' "$*" >&2
}

require_dir() {
  local label="$1"
  local dir="$2"
  if [ ! -d "$dir" ]; then
    log "Missing ${label}: ${dir}"
    exit 1
  fi
}

sync_repo() {
  local src="$1"
  local dest="$2"
  shift 2
  mkdir -p "$dest"
  rsync -a --delete "$@" "${src}/" "${dest}/"
}

hash_file() {
  local path="$1"
  if [ -f "$path" ]; then
    sha256sum "$path" | awk '{print $1}'
  else
    printf 'missing'
  fi
}

prepare_build_cache() {
  local marker_file="$1"
  local expected_marker="$2"
  shift 2

  if [ -f "$marker_file" ] && [ "$(cat "$marker_file")" = "$expected_marker" ]; then
    return 0
  fi

  log "Clearing stale build cache for ${marker_file}"
  rm -rf "$@"
}

wait_for_network_id() {
  local url="$1"
  local timeout_seconds="$2"
  local started
  started="$(date +%s)"

  while true; do
    local body
    body="$(curl -fsS "$url" 2>/dev/null || true)"
    if [ -n "$body" ]; then
      local network_id
      network_id="$(printf '%s' "$body" | jq -r '.account.networkId // empty' 2>/dev/null || true)"
      local stability_factor
      stability_factor="$(printf '%s' "$body" | jq -r '.account.current.stabilityFactorStr // empty' 2>/dev/null || true)"
      if [ -n "$network_id" ] && [ -n "$stability_factor" ]; then
        printf '%s' "$network_id"
        return 0
      fi
    fi

    if [ -n "${PROXY_PID:-}" ] && ! kill -0 "$PROXY_PID" >/dev/null 2>&1; then
      log "Proxy exited while waiting for network parameters; see ${LOG_DIR}/proxy.log"
      return 1
    fi

    if [ "$(( $(date +%s) - started ))" -ge "$timeout_seconds" ]; then
      log "Timed out waiting for network parameters from ${url}"
      return 1
    fi

    sleep 5
  done
}

wait_for_json_field() {
  local url="$1"
  local predicate="$2"
  local timeout_seconds="$3"
  local label="$4"
  local started
  started="$(date +%s)"

  while true; do
    local body
    body="$(curl -fsS "$url" 2>/dev/null || true)"
    if [ -n "$body" ] && printf '%s' "$body" | jq -e "$predicate" >/dev/null 2>&1; then
      return 0
    fi

    if [ "$(( $(date +%s) - started ))" -ge "$timeout_seconds" ]; then
      log "Timed out waiting for ${label} from ${url}"
      return 1
    fi

    sleep 5
  done
}

write_proxy_config() {
  local proxy_dir="$1"

  jq \
    '.http_port = 3030
      | .archiver_seed_path = "./src/archiver_seed.json"
      | .standalone_network.enabled = true
      | .standalone_network.replacement_ip = "127.0.0.1"
      | .shardus_monitor.upstream_ip = "127.0.0.1"
      | .shardus_monitor.upstream_port = 3000
      | .shardus_monitor.https = false
      | .local_source.collector_api_ip = "127.0.0.1"
      | .local_source.collector_api_port = 6101
      | .local_source.collector_event_server_ip = "127.0.0.1"
      | .local_source.collector_event_server_port = 4444' \
    "${proxy_dir}/src/config.json" > "${proxy_dir}/src/config.local.json"
  mv "${proxy_dir}/src/config.local.json" "${proxy_dir}/src/config.json"

  cat > "${proxy_dir}/src/archiver_seed.json" <<'JSON'
[{"publicKey":"758b1c119412298802cd28dbfa394cdfeecc4074492d60844cc192d632d84de3","port":4000,"ip":"127.0.0.1"}]
JSON
}

write_web_network() {
  local web_dir="$1"
  local network_id="$2"
  local public_host="$3"
  local proxy_public_port="$4"
  local proxy_ws_public_port="$5"

  cat > "${web_dir}/network.js" <<EOF
const network = {
  "name": "Localnet",
  "netid": "${network_id}",
  "netids": [
    "${network_id}"
  ],
  "gateways": [
    {
      "web": "http://${public_host}:${proxy_public_port}",
      "ws": "ws://${public_host}:${proxy_ws_public_port}"
    }
  ],
  "bridges": [
    {
      "name": "Polygon",
      "username": "bridgepolygon"
    },
    {
      "name": "Ethereum",
      "username": "bridgeeth"
    },
    {
      "name": "BSC",
      "username": "bridgebsc"
    }
  ],
  "farmUrl": "https://liberdus.com/farm",
  "validatorUrl": "https://liberdus.com/validator",
  "bridgeUrl": "./bridge"
}
EOF
}

stop_stack() {
  set +e
  if [ -n "${SERVER_DIR:-}" ] && [ -d "$SERVER_DIR" ]; then
    log "Stopping Shardus network"
    (cd "$SERVER_DIR" && shardus-network stop >/dev/null 2>&1)
  fi
  if [ -n "${PROXY_PID:-}" ]; then
    kill "$PROXY_PID" >/dev/null 2>&1
  fi
  if [ -n "${HTTP_PID:-}" ]; then
    kill "$HTTP_PID" >/dev/null 2>&1
  fi
}

trap stop_stack EXIT INT TERM

RUNTIME_ROOT="${LIBERDUS_RUNTIME_ROOT:-/workspace/runtime}"
SERVER_SOURCE="${LIBERDUS_SERVER_SOURCE:-/sources/server}"
PROXY_SOURCE="${LIBERDUS_PROXY_SOURCE:-/sources/liberdus-proxy}"
WEB_CLIENT_SOURCE="${LIBERDUS_WEB_CLIENT_SOURCE:-/sources/web-client-v2}"

NODE_COUNT="${LIBERDUS_NODE_COUNT:-10}"
EXTERNAL_PORT_START="${LIBERDUS_EXTERNAL_PORT_START:-9001}"
INTERNAL_PORT_START="${LIBERDUS_INTERNAL_PORT_START:-10001}"
PUBLIC_HOST="${LIBERDUS_PUBLIC_HOST:-127.0.0.1}"
PROXY_PUBLIC_PORT="${LIBERDUS_PROXY_PUBLIC_PORT:-3030}"
PROXY_WS_PUBLIC_PORT="${LIBERDUS_PROXY_WS_PUBLIC_PORT:-3031}"
WEB_PUBLIC_PORT="${LIBERDUS_WEB_PUBLIC_PORT:-8080}"
SERVER_RUST_TOOLCHAIN="${LIBERDUS_SERVER_RUST_TOOLCHAIN:-1.82.0}"
PROXY_RUST_TOOLCHAIN="${LIBERDUS_PROXY_RUST_TOOLCHAIN:-stable}"

SERVER_DIR="${RUNTIME_ROOT}/server"
PROXY_DIR="${RUNTIME_ROOT}/liberdus-proxy"
WEB_DIR="${RUNTIME_ROOT}/web-client-v2"
LOG_DIR="${RUNTIME_ROOT}/logs"

require_dir "server source" "$SERVER_SOURCE"
require_dir "liberdus-proxy source" "$PROXY_SOURCE"
require_dir "web-client-v2 source" "$WEB_CLIENT_SOURCE"

mkdir -p "$LOG_DIR"

log "Syncing source repos into Docker volume"
sync_repo "$SERVER_SOURCE" "$SERVER_DIR" \
  --exclude .git --exclude node_modules --exclude instances --exclude dist
sync_repo "$PROXY_SOURCE" "$PROXY_DIR" \
  --exclude .git --exclude target
sync_repo "$WEB_CLIENT_SOURCE" "$WEB_DIR" \
  --exclude .git --exclude node_modules

write_proxy_config "$PROXY_DIR"

SERVER_BUILD_MARKER="node=$(node --version);rust=$(rustc +"$SERVER_RUST_TOOLCHAIN" --version);package=$(hash_file "${SERVER_DIR}/package.json");lock=$(hash_file "${SERVER_DIR}/package-lock.json")"
PROXY_BUILD_MARKER="rust=$(rustc +"$PROXY_RUST_TOOLCHAIN" --version);manifest=$(hash_file "${PROXY_DIR}/Cargo.toml")"

prepare_build_cache "${SERVER_DIR}/node_modules/.local-network-build" "$SERVER_BUILD_MARKER" \
  "${SERVER_DIR}/node_modules" "${SERVER_DIR}/dist"
prepare_build_cache "${PROXY_DIR}/target/.local-network-build" "$PROXY_BUILD_MARKER" \
  "${PROXY_DIR}/target"

log "Installing and compiling server dependencies"
(
  cd "$SERVER_DIR"
  export RUSTUP_TOOLCHAIN="$SERVER_RUST_TOOLCHAIN"
  npm install
  npm run compile
  mkdir -p node_modules
  printf '%s' "$SERVER_BUILD_MARKER" > node_modules/.local-network-build
)

log "Resetting any previous Shardus instances"
(
  cd "$SERVER_DIR"
  shardus-network stop >/dev/null 2>&1 || true
  rm -rf instances
)

export minNodes="$NODE_COUNT"
export baselineNodes="$NODE_COUNT"
export maxNodes="$(( NODE_COUNT * 2 ))"

log "Creating and starting ${NODE_COUNT}-node Shardus network on validator ports ${EXTERNAL_PORT_START}-$(( EXTERNAL_PORT_START + NODE_COUNT - 1 ))"
(
  cd "$SERVER_DIR"
  shardus-network create \
    --starting-external-port "$EXTERNAL_PORT_START" \
    --starting-internal-port "$INTERNAL_PORT_START" \
    "$NODE_COUNT" \
    pm2--no-autorestart
)

log "Waiting for archiver and active nodelist"
wait_for_json_field "http://127.0.0.1:4000/archivers" '((.activeArchivers // .archivers // []) | length) > 0' 600 "active archivers"
wait_for_json_field "http://127.0.0.1:4000/full-nodelist?activeOnly=true" '((.nodeList // .nodes // .nodelist // []) | length) > 0' 600 "active nodelist"
wait_for_json_field "http://127.0.0.1:4000/cycleinfo/1" "((.cycleInfo // []) | length) > 0 and (.cycleInfo[0].mode == \"processing\") and ((.cycleInfo[0].active // 0) >= ${NODE_COUNT})" 2400 "processing cycle"

log "Building Liberdus proxy"
(
  cd "$PROXY_DIR"
  cargo +"$PROXY_RUST_TOOLCHAIN" build
  mkdir -p target
  printf '%s' "$PROXY_BUILD_MARKER" > target/.local-network-build
)

log "Starting Liberdus proxy"
(
  cd "$PROXY_DIR"
  cargo +"$PROXY_RUST_TOOLCHAIN" run > "${LOG_DIR}/proxy.log" 2>&1
) &
PROXY_PID=$!

ZERO_ACCOUNT="0000000000000000000000000000000000000000000000000000000000000000"
NETWORK_ID="$(wait_for_network_id "http://127.0.0.1:3030/account/${ZERO_ACCOUNT}" 600)"
log "Detected local network id: ${NETWORK_ID}"

write_web_network "$WEB_DIR" "$NETWORK_ID" "$PUBLIC_HOST" "$PROXY_PUBLIC_PORT" "$PROXY_WS_PUBLIC_PORT"

log "Starting web client on http://${PUBLIC_HOST}:${WEB_PUBLIC_PORT}/"
(
  cd "$WEB_DIR"
  python3 -m http.server 8080 --bind 0.0.0.0 > "${LOG_DIR}/web-client.log" 2>&1
) &
HTTP_PID=$!

log "Local network is ready"
log "Monitor: http://${PUBLIC_HOST}:${LIBERDUS_MONITOR_PUBLIC_PORT:-3000}/"
log "Proxy: http://${PUBLIC_HOST}:${PROXY_PUBLIC_PORT}/"
log "Web client: http://${PUBLIC_HOST}:${WEB_PUBLIC_PORT}/"

while true; do
  if ! kill -0 "$PROXY_PID" >/dev/null 2>&1; then
    log "Proxy exited; see ${LOG_DIR}/proxy.log in the local-network-runtime volume"
    exit 1
  fi
  if ! kill -0 "$HTTP_PID" >/dev/null 2>&1; then
    log "Web client server exited; see ${LOG_DIR}/web-client.log in the local-network-runtime volume"
    exit 1
  fi
  sleep 5
done
