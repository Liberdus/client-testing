#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ZERO_ACCOUNT = '0000000000000000000000000000000000000000000000000000000000000000';
const ARCHIVER_SEED = [{ publicKey: '758b1c119412298802cd28dbfa394cdfeecc4074492d60844cc192d632d84de3', port: 4000, ip: '127.0.0.1' }];
const SOURCE_EXCLUDES = {
  server: ['.git', 'node_modules', 'instances', 'dist'],
  proxy: ['.git', 'target'],
  web: ['.git', 'node_modules'],
};

const state = {
  serverDir: undefined,
  proxyProcess: undefined,
  webProcess: undefined,
  shuttingDown: false,
};

// ----------------------------- basic helpers -----------------------------

// Prefixes every line we own so Docker/CI logs are easy to scan.
function log(message) {
  process.stderr.write(`[liberdus-local] ${message}\n`);
}

// Reads an environment variable with a fallback.
function env(name, fallback) {
  return process.env[name] || fallback;
}

// Reads an integer environment variable with validation.
function intEnv(name, fallback) {
  const value = Number.parseInt(env(name, String(fallback)), 10);
  if (!Number.isFinite(value)) throw new Error(`Expected ${name} to be an integer`);
  return value;
}

// Pauses async polling loops.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Builds the runtime configuration once so the startup flow can pass one object around.
function buildConfig() {
  const runtimeRoot = env('LIBERDUS_RUNTIME_ROOT', '/workspace/runtime');
  const nodeCount = intEnv('LIBERDUS_NODE_COUNT', 10);
  const proxyBindPort = intEnv('LIBERDUS_PROXY_BIND_PORT', 3030);

  return {
    runtimeRoot,
    nodeCount,
    sources: {
      server: env('LIBERDUS_SERVER_SOURCE', '/sources/server'),
      proxy: env('LIBERDUS_PROXY_SOURCE', '/sources/liberdus-proxy'),
      web: env('LIBERDUS_WEB_CLIENT_SOURCE', '/sources/web-client-v2'),
    },
    paths: {
      server: path.join(runtimeRoot, 'server'),
      proxy: path.join(runtimeRoot, 'liberdus-proxy'),
      web: path.join(runtimeRoot, 'web-client-v2'),
      logs: path.join(runtimeRoot, 'logs'),
    },
    ports: {
      externalStart: intEnv('LIBERDUS_EXTERNAL_PORT_START', 9001),
      internalStart: intEnv('LIBERDUS_INTERNAL_PORT_START', 10001),
      proxyBind: proxyBindPort,
      proxyWsBind: proxyBindPort + 1,
      proxyPublic: intEnv('LIBERDUS_PROXY_PUBLIC_PORT', 3030),
      proxyWsPublic: intEnv('LIBERDUS_PROXY_WS_PUBLIC_PORT', 3031),
      webBind: intEnv('LIBERDUS_WEB_BIND_PORT', 8080),
      webPublic: intEnv('LIBERDUS_WEB_PUBLIC_PORT', 8080),
      monitorPublic: intEnv('LIBERDUS_MONITOR_PUBLIC_PORT', 3000),
    },
    publicHost: env('LIBERDUS_PUBLIC_HOST', '127.0.0.1'),
    toolchains: {
      serverRust: env('LIBERDUS_SERVER_RUST_TOOLCHAIN', '1.79.0'),
      proxyRust: env('LIBERDUS_PROXY_RUST_TOOLCHAIN', '1.86.0'),
    },
  };
}

// Runs a command synchronously, streaming output by default.
function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    encoding: options.encoding === false ? undefined : 'utf8',
    stdio: options.stdio || 'inherit',
  });

  if (result.error && !options.allowFailure) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`Command failed with exit ${result.status}: ${command} ${args.join(' ')}`);
  }

  return result;
}

// Runs a command and returns trimmed stdout.
function capture(command, args, options = {}) {
  const result = run(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  return String(result.stdout || '').trim();
}

// Checks whether a command is available in the container.
function commandExists(command) {
  return spawnSync('bash', ['-lc', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
}

// Ensures a required source checkout exists before the expensive work begins.
function requireDir(label, dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Missing ${label}: ${dir}`);
  }
}

// Writes a file, creating parent directories when needed.
function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

// Normalizes a directory path for rsync source and destination arguments.
function trailingSlash(dir) {
  return dir.endsWith(path.sep) || dir.endsWith('/') ? dir : `${dir}/`;
}

// ----------------------------- hashing/cache ------------------------------

// Hashes one file, returning a stable marker for optional missing files.
function hashFile(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    ? crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
    : 'missing';
}

// Recursively lists the requested files/directories that actually exist.
function listFiles(root, requestedPaths) {
  const files = [];

  function walk(absolutePath, relativePath) {
    const stat = fs.statSync(absolutePath);
    if (stat.isFile()) return files.push(relativePath);
    if (!stat.isDirectory()) return;
    for (const entry of fs.readdirSync(absolutePath).sort()) {
      walk(path.join(absolutePath, entry), path.posix.join(relativePath, entry));
    }
  }

  for (const requestedPath of requestedPaths) {
    const absolutePath = path.join(root, requestedPath);
    if (fs.existsSync(absolutePath)) walk(absolutePath, requestedPath);
  }

  return files.sort();
}

// Hashes a selected source surface to decide whether a cached build is reusable.
function hashPaths(root, requestedPaths) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return 'missing';

  const files = listFiles(root, requestedPaths);
  if (files.length === 0) return 'missing';

  const digest = crypto.createHash('sha256');
  for (const relativePath of files) {
    digest.update(`${relativePath}\0${hashFile(path.join(root, relativePath))}\0`);
  }
  return digest.digest('hex');
}

// Checks a cache marker and the concrete files required by that cache.
function cacheValid(markerFile, expectedMarker, requiredPaths) {
  return fs.existsSync(markerFile)
    && fs.readFileSync(markerFile, 'utf8') === expectedMarker
    && requiredPaths.every((requiredPath) => fs.existsSync(requiredPath));
}

// Computes all cache keys from source, lockfiles, and toolchain versions.
function buildCacheMarkers(cfg) {
  const serverDepMarker = [
    `node=${capture('node', ['--version'])}`,
    `rust=${capture('rustc', [`+${cfg.toolchains.serverRust}`, '--version'])}`,
    `package=${hashFile(path.join(cfg.paths.server, 'package.json'))}`,
    `lock=${hashFile(path.join(cfg.paths.server, 'package-lock.json'))}`,
  ].join(';');

  return {
    serverDeps: serverDepMarker,
    serverBuild: `${serverDepMarker};source=${hashPaths(cfg.paths.server, ['package.json', 'package-lock.json', 'tsconfig.json', 'src', 'client.js'])}`,
    proxyBuild: [
      `rust=${capture('rustc', [`+${cfg.toolchains.proxyRust}`, '--version'])}`,
      `source=${hashPaths(cfg.paths.proxy, ['Cargo.toml', 'Cargo.lock', 'src'])}`,
    ].join(';'),
  };
}

// ----------------------------- HTTP/waiting -------------------------------

// Fetches text over HTTP or HTTPS with a short timeout.
function requestText(url, options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  const failOnStatus = options.failOnStatus !== false;
  const client = url.startsWith('https:') ? https : http;

  return new Promise((resolve, reject) => {
    const request = client.get(url, (response) => {
      const chunks = [];
      if (failOnStatus && (response.statusCode < 200 || response.statusCode >= 300)) {
        response.resume();
        return reject(new Error(`HTTP ${response.statusCode} from ${url}`));
      }
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Timed out requesting ${url}`)));
    request.on('error', reject);
  });
}

// Polls until a check returns a truthy value, then returns that value.
async function waitUntil(label, timeoutSeconds, check, intervalMs = 5000) {
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

// Polls a JSON endpoint until it satisfies a predicate.
function waitForJson(url, predicate, timeoutSeconds, label) {
  return waitUntil(`${label} from ${url}`, timeoutSeconds, async () => {
    try {
      return predicate(JSON.parse(await requestText(url, { timeoutMs: 5000 })));
    } catch {
      return false;
    }
  });
}

// Returns true when an HTTP endpoint responds at all.
async function httpResponds(url) {
  try {
    await requestText(url, { timeoutMs: 3000, failOnStatus: false });
    return true;
  } catch {
    return false;
  }
}

// Waits for an HTTP endpoint, optionally suppressing the timeout log.
async function waitForHttp(url, timeoutSeconds, label, quiet = false) {
  try {
    await waitUntil(`${label} from ${url}`, timeoutSeconds, () => httpResponds(url), 2000);
    return true;
  } catch (error) {
    if (!quiet) log(error.message);
    return false;
  }
}

// Waits until the proxy and archiver expose the local network id.
function waitForNetworkId(cfg) {
  const accountUrl = `http://127.0.0.1:${cfg.ports.proxyBind}/account/${ZERO_ACCOUNT}`;
  const cycleUrl = 'http://127.0.0.1:4000/cycleinfo/1';

  return waitUntil(`network parameters from ${accountUrl}`, 600, async () => {
    if (childExited(state.proxyProcess)) {
      throw new Error(`Proxy exited while waiting for network parameters; see ${path.join(cfg.paths.logs, 'proxy.log')}`);
    }

    try {
      const account = JSON.parse(await requestText(accountUrl, { timeoutMs: 5000 }));
      const cycle = JSON.parse(await requestText(cycleUrl, { timeoutMs: 5000 }));
      return account.account && account.account.type === 'NetworkAccount'
        ? cycle.cycleInfo && cycle.cycleInfo[0] && cycle.cycleInfo[0].networkId
        : '';
    } catch {
      return '';
    }
  });
}

// ----------------------------- PM2/readiness ------------------------------

// Returns true when a spawned child has already exited.
function childExited(child) {
  return child && (child.exitCode !== null || child.signalCode !== null);
}

// Returns the Shardus PM2 home for this runtime volume.
function pm2Home(cfg) {
  return path.join(cfg.paths.server, 'instances', '.pm2');
}

// Extracts the first complete JSON array from noisy PM2 stdout.
function extractJsonArray(text) {
  const start = String(text).indexOf('[');
  if (start === -1) return '[]';

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === '[') depth += 1;
    if (char === ']' && --depth === 0) return text.slice(start, index + 1);
  }

  return '[]';
}

// Reads PM2 process metadata, tolerating empty or noisy output.
function pm2Processes(cfg) {
  const result = run('pm2', ['jlist'], {
    allowFailure: true,
    env: { PM2_HOME: pm2Home(cfg) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    return JSON.parse(extractJsonArray(result.stdout || ''));
  } catch {
    return [];
  }
}

// Finds a PM2 process id by Shardus process name.
function pm2ProcessIdByName(cfg, name) {
  const processEntry = pm2Processes(cfg).find((entry) => String(entry.name || '').replace(/"/g, '') === name);
  return processEntry ? String(processEntry.pm_id) : '';
}

// Restarts one PM2 process by name.
function restartPm2ProcessByName(cfg, name) {
  const pm2Id = pm2ProcessIdByName(cfg, name);
  if (!pm2Id) throw new Error(`Could not find PM2 process named ${name}`);
  run('pm2', ['restart', pm2Id, '--no-color'], { env: { PM2_HOME: pm2Home(cfg) }, stdio: 'ignore' });
}

// Restarts the monitor once if PM2 says it is online but the port never binds.
async function ensureMonitorReady(cfg) {
  const initialTimeout = intEnv('LIBERDUS_MONITOR_READY_TIMEOUT', 60);
  const restartTimeout = intEnv('LIBERDUS_MONITOR_RESTART_READY_TIMEOUT', 120);
  const monitorUrl = 'http://127.0.0.1:3000/';

  if (await waitForHttp(monitorUrl, initialTimeout, 'monitor', true)) return;

  log(`Monitor did not bind on port 3000 after ${initialTimeout}s; restarting monitor-server once`);
  restartPm2ProcessByName(cfg, 'monitor-server');
  if (!await waitForHttp(monitorUrl, restartTimeout, 'monitor')) {
    throw new Error('Monitor did not become ready after restart');
  }
}

// Checks a local TCP listener, preferring lsof to handle IPv6 wildcard sockets.
async function portListening(port) {
  if (commandExists('lsof')) {
    return run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { allowFailure: true, stdio: 'ignore' }).status === 0;
  }

  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port, timeout: 1000 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(false));
  });
}

// Lists validator ports that are not listening yet.
async function missingValidatorPorts(cfg) {
  const missing = [];
  const { externalStart } = cfg.ports;

  for (let port = externalStart; port < externalStart + cfg.nodeCount; port += 1) {
    if (!await portListening(port)) missing.push(port);
  }

  return missing;
}

// Waits for every validator port to bind.
async function waitForValidatorPorts(cfg, timeoutSeconds) {
  let missing = [];

  try {
    await waitUntil('validator ports to bind', timeoutSeconds, async () => {
      missing = await missingValidatorPorts(cfg);
      return missing.length === 0;
    });
    return true;
  } catch {
    log(`Timed out waiting for validator ports to bind: ${missing.join(' ')}`);
    return false;
  }
}

// Restarts validators once if their PM2 process is online but the port is not bound.
async function ensureValidatorPortsReady(cfg) {
  const initialTimeout = intEnv('LIBERDUS_VALIDATOR_PORT_READY_TIMEOUT', 60);
  const restartTimeout = intEnv('LIBERDUS_VALIDATOR_RESTART_READY_TIMEOUT', 180);

  if (await waitForValidatorPorts(cfg, initialTimeout)) return;

  const missing = await missingValidatorPorts(cfg);
  log(`Restarting validators that did not bind after ${initialTimeout}s: ${missing.join(' ')}`);
  for (const port of missing) restartPm2ProcessByName(cfg, `shardus-instance-${port}`);

  if (!await waitForValidatorPorts(cfg, restartTimeout)) {
    throw new Error('Validator ports did not become ready after restart');
  }
}

// ----------------------------- config writers -----------------------------

// Ensures a nested object exists before assigning generated local config.
function ensureObject(parent, key) {
  if (!parent[key] || typeof parent[key] !== 'object' || Array.isArray(parent[key])) parent[key] = {};
  return parent[key];
}

// Writes proxy config for a standalone local network.
function writeProxyConfig(cfg) {
  const configPath = path.join(cfg.paths.proxy, 'src', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  config.http_port = cfg.ports.proxyBind;
  config.archiver_seed_path = './src/archiver_seed.json';
  Object.assign(ensureObject(config, 'standalone_network'), { enabled: true, replacement_ip: '127.0.0.1' });
  Object.assign(ensureObject(config, 'node_filtering'), {
    enabled: false,
    remove_top_nodes: 0,
    remove_bottom_nodes: 0,
    min_nodes_for_filtering: 0,
  });
  Object.assign(ensureObject(config, 'shardus_monitor'), { upstream_ip: '127.0.0.1', upstream_port: 3000, https: false });
  Object.assign(ensureObject(config, 'local_source'), {
    collector_api_ip: '127.0.0.1',
    collector_api_port: 6101,
    collector_event_server_ip: '127.0.0.1',
    collector_event_server_port: 4444,
  });
  Object.assign(ensureObject(config, 'notifier'), { ip: '127.0.0.1', port: 4444 });

  writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writeFile(path.join(cfg.paths.proxy, 'src', 'archiver_seed.json'), `${JSON.stringify(ARCHIVER_SEED)}\n`);
}

// Writes the web client's local network.js from the detected network id.
function writeWebNetwork(cfg, networkId) {
  const network = {
    name: 'Localnet',
    netid: networkId,
    netids: [networkId],
    gateways: [{ web: `http://${cfg.publicHost}:${cfg.ports.proxyPublic}`, ws: `ws://${cfg.publicHost}:${cfg.ports.proxyWsPublic}` }],
    bridges: [
      { name: 'Polygon', username: 'bridgepolygon' },
      { name: 'Ethereum', username: 'bridgeeth' },
      { name: 'BSC', username: 'bridgebsc' },
    ],
    farmUrl: 'https://liberdus.com/farm',
    validatorUrl: 'https://liberdus.com/validator',
    bridgeUrl: './bridge',
  };

  writeFile(path.join(cfg.paths.web, 'network.js'), `const network = ${JSON.stringify(network, null, 2)}\n`);
}

// ----------------------------- startup phases -----------------------------

// Validates source checkouts and the proxy branch requirement.
function validateSources(cfg) {
  requireDir('server source', cfg.sources.server);
  requireDir('liberdus-proxy source', cfg.sources.proxy);
  requireDir('web-client-v2 source', cfg.sources.web);

  const liberdusRs = path.join(cfg.sources.proxy, 'src', 'liberdus.rs');
  const proxySource = fs.existsSync(liberdusRs) ? fs.readFileSync(liberdusRs, 'utf8') : '';
  if (!proxySource.includes('foundationNode')) {
    throw new Error([
      'The configured liberdus-proxy checkout does not support the current archiver nodelist response.',
      'Use a liberdus-proxy branch that includes the foundationNode nodelist fix, such as origin/new-nodelist-response.',
    ].join('\n'));
  }
}

// Copies read-only mounted repos into the writable runtime volume.
function syncSources(cfg) {
  fs.mkdirSync(cfg.paths.logs, { recursive: true });
  log('Syncing source repos into Docker volume');

  for (const [name, destination] of Object.entries(cfg.paths)) {
    if (name === 'logs') continue;
    const excludes = SOURCE_EXCLUDES[name].flatMap((entry) => ['--exclude', entry]);
    run('rsync', ['-a', '--delete', ...excludes, trailingSlash(cfg.sources[name]), trailingSlash(destination)]);
  }
}

// Installs server dependencies and compiles dist when the cache marker is stale.
function prepareServer(cfg, markers) {
  const nodeModules = path.join(cfg.paths.server, 'node_modules');
  const dist = path.join(cfg.paths.server, 'dist');
  const depsMarker = path.join(nodeModules, '.local-network-build');
  const buildMarker = path.join(dist, '.local-network-build');
  let depsWereCached = false;

  if (cacheValid(depsMarker, markers.serverDeps, [path.join(nodeModules, '.bin', 'shardus')])) {
    depsWereCached = true;
    log('Reusing cached server dependencies');
  } else {
    log('Installing server dependencies');
    fs.rmSync(nodeModules, { recursive: true, force: true });
    run('npm', ['install'], { cwd: cfg.paths.server, env: { RUSTUP_TOOLCHAIN: cfg.toolchains.serverRust } });
    writeFile(depsMarker, markers.serverDeps);
  }

  if (cacheValid(buildMarker, markers.serverBuild, [path.join(dist, 'index.js')])) {
    log('Reusing cached server build');
  } else if (!depsWereCached && fs.existsSync(path.join(dist, 'index.js'))) {
    log('Using server build produced during dependency install');
    writeFile(buildMarker, markers.serverBuild);
  } else {
    log('Compiling server');
    run('npm', ['run', 'compile'], { cwd: cfg.paths.server, env: { RUSTUP_TOOLCHAIN: cfg.toolchains.serverRust } });
    writeFile(buildMarker, markers.serverBuild);
  }
}

// Clears old Shardus/PM2 state before starting a fresh network.
function resetShardusState(cfg) {
  process.env.PATH = `${path.join(cfg.paths.server, 'node_modules', '.bin')}:${process.env.PATH}`;
  log('Resetting any previous Shardus instances');

  run('shardus', ['stop'], { allowFailure: true, cwd: cfg.paths.server, stdio: 'ignore' });
  if (fs.existsSync(pm2Home(cfg))) {
    run('pm2', ['kill'], { allowFailure: true, env: { PM2_HOME: pm2Home(cfg) }, stdio: 'ignore' });
  }
  fs.rmSync(path.join(cfg.paths.server, 'instances'), { recursive: true, force: true });
}

// Starts Shardus using the normal shardus start command.
function startShardus(cfg) {
  process.env.minNodes = String(cfg.nodeCount);
  process.env.baselineNodes = String(cfg.nodeCount);
  process.env.maxNodes = String(cfg.nodeCount * 2);

  log(`Starting ${cfg.nodeCount}-node Shardus network on validator ports ${cfg.ports.externalStart}-${cfg.ports.externalStart + cfg.nodeCount - 1}`);
  if (cfg.ports.externalStart !== 9001 || cfg.ports.internalStart !== 10001) {
    run('shardus', [
      'create',
      '--no-start',
      '--starting-external-port', String(cfg.ports.externalStart),
      '--starting-internal-port', String(cfg.ports.internalStart),
      String(cfg.nodeCount),
      'pm2--no-autorestart',
    ], { cwd: cfg.paths.server });
  }

  run('shardus', ['start', String(cfg.nodeCount), 'pm2--no-autorestart'], { cwd: cfg.paths.server });
}

// Waits for the network state needed before app transactions can succeed.
async function waitForShardusReady(cfg) {
  log('Waiting for archiver, monitor, and active nodelist');
  await waitForJson('http://127.0.0.1:4000/archivers', (data) => ((data.activeArchivers || data.archivers || []).length) > 0, 600, 'active archivers');
  await ensureMonitorReady(cfg);
  await ensureValidatorPortsReady(cfg);
  await waitForJson('http://127.0.0.1:4000/full-nodelist?activeOnly=true', (data) => ((data.nodeList || data.nodes || data.nodelist || []).length) > 0, 600, 'active nodelist');
  await waitForJson('http://127.0.0.1:4000/cycleinfo/1', (data) => (
    Array.isArray(data.cycleInfo)
    && data.cycleInfo.length > 0
    && data.cycleInfo[0].mode === 'processing'
    && Number(data.cycleInfo[0].active || 0) >= cfg.nodeCount
  ), 2400, 'processing cycle');
}

// Builds liberdus-proxy when its source or Rust toolchain marker changes.
function prepareProxy(cfg, markers) {
  const target = path.join(cfg.paths.proxy, 'target');
  const proxyBin = path.join(target, 'debug', 'liberdus-proxy');
  const marker = path.join(target, '.local-network-build');

  if (cacheValid(marker, markers.proxyBuild, [proxyBin])) {
    log('Reusing cached Liberdus proxy build');
    return;
  }

  log('Building Liberdus proxy');
  fs.rmSync(target, { recursive: true, force: true });
  run('cargo', [`+${cfg.toolchains.proxyRust}`, 'build'], { cwd: cfg.paths.proxy });
  writeFile(marker, markers.proxyBuild);
}

// Starts a child process with stdout/stderr redirected to a runtime log file.
function startLoggedProcess(label, command, args, cwd, logFile) {
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', fd, fd] });

  child.on('exit', (code, signal) => {
    if (!state.shuttingDown) log(`${label} exited with ${signal || code}; see ${logFile}`);
  });
  child.on('error', (error) => {
    if (!state.shuttingDown) log(`${label} failed to start: ${error.message}`);
  });

  return child;
}

// Starts the proxy, waits for network id, writes network.js, then serves the web client.
async function startProxyAndWeb(cfg) {
  log('Starting Liberdus proxy');
  state.proxyProcess = startLoggedProcess('Liberdus proxy', './target/debug/liberdus-proxy', [], cfg.paths.proxy, path.join(cfg.paths.logs, 'proxy.log'));

  const networkId = await waitForNetworkId(cfg);
  log(`Detected local network id: ${networkId}`);
  writeWebNetwork(cfg, networkId);

  log(`Starting web client on http://${cfg.publicHost}:${cfg.ports.webPublic}/`);
  state.webProcess = startLoggedProcess(
    'Web client server',
    'python3',
    ['-m', 'http.server', String(cfg.ports.webBind), '--bind', '0.0.0.0'],
    cfg.paths.web,
    path.join(cfg.paths.logs, 'web-client.log'),
  );
}

// Keeps the container alive and fails if a foreground child exits.
async function watchChildren(cfg) {
  log('Local network is ready');
  log(`Monitor: http://${cfg.publicHost}:${cfg.ports.monitorPublic}/`);
  log(`Proxy: http://${cfg.publicHost}:${cfg.ports.proxyPublic}/ (binds ${cfg.ports.proxyBind}/${cfg.ports.proxyWsBind})`);
  log(`Web client: http://${cfg.publicHost}:${cfg.ports.webPublic}/`);

  while (true) {
    if (childExited(state.proxyProcess)) throw new Error(`Proxy exited; see ${path.join(cfg.paths.logs, 'proxy.log')} in the local-network-runtime volume`);
    if (childExited(state.webProcess)) throw new Error(`Web client server exited; see ${path.join(cfg.paths.logs, 'web-client.log')} in the local-network-runtime volume`);
    await sleep(5000);
  }
}

// Stops child services when the container exits or receives a signal.
function stopStack() {
  if (state.shuttingDown) return;
  state.shuttingDown = true;

  if (state.serverDir && fs.existsSync(state.serverDir)) {
    log('Stopping Shardus network');
    run('shardus', ['stop'], {
      allowFailure: true,
      cwd: state.serverDir,
      env: { PATH: `${path.join(state.serverDir, 'node_modules', '.bin')}:${process.env.PATH}` },
      stdio: 'ignore',
    });
  }

  if (state.proxyProcess && !childExited(state.proxyProcess)) state.proxyProcess.kill('SIGTERM');
  if (state.webProcess && !childExited(state.webProcess)) state.webProcess.kill('SIGTERM');
}

// Installs shutdown handlers once at process startup.
function installSignalHandlers() {
  process.once('exit', stopStack);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      stopStack();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
}

// ----------------------------- main runbook -------------------------------

// Runs the local-network startup sequence from sources to ready web client.
async function main() {
  installSignalHandlers();

  const cfg = buildConfig();
  state.serverDir = cfg.paths.server;

  // Validate source checkouts before doing expensive install/build work.
  validateSources(cfg);

  // Copy mounted repos into the writable runtime volume and write generated config.
  syncSources(cfg);
  writeProxyConfig(cfg);

  // Reuse server/proxy builds when source, lockfiles, and toolchains match.
  const markers = buildCacheMarkers(cfg);
  prepareServer(cfg, markers);

  // Start Shardus and wait until the network is in processing mode.
  resetShardusState(cfg);
  startShardus(cfg);
  await waitForShardusReady(cfg);

  // Start proxy/web only after Shardus can accept app transactions.
  prepareProxy(cfg, markers);
  await startProxyAndWeb(cfg);

  // Keep PID 1 alive while the child services stay healthy.
  await watchChildren(cfg);
}

main().catch((error) => {
  log(error && error.stack ? error.stack : String(error));
  stopStack();
  process.exit(1);
});
