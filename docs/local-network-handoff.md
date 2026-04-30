# Local Network Docker Compose Handoff

Date: 2026-04-30
Branch: `client-testing-local-network`
Repository: `Liberdus/client-testing`

## Goal

Enable the Playwright tests in this repo to run against a locally started Liberdus network instead of only defaulting to `https://liberdus.com/dev/`.

The current implementation focuses on standing up the local network locally with Docker Compose. The next phase can wire the same approach into GitHub Actions once the local harness is stable.

## Current Status

The branch contains a Docker Compose based local-network harness and Playwright configuration changes. The local stack reached Docker `healthy` before the final readiness fix, and the web client served from:

- `http://127.0.0.1:8080/`
- proxy at `http://127.0.0.1:3030/`
- monitor at `http://127.0.0.1:3000/`

A Playwright smoke test was then run against the local web client. It reached account creation but failed because the Shardus network was still in `forming` mode and rejected app transactions with:

```text
Error injecting transaction: Application transactions are only allowed in processing Mode.
```

After that failure, the startup script and healthcheck were changed so the local stack waits for a `processing` cycle before declaring itself ready or serving the web client. That final processing-mode readiness change has had syntax/config validation but still needs a full Docker rerun.

## Files Changed

### Docker Compose Harness

- `.docker/local-network.Dockerfile`
  - Builds an Ubuntu 22.04 image.
  - Installs Node.js 20.19.3.
  - Installs two Rust toolchains:
    - Rust 1.82.0 for `server` native dependencies.
    - stable Rust for `liberdus-proxy`.
  - Installs the Shardus network CLI from `tools-cli-shardus-network`.
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
    - host `9101-9110` -> container validator ports `9001-9010`

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
  - Installs/compiles the server with Rust 1.82.0.
  - Starts a 10-node Shardus network.
  - Waits for:
    - active archiver
    - active nodelist
    - `cycleinfo` mode `processing`
  - Builds and starts the Rust proxy with stable Rust.
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

## Validation Run So Far

Commands that passed before this handoff:

```powershell
bash -n scripts/local-network/start.sh
bash -n scripts/local-network/healthcheck.sh
docker compose --env-file local-network.env.example -f docker-compose.local.yml config --quiet
cd playwright-tests
npm ci
npx playwright test --list tests/createAccount.e2e.test.js --project=chromium
```

Docker image build succeeded after resolving toolchain issues. The stack reached `healthy` before the final processing-mode gate was added.

The targeted Playwright smoke was run and failed because the network had not reached processing mode yet. That failure is the reason the final readiness gate was added.

## Important Findings

### Toolchain Split Is Necessary

The server and proxy currently need different Rust behavior:

- The server dependency tree built successfully with Rust 1.82.0.
- Newer stable Rust failed the server build because a native dependency denies warnings.
- The proxy has no committed `Cargo.lock`, and current dependency resolution pulls Rust-2024-era crates that need a newer stable compiler.

The Dockerfile therefore installs both Rust 1.82.0 and stable Rust, and the startup script selects the toolchain explicitly.

### Shardus Port Behavior

The Shardus CLI still creates node folders and validator listeners on `9001-9010`. Compose maps those to host ports `9101-9110` to avoid common host conflicts:

```text
host 9101 -> container 9001
host 9102 -> container 9002
...
host 9110 -> container 9010
```

Do not expect the folder names to match the host-facing ports.

### Readiness Needs Processing Mode

The proxy can serve the zero account while the network is still in `forming` mode. That is not enough for tests that submit app transactions.

The latest script now waits for:

```text
/cycleinfo/1 -> cycleInfo[0].mode == "processing"
```

and requires the active count to be at least `LIBERDUS_NODE_COUNT`.

This is the most important next thing to verify with a clean full rerun.

## Known Gaps / Next Steps

1. Rebuild and rerun the compose stack after the processing-mode readiness patch.

   ```bash
   docker compose --env-file local-network.env -f docker-compose.local.yml up --build
   ```

2. Confirm Docker health does not turn healthy until the latest cycle is in processing mode.

   Useful checks:

   ```bash
   docker compose --env-file local-network.env -f docker-compose.local.yml ps
   docker exec client-testing-local-network-1 bash -lc 'curl -fsS http://127.0.0.1:4000/cycleinfo/1 | jq ".cycleInfo[0] | {counter, mode, active, desired, syncing, target}"'
   ```

3. Rerun the smoke test.

4. If the network never reaches processing, inspect Shardus node logs:

   ```bash
   docker exec client-testing-local-network-1 bash -lc 'tail -160 /workspace/runtime/server/instances/shardus-instance-9001/logs/cycle.log'
   docker exec client-testing-local-network-1 bash -lc 'tail -160 /workspace/runtime/server/instances/shardus-instance-9001/logs/p2p.log'
   docker exec client-testing-local-network-1 bash -lc 'tail -160 /workspace/runtime/server/instances/archiver-logs/127.0.0.1_4000/main.log'
   ```

5. Once the local path is stable, adapt this into GitHub Actions.

   The likely workflow shape is:

   - checkout `client-testing`
   - checkout sibling `server`, `liberdus-proxy`, and `web-client-v2`
   - run `docker compose -f docker-compose.local.yml up --build -d`
   - wait for Docker health
   - set `PLAYWRIGHT_BASE_URL=http://127.0.0.1:8080/`
   - run a smoke test first
   - expand to the broader suite after stability is proven

## Notes For The Next Thread

Start by reading this file and checking the branch diff. The most recent unverified change is the processing-mode readiness gate in:

- `scripts/local-network/start.sh`
- `scripts/local-network/healthcheck.sh`

There is an unrelated untracked file in this worktree that was intentionally not included:

```text
playwright-tests/tests/web-client-v2.code-workspace
```
