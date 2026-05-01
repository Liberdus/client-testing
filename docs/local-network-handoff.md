# Local Network Docker Compose Handoff

Date: 2026-05-01
Branch: `client-testing-local-network`
Repository: `Liberdus/client-testing`

## Goal

Enable the Playwright tests in this repo to run against a locally started Liberdus network instead of only defaulting to `https://liberdus.com/dev/`.

The current implementation focuses on standing up the local network locally with Docker Compose. The next phase can wire the same approach into GitHub Actions once the local harness is stable.

## Current Status

The branch contains a Docker Compose based local-network harness and Playwright configuration changes. The default local Docker network has been changed to 5 validators to reduce startup time, and startup now uses `shardus start` plus source-aware cache markers for:

- server dependencies
- server `dist`
- Rust proxy `target`

Current state as of this handoff:

- A 5-node Docker Compose run reaches Docker `healthy`.
- The archiver reports `processing` with 5 active validators.
- The local web client is served successfully.
- The single account-create smoke does **not** pass on 5 nodes yet; it hangs on `Creating account...`.

The currently running local stack was left up for inspection on non-default host ports from `local-network.env`:

- web client: `http://127.0.0.1:8088/`
- proxy: `http://127.0.0.1:3038/`
- proxy WebSocket: `ws://127.0.0.1:3039/`
- archiver: `http://127.0.0.1:4008/`
- monitor: `http://127.0.0.1:3008/`
- validators: host `9101-9105` -> container `9001-9005`

The most recent status check showed:

```json
{
  "mode": "processing",
  "active": 5,
  "standby": 0,
  "syncing": 0,
  "desired": 5,
  "target": 5
}
```

Known-good e2e baseline: 10 nodes passed the same single smoke both outside Docker and in Docker Compose.

Known-bad current 5-node e2e behavior: the network becomes ready, but account creation stalls after the register transaction. Validator logs show the register tx applying on all 5 validators, then receipt/read-repair trouble:

- `Receipt does not have the required majority`
- `txSafelyRemoved_3 stuck_in_consensus_3`
- repeated `isInSync = false`
- repeated `getAccountRepairData no node avail`
- proxy collector/read errors with `Connection refused (os error 111)`

So the branch is better for startup speed, but 5 nodes should not be treated as e2e-ready until the consensus/read-after-write issue is solved. For GitHub Actions, the practical choice is probably to run 10 nodes for now, or keep this branch at 5 nodes while investigating the server-side config needed to make 5-node e2e reliable.

## Validation Timeline

The first local smoke failure happened before the processing readiness gate. The web client reached account creation while the network was still in `forming`, and the server rejected app transactions with:

```text
Error injecting transaction: Application transactions are only allowed in processing Mode.
```

After that failure, the startup script and healthcheck were changed so the local stack waits for a `processing` cycle before declaring itself ready or serving the web client.

The stack was then run outside Docker using the same startup script logic and `shardus start`. The network reached `processing` with 10 active validators, the Rust proxy served the zero account, and this single Playwright smoke passed:

```bash
PLAYWRIGHT_BASE_URL='http://127.0.0.1:8088/' npx playwright test tests/smoke.e2e.test.js --project=chromium --grep 'should navigate to Contacts and Wallet views' --workers=1 --retries=0 --reporter=line
```

Result:

```text
1 passed (25.9s)
```

A clean Docker Compose 10-node run was started with:

```bash
docker compose --env-file local-network.env -f docker-compose.local.yml down -v --remove-orphans
docker compose --env-file local-network.env -f docker-compose.local.yml up --build
```

The container became Docker `healthy`, reached `processing` with 10 active validators, served `network.js`, and the same single Playwright smoke passed against the Docker stack:

```text
1 passed (23.0s)
```

The first clean Docker run paid the full server and proxy native build cost. Server `npm install` took about 16 minutes, and proxy `cargo build` took about 2 minutes.

After the cache/default update, a warm 5-node rerun reused server dependencies, rebuilt server `dist` because the marker format changed, reached Docker `healthy` and `processing` with 5 active validators, and then rebuilt the proxy once because the proxy marker also changed. Proxy rebuild took 1m 46s; the next warm run should skip that proxy build too.

The single Playwright smoke was then run against the 5-node stack:

```bash
PLAYWRIGHT_BASE_URL='http://127.0.0.1:8088/' npx playwright test tests/smoke.e2e.test.js --project=chromium --grep 'should navigate to Contacts and Wallet views' --workers=1 --retries=0 --reporter=line
```

Result:

```text
1 failed after 5.0m
Test timeout of 300000ms exceeded while setting up "page".
waiting for locator('.toast.loading.show') to be detached
locator resolved to visible: Creating account...
```

The 5-node network should not be treated as e2e-ready yet. It can start and report healthy, but account creation currently hangs after the register transaction.

## Files Changed

### Docker Compose Harness

- `.docker/local-network.Dockerfile`
  - Builds an Ubuntu 22.04 image.
  - Installs Node.js 18.19.1.
  - Installs two Rust toolchains:
    - Rust 1.79.0 for `server` native dependencies.
    - Rust 1.82.0 for `liberdus-proxy`.
  - Uses the `shardus` CLI installed by the server repo dependencies.
  - Copies the local-network scripts into the image.

- `docker-compose.local.yml`
  - Defines one `local-network` service.
  - Mounts the three sibling repos read-only:
    - `server`
    - `liberdus-proxy`
    - `web-client-v2`
  - Copies those repos into a Docker volume before writing generated config.
  - Publishes:
    - host `3000` -> monitor
    - host `4000` -> archiver
    - host `3030` -> proxy HTTP
    - host `3031` -> proxy WebSocket
    - host `8080` -> web client
    - host `9101-9105` -> container validator ports `9001-9005`

- `local-network.env.example`
  - Windows-oriented default paths for Chris's local repos.
  - Documents the host validator port range separately from the container validator port range.
  - On macOS, copy this to `local-network.env` and replace the repo paths with local macOS paths.

- `.dockerignore`
  - Keeps local dependency folders, test output, and env files out of the image build context.

### Local Network Scripts

- `scripts/local-network/start.sh`
  - Syncs mounted source repos into `/workspace/runtime`.
  - Writes generated proxy config and archiver seed.
  - Reuses cached server dependencies and build output when source, lockfiles, and toolchains are unchanged.
  - Installs/compiles the server with Rust 1.79.0 when the cache is stale.
  - Starts a 5-node Shardus network with `shardus start`.
  - Restarts `monitor-server` once if it starts under PM2 but does not bind port `3000`.
  - Restarts validator PM2 processes once if their validator ports do not bind after startup.
  - Waits for:
    - active archiver
    - monitor HTTP response
    - active nodelist
    - `cycleinfo` mode `processing`
  - Reuses the cached Rust proxy build when source, lockfile, and toolchain are unchanged.
  - Builds and starts the Rust proxy with Rust 1.82.0 when the cache is stale.
  - Fetches the local network ID from the proxy.
  - Writes `web-client-v2/network.js`.
  - Serves the web client on port `8080`.

- `scripts/local-network/healthcheck.sh`
  - Checks `network.js`.
  - Checks the zero account through the proxy.
  - Checks the current cycle is in `processing` mode.

### Playwright Configuration

- `playwright-tests/playwright.config.ts`
  - Loads `playwright-tests/.env`.
  - Uses:
    - `PLAYWRIGHT_BASE_URL`, then
    - `BASE_URL`, then
    - `https://liberdus.com/dev/`

- `playwright-tests/helpers/global-setup.js`
  - Uses the Playwright config/env base URL instead of parsing `playwright.config.ts` as text.
  - Accepts the current local gateway account shape where amount fields are bigint objects and `stabilityFactorStr` may be missing.

- `playwright-tests/.env.example`
  - Sets:

```env
PLAYWRIGHT_BASE_URL=http://127.0.0.1:8080/
```

- `.gitignore`
  - Ignores:
    - `playwright-tests/node_modules/`
    - `playwright-tests/.env`
    - `local-network.env`

### README

- `README.md`
  - Adds a "Local Network with Docker Compose" section with setup, run, test, and shutdown commands.

## How To Run Locally

### Windows

From the repo root:

```powershell
Copy-Item local-network.env.example local-network.env
docker compose --env-file local-network.env -f docker-compose.local.yml up --build
```

In another shell:

```powershell
Copy-Item playwright-tests\.env.example playwright-tests\.env
cd playwright-tests
npm install
npx playwright test
```

To stop:

```powershell
docker compose --env-file local-network.env -f docker-compose.local.yml down
```

### macOS

From the repo root:

```bash
cp local-network.env.example local-network.env
```

Edit `local-network.env` to point at the local macOS repo paths, for example:

```env
LIBERDUS_SERVER_DIR=/Users/<you>/Documents/Code/liberdus/server
LIBERDUS_PROXY_DIR=/Users/<you>/Documents/Code/liberdus/liberdus-proxy
LIBERDUS_WEB_CLIENT_DIR=/Users/<you>/Documents/Code/liberdus/web-client-v2
```

Then run:

```bash
docker compose --env-file local-network.env -f docker-compose.local.yml up --build
```

In another shell:

```bash
cp playwright-tests/.env.example playwright-tests/.env
cd playwright-tests
npm install
npx playwright test
```

To stop:

```bash
docker compose --env-file local-network.env -f docker-compose.local.yml down
```

## Recommended Smoke Test

The smallest useful local-network smoke target is:

```powershell
$env:PLAYWRIGHT_BASE_URL='http://127.0.0.1:8080/'; npx playwright test tests/smoke.e2e.test.js --project=chromium --grep 'should navigate to Contacts and Wallet views' --workers=1 --retries=0 --reporter=line
```

macOS equivalent:

```bash
PLAYWRIGHT_BASE_URL='http://127.0.0.1:8080/' npx playwright test tests/smoke.e2e.test.js --project=chromium --grep 'should navigate to Contacts and Wallet views' --workers=1 --retries=0 --reporter=line
```

This test creates and signs in a fresh user, then checks Contacts and Wallet navigation. It is a better smoke than payment/transfer tests because it avoids additional funding and recipient setup.

## Validation Commands

Commands that passed on May 1 after the latest changes:

```bash
bash -n scripts/local-network/start.sh
bash -n scripts/local-network/healthcheck.sh
docker compose --env-file local-network.env.example -f docker-compose.local.yml config --quiet
git diff --check
```

Runtime validation:

- 10-node outside-Docker smoke passed: `1 passed (25.9s)`.
- 10-node Docker Compose smoke passed: `1 passed (23.0s)`.
- 5-node Docker Compose startup passed readiness: Docker `healthy`, cycle `processing`, `active: 5`.
- 5-node Docker Compose smoke failed during account creation:

  ```text
  1 failed after 5.0m
  Test timeout of 300000ms exceeded while setting up "page".
  waiting for locator('.toast.loading.show') to be detached
  locator resolved to visible: Creating account...
  ```

## Important Findings

### 5-Node Transaction Issue

The default 5-node stack reaches `processing` and Docker `healthy`, but the account-create transaction does not complete from the web client's point of view.

Observed during the failed smoke:

- Current cycle stayed healthy:

```json
{
  "mode": "processing",
  "active": 5,
  "standby": 0,
  "syncing": 0,
  "desired": 5,
  "target": 5
}
```

- Browser stayed on `Creating account...` for the full 300s Playwright timeout.
- Validator app logs showed `Applied register tx` on all 5 validators for username `c58100289776418`.
- Validator error/fatal logs then showed:
  - `Receipt does not have the required majority for txid: 9b9f7521aaa06a5dd200dc6577de6b39917cc63165110819225d596d0a9ee115`
  - `txSafelyRemoved_3 stuck_in_consensus_3`
  - repeated `isInSync = false`
  - repeated `getAccountRepairData no node avail`
- Proxy logs showed repeated collector/read errors after the client activity:
  - `Error handling collector request: Connection refused (os error 111)`

Likely interpretation: 5 nodes are enough for startup/readiness, but not enough for the current server/shardus data-sync or read-after-write path used by account creation. The prior 10-node stack passed the same smoke, so the 5-node default is faster but currently exposes a consensus/repair visibility issue that needs a config fix or a higher node count for e2e.

### Dev Network Account Comparison

The dev network zero account was checked at:

```text
https://dev.liberdus.com:3030/account/0000000000000000000000000000000000000000000000000000000000000000
```

The local zero account has the same top-level `NetworkAccount` shape, but the local server checkout is older (`2.3.4`) than dev (`2.4.8`). Exact-matching dev's version fields on the older checkout is risky because validators can reject app versions outside the network account's allowed range.

Notable dev values:

- `activeVersion`, `latestVersion`, `minVersion`: `2.4.8`
- `stabilityScaleMul`: `125`
- `stabilityScaleDiv`: `1`
- `stabilityFactorStr`: `0.008`
- `tollTimeout`: `60000`
- `transactionFeeUsdStr`: `0.01`
- `minTollUsdStr`: `0.05`
- `defaultTollUsdStr`: `0.05`
- `messageRetentionDays`: `7`
- `messageMaxLength`: `500`

The local outside-Docker run had:

- `activeVersion`, `latestVersion`, `minVersion`: `2.3.4`
- `stabilityScaleMul`: `1000`
- `stabilityScaleDiv`: `1000`
- no string fee fields
- `tollTimeout`: `604800000`

Shardus runtime knobs such as `minNodes`, `baselineNodes`, and `forceBogonFilteringOn` are not in the network account. They come from `server/src/config/index.ts` / the local-network patch path.

### Toolchain Split Is Necessary

The server and proxy currently need different Rust behavior:

- The server dependency tree needs Rust 1.79.0 because current native dependencies pull `time` 0.3.31, which fails with rustc 1.80+.
- Newer Rust failed the server build in that dependency before the local network could start.
- The proxy repo pins Rust 1.82.0 and has a committed `Cargo.lock`.

The Dockerfile therefore installs both Rust 1.79.0 and Rust 1.82.0, and the startup script selects the toolchain explicitly.

### Shardus Port Behavior

The Shardus CLI still creates node folders and validator listeners on `9001-9005` for the default 5-node stack. Compose maps those to host ports `9101-9105` to avoid common host conflicts:

```text
host 9101 -> container 9001
host 9102 -> container 9002
...
host 9105 -> container 9005
```

Do not expect the folder names to match the host-facing ports.

### Readiness Needs Processing Mode

The proxy can serve the zero account while the network is still in `forming` mode. That is not enough for tests that submit app transactions.

The latest script now waits for:

```text
/cycleinfo/1 -> cycleInfo[0].mode == "processing"
```

and requires the active count to be at least `LIBERDUS_NODE_COUNT`.

This has now been verified with both a 10-node run and a 5-node warm-cache run.

## Known Gaps / Next Steps

1. Investigate why the 5-node stack applies account registration but leaves the browser stuck waiting for create-account completion.

   Useful checks from the failed run:

   ```bash
   docker exec client-testing-local-network-1 bash -lc 'grep -R "Receipt does not have the required majority\|stuck_in_consensus\|isInSync = false\|getAccountRepairData no node avail" -n /workspace/runtime/server/instances/shardus-instance-900*/logs'
   docker exec client-testing-local-network-1 bash -lc 'tr "\r" "\n" < /workspace/runtime/logs/proxy.log | grep -Eiv "Active Connection Streams: 0|^$" | tail -n 200'
   ```

2. Decide whether CI should use 10 nodes for reliable e2e while 5-node consensus/read repair is investigated, or whether the server config should be changed to make 5 nodes transaction-safe.

3. Run one more warm Docker-volume pass to confirm all build caches skip together after the new marker files have been written.

   ```bash
   docker compose --env-file local-network.env -f docker-compose.local.yml up --build
   ```

4. Confirm Docker health does not turn healthy until the latest cycle is in processing mode.

   Useful checks:

   ```bash
   docker compose --env-file local-network.env -f docker-compose.local.yml ps
   docker exec client-testing-local-network-1 bash -lc 'curl -fsS http://127.0.0.1:4000/cycleinfo/1 | jq ".cycleInfo[0] | {counter, mode, active, desired, syncing, target}"'
   ```

5. Rerun the smoke test after choosing the node count/config path.

6. If the network never reaches processing, inspect Shardus node logs:

   ```bash
   docker exec client-testing-local-network-1 bash -lc 'tail -160 /workspace/runtime/server/instances/shardus-instance-9001/logs/cycle.log'
   docker exec client-testing-local-network-1 bash -lc 'tail -160 /workspace/runtime/server/instances/shardus-instance-9001/logs/p2p.log'
   docker exec client-testing-local-network-1 bash -lc 'tail -160 /workspace/runtime/server/instances/archiver-logs/127.0.0.1_4000/main.log'
   ```

7. Once the local path is stable, adapt this into GitHub Actions.

   The likely workflow shape is:

   - checkout `client-testing`
   - checkout sibling `server`, `liberdus-proxy`, and `web-client-v2`
   - run `docker compose -f docker-compose.local.yml up --build -d`
   - wait for Docker health
   - set `PLAYWRIGHT_BASE_URL=http://127.0.0.1:8080/`
   - run a smoke test first
   - expand to the broader suite after stability is proven

## Notes For The Next Thread

Start by reading this file and checking the branch diff. The most recent change is the default 5-node stack plus source-aware build cache markers in:

- `scripts/local-network/start.sh`
- `docker-compose.local.yml`
- `local-network.env.example`

There is an unrelated untracked file in this worktree that was intentionally not included:

```text
playwright-tests/tests/web-client-v2.code-workspace
```
