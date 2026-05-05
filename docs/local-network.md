# Local Network Test Stack

This starts a local Liberdus network, serves `web-client-v2`, and points Playwright at it instead of `https://liberdus.com/dev/`.

## What Runs

### GitHub Workflow

`.github/workflows/local-network-smoke.yml` is manual-only in this repo. It checks out the needed repos into `.deps/`, installs Playwright, starts Docker Compose, waits for Docker health, runs one smoke test, uploads logs, and stops the stack.

### Docker Compose

`docker-compose.local.yml` builds the local-network image, mounts the dependency repos, exposes local ports, and uses `healthcheck.sh` to decide when the stack is test-ready.

### Startup Script

`scripts/local-network/start.js` copies the mounted repos into a writable Docker volume, writes local proxy/web config, reuses cached builds when possible, starts a 10-node Shardus network, waits for `processing`, starts `liberdus-proxy`, writes `web-client-v2/network.js`, and serves the web client.

### Healthcheck

`scripts/local-network/healthcheck.sh` checks that `network.js` is served, the proxy can read the zero account, and the archiver reports `processing`.

## Run Locally

Create the dependency checkouts:

```powershell
New-Item -ItemType Directory -Force .deps
git clone https://github.com/Liberdus/server.git .deps/server
git clone --branch new-nodelist-response https://github.com/Liberdus/liberdus-proxy.git .deps/liberdus-proxy
git clone https://github.com/Liberdus/web-client-v2.git .deps/web-client-v2
```

Start the stack:

```powershell
docker compose -f docker-compose.local.yml up --build
```

Run the smoke test in another shell:

```powershell
cd playwright-tests
npm ci
$env:PLAYWRIGHT_BASE_URL='http://127.0.0.1:8080/'
npx playwright test tests/smoke.e2e.test.js --project=chromium --grep 'should navigate to Contacts and Wallet views' --workers=1 --retries=0
```

Stop the stack:

```powershell
docker compose -f docker-compose.local.yml down
```

Useful local URLs:

- Web client: `http://127.0.0.1:8080/`
- Proxy: `http://127.0.0.1:3030/`
- Monitor: `http://127.0.0.1:3000/`

If your repos are somewhere else, set `LIBERDUS_SERVER_DIR`, `LIBERDUS_PROXY_DIR`, and `LIBERDUS_WEB_CLIENT_DIR` before running Compose.
