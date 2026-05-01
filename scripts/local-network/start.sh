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

hash_paths() {
  local root="$1"
  shift

  if [ ! -d "$root" ]; then
    printf 'missing'
    return 0
  fi

  (
    cd "$root"
    find "$@" -type f -print0 2>/dev/null \
      | sort -z \
      | xargs -0 -r sha256sum \
      | sha256sum \
      | awk '{print $1}'
  )
}

cache_valid() {
  local marker_file="$1"
  local expected_marker="$2"
  shift 2

  [ -f "$marker_file" ] || return 1
  [ "$(cat "$marker_file")" = "$expected_marker" ] || return 1

  local required_path
  for required_path in "$@"; do
    [ -e "$required_path" ] || return 1
  done

  return 0
}

wait_for_network_id() {
  local account_url="$1"
  local cycle_url="$2"
  local timeout_seconds="$3"
  local started
  started="$(date +%s)"

  while true; do
    local body
    body="$(curl -fsS "$account_url" 2>/dev/null || true)"
    if [ -n "$body" ]; then
      local has_network_account
      has_network_account="$(printf '%s' "$body" | jq -r '(.account.type == "NetworkAccount") // false' 2>/dev/null || true)"
      if [ "$has_network_account" = "true" ]; then
        local cycle_body
        cycle_body="$(curl -fsS "$cycle_url" 2>/dev/null || true)"
        if [ -n "$cycle_body" ]; then
          local network_id
          network_id="$(printf '%s' "$cycle_body" | jq -r '.cycleInfo[0].networkId // empty' 2>/dev/null || true)"
          if [ -n "$network_id" ]; then
            printf '%s' "$network_id"
            return 0
          fi
        fi
      fi
    fi

    if [ -n "${PROXY_PID:-}" ] && ! kill -0 "$PROXY_PID" >/dev/null 2>&1; then
      log "Proxy exited while waiting for network parameters; see ${LOG_DIR}/proxy.log"
      return 1
    fi

    if [ "$(( $(date +%s) - started ))" -ge "$timeout_seconds" ]; then
      log "Timed out waiting for network parameters from ${account_url}"
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

http_responds() {
  local url="$1"
  curl --connect-timeout 2 --max-time 3 -sS -o /dev/null "$url" >/dev/null 2>&1
}

wait_for_http_response() {
  local url="$1"
  local timeout_seconds="$2"
  local label="$3"
  local quiet="${4:-false}"
  local started
  started="$(date +%s)"

  while true; do
    if http_responds "$url"; then
      return 0
    fi

    if [ "$(( $(date +%s) - started ))" -ge "$timeout_seconds" ]; then
      if [ "$quiet" != "true" ]; then
        log "Timed out waiting for ${label} from ${url}"
      fi
      return 1
    fi

    sleep 2
  done
}

pm2_process_id_by_name() {
  local name="$1"
  local process_list
  process_list="$(
    { PM2_HOME="${SERVER_DIR}/instances/.pm2" pm2 jlist 2>/dev/null || true; } \
      | awk 'found || /^\[\{/ || /^\[\]/ { found = 1; print }'
  )"
  if [ -z "$process_list" ]; then
    process_list="[]"
  fi

  printf '%s' "$process_list" \
    | jq -r --arg name "$name" '.[] | select((.name | gsub("\""; "")) == $name) | .pm_id' 2>/dev/null \
    | head -n 1 \
    || true
}

restart_pm2_process_by_name() {
  local name="$1"
  local pm2_id
  pm2_id="$(pm2_process_id_by_name "$name")"

  if [ -z "$pm2_id" ]; then
    log "Could not find PM2 process named ${name}"
    return 1
  fi

  PM2_HOME="${SERVER_DIR}/instances/.pm2" pm2 restart "$pm2_id" --no-color >/dev/null
}

ensure_monitor_ready() {
  local monitor_url="http://127.0.0.1:3000/"

  if wait_for_http_response "$monitor_url" 20 "monitor" true; then
    return 0
  fi

  log "Monitor did not bind on port 3000; restarting monitor-server once"
  restart_pm2_process_by_name "monitor-server"
  wait_for_http_response "$monitor_url" 120 "monitor"
}

port_listening() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi

  http_responds "http://127.0.0.1:${port}/"
}

ensure_validator_ports_ready() {
  local missing=()
  local port

  for (( port = EXTERNAL_PORT_START; port < EXTERNAL_PORT_START + NODE_COUNT; port++ )); do
    if ! port_listening "$port"; then
      missing+=("$port")
    fi
  done

  if [ "${#missing[@]}" -eq 0 ]; then
    return 0
  fi

  log "Restarting validators that did not bind: ${missing[*]}"
  for port in "${missing[@]}"; do
    restart_pm2_process_by_name "shardus-instance-${port}"
  done

  local started
  started="$(date +%s)"
  while true; do
    missing=()
    for (( port = EXTERNAL_PORT_START; port < EXTERNAL_PORT_START + NODE_COUNT; port++ )); do
      if ! port_listening "$port"; then
        missing+=("$port")
      fi
    done

    if [ "${#missing[@]}" -eq 0 ]; then
      return 0
    fi

    if [ "$(( $(date +%s) - started ))" -ge 180 ]; then
      log "Timed out waiting for validator ports to bind: ${missing[*]}"
      return 1
    fi

    sleep 5
  done
}

write_proxy_config() {
  local proxy_dir="$1"
  local proxy_bind_port="$2"

  jq \
    --argjson proxy_bind_port "$proxy_bind_port" \
    '.http_port = $proxy_bind_port
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
    (cd "$SERVER_DIR" && PATH="${SERVER_DIR}/node_modules/.bin:${PATH}" shardus stop >/dev/null 2>&1)
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

NODE_COUNT="${LIBERDUS_NODE_COUNT:-5}"
EXTERNAL_PORT_START="${LIBERDUS_EXTERNAL_PORT_START:-9001}"
INTERNAL_PORT_START="${LIBERDUS_INTERNAL_PORT_START:-10001}"
PUBLIC_HOST="${LIBERDUS_PUBLIC_HOST:-127.0.0.1}"
PROXY_BIND_PORT="${LIBERDUS_PROXY_BIND_PORT:-3030}"
PROXY_WS_BIND_PORT="$(( PROXY_BIND_PORT + 1 ))"
PROXY_PUBLIC_PORT="${LIBERDUS_PROXY_PUBLIC_PORT:-3030}"
PROXY_WS_PUBLIC_PORT="${LIBERDUS_PROXY_WS_PUBLIC_PORT:-3031}"
WEB_BIND_PORT="${LIBERDUS_WEB_BIND_PORT:-8080}"
WEB_PUBLIC_PORT="${LIBERDUS_WEB_PUBLIC_PORT:-8080}"
SERVER_RUST_TOOLCHAIN="${LIBERDUS_SERVER_RUST_TOOLCHAIN:-1.79.0}"
PROXY_RUST_TOOLCHAIN="${LIBERDUS_PROXY_RUST_TOOLCHAIN:-1.82.0}"

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

write_proxy_config "$PROXY_DIR" "$PROXY_BIND_PORT"

SERVER_DEP_MARKER="node=$(node --version);rust=$(rustc +"$SERVER_RUST_TOOLCHAIN" --version);package=$(hash_file "${SERVER_DIR}/package.json");lock=$(hash_file "${SERVER_DIR}/package-lock.json")"
SERVER_BUILD_MARKER="${SERVER_DEP_MARKER};source=$(hash_paths "$SERVER_DIR" package.json package-lock.json tsconfig.json src client.js)"
PROXY_BUILD_MARKER="rust=$(rustc +"$PROXY_RUST_TOOLCHAIN" --version);source=$(hash_paths "$PROXY_DIR" Cargo.toml Cargo.lock src)"

SERVER_DEPS_CACHED=false
if cache_valid "${SERVER_DIR}/node_modules/.local-network-build" "$SERVER_DEP_MARKER" \
  "${SERVER_DIR}/node_modules/.bin/shardus"; then
  SERVER_DEPS_CACHED=true
  log "Reusing cached server dependencies"
else
  log "Installing server dependencies"
  rm -rf "${SERVER_DIR}/node_modules"
  (
    cd "$SERVER_DIR"
    export RUSTUP_TOOLCHAIN="$SERVER_RUST_TOOLCHAIN"
    npm install
    mkdir -p node_modules
    printf '%s' "$SERVER_DEP_MARKER" > node_modules/.local-network-build
  )
fi

if cache_valid "${SERVER_DIR}/dist/.local-network-build" "$SERVER_BUILD_MARKER" \
  "${SERVER_DIR}/dist/index.js"; then
  log "Reusing cached server build"
else
  if [ "$SERVER_DEPS_CACHED" = "false" ] && [ -f "${SERVER_DIR}/dist/index.js" ]; then
    log "Using server build produced during dependency install"
  else
    log "Compiling server"
    (
      cd "$SERVER_DIR"
      export RUSTUP_TOOLCHAIN="$SERVER_RUST_TOOLCHAIN"
      npm run compile
    )
  fi
  mkdir -p "${SERVER_DIR}/dist"
  printf '%s' "$SERVER_BUILD_MARKER" > "${SERVER_DIR}/dist/.local-network-build"
fi

export PATH="${SERVER_DIR}/node_modules/.bin:${PATH}"

log "Resetting any previous Shardus instances"
(
  cd "$SERVER_DIR"
  shardus stop >/dev/null 2>&1 || true
  rm -rf instances
)

export minNodes="$NODE_COUNT"
export baselineNodes="$NODE_COUNT"
export maxNodes="$(( NODE_COUNT * 2 ))"

log "Starting ${NODE_COUNT}-node Shardus network on validator ports ${EXTERNAL_PORT_START}-$(( EXTERNAL_PORT_START + NODE_COUNT - 1 ))"
(
  cd "$SERVER_DIR"
  if [ "$EXTERNAL_PORT_START" != "9001" ] || [ "$INTERNAL_PORT_START" != "10001" ]; then
    shardus create \
      --no-start \
      --starting-external-port "$EXTERNAL_PORT_START" \
      --starting-internal-port "$INTERNAL_PORT_START" \
      "$NODE_COUNT" \
      pm2--no-autorestart
  fi

  shardus start "$NODE_COUNT" pm2--no-autorestart
)

log "Waiting for archiver, monitor, and active nodelist"
wait_for_json_field "http://127.0.0.1:4000/archivers" '((.activeArchivers // .archivers // []) | length) > 0' 600 "active archivers"
ensure_monitor_ready
ensure_validator_ports_ready
wait_for_json_field "http://127.0.0.1:4000/full-nodelist?activeOnly=true" '((.nodeList // .nodes // .nodelist // []) | length) > 0' 600 "active nodelist"
wait_for_json_field "http://127.0.0.1:4000/cycleinfo/1" "((.cycleInfo // []) | length) > 0 and (.cycleInfo[0].mode == \"processing\") and ((.cycleInfo[0].active // 0) >= ${NODE_COUNT})" 2400 "processing cycle"

if cache_valid "${PROXY_DIR}/target/.local-network-build" "$PROXY_BUILD_MARKER" \
  "${PROXY_DIR}/target/debug/liberdus-proxy"; then
  log "Reusing cached Liberdus proxy build"
else
  log "Building Liberdus proxy"
  rm -rf "${PROXY_DIR}/target"
  (
    cd "$PROXY_DIR"
    cargo +"$PROXY_RUST_TOOLCHAIN" build
    mkdir -p target
    printf '%s' "$PROXY_BUILD_MARKER" > target/.local-network-build
  )
fi

log "Starting Liberdus proxy"
(
  cd "$PROXY_DIR"
  ./target/debug/liberdus-proxy > "${LOG_DIR}/proxy.log" 2>&1
) &
PROXY_PID=$!

ZERO_ACCOUNT="0000000000000000000000000000000000000000000000000000000000000000"
NETWORK_ID="$(wait_for_network_id "http://127.0.0.1:${PROXY_BIND_PORT}/account/${ZERO_ACCOUNT}" "http://127.0.0.1:4000/cycleinfo/1" 600)"
log "Detected local network id: ${NETWORK_ID}"

write_web_network "$WEB_DIR" "$NETWORK_ID" "$PUBLIC_HOST" "$PROXY_PUBLIC_PORT" "$PROXY_WS_PUBLIC_PORT"

log "Starting web client on http://${PUBLIC_HOST}:${WEB_PUBLIC_PORT}/"
(
  cd "$WEB_DIR"
  python3 -m http.server "$WEB_BIND_PORT" --bind 0.0.0.0 > "${LOG_DIR}/web-client.log" 2>&1
) &
HTTP_PID=$!

log "Local network is ready"
log "Monitor: http://${PUBLIC_HOST}:${LIBERDUS_MONITOR_PUBLIC_PORT:-3000}/"
log "Proxy: http://${PUBLIC_HOST}:${PROXY_PUBLIC_PORT}/ (binds ${PROXY_BIND_PORT}/${PROXY_WS_BIND_PORT})"
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
