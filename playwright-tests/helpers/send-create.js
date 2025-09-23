// Minimal funding helper for tests
const networkParams = require('./networkParams');
const { getUserData } = require('./localStorageHelpers');

// Minimal bigint-safe stringify mirroring @shardus/types Utils.safeStringify
function safeStringify(obj) {
  return JSON.stringify(
    obj,
    (_, v) => (typeof v === 'bigint' ? { dataType: 'bi', value: v.toString(16) } : v)
  );
}

// Convert LIB amount to wei (18 decimals)
function libToWei(amountLib) {
  if (typeof amountLib === 'bigint') return amountLib;
  const s = typeof amountLib === 'number' ? amountLib.toFixed(18) : String(amountLib);
  const [i = '0', f = ''] = s.split('.');
  const frac = (f + '0'.repeat(18)).slice(0, 18);
  return BigInt(i + frac);
}

// Low-level POST JSON helper using global fetch
async function postJson(url, json) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(json),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  const obj = text ? JSON.parse(text) : {};
  const result = obj && typeof obj === 'object' ? (obj.result || obj) : undefined;
  if (obj?.error) throw new Error(obj.error.reason || obj.error.message || text);
  if (result && result.success === false) throw new Error(result.reason || result.message || text);
  return obj;
}

// POST an unsigned "create" tx to the gateway's /inject endpoint
async function sendCreate(gatewayWebUrl, accountId, amountWei, networkId) {
  const amt = typeof amountWei === 'bigint' ? amountWei : BigInt(String(amountWei));
  const addr = accountId + '0'.repeat(24); // expand short address
  const tx = {
    type: 'create',
    from: addr,
    amount: amt,
    timestamp: Date.now(),
    networkId,
  };

  const payload = { tx: safeStringify(tx) };
  const url = `${gatewayWebUrl.replace(/\/+$/, '')}/inject`;
  try {
    return await postJson(url, payload);
  } catch (err) {
    throw new Error(`sendCreate failed: ${err && err.message ? err.message : String(err)}`);
  }
}

// Helper: extract on-chain address and networkId from localStorage
function getUserAddressFromLocalStorage(localStorageObj, username) {
  const user = getUserData(localStorageObj, username);
  return user?.account?.keys?.address;
}

// Fund a given address with the specified LIB amount using gateway from cached params
async function fundAddressLib(address, amountLib, networkId, pollOpts) {
  const gatewayWeb = networkParams.gateway;
  const resp = await sendCreate(gatewayWeb, address, libToWei(amountLib), networkId);
  const txid = extractTxId(resp);
  return txid ? await waitForTransaction(gatewayWeb, txid, pollOpts) : resp;
}

// Convenience: fund a user (by username) observed in a Playwright page's localStorage
async function fundUserFromPage(page, username, amountLib, pollOpts) {
  const localStorageObj = await page.evaluate(() => ({ ...window.localStorage }));
  const address = getUserAddressFromLocalStorage(localStorageObj, username);
  const networkId = getUserNetworkIdFromLocalStorage(localStorageObj, username);
  return await fundAddressLib(address, amountLib, networkId, pollOpts);
}

function getUserNetworkIdFromLocalStorage(localStorageObj, username) {
  const user = getUserData(localStorageObj, username);
  return user?.account?.netid;
}

// --- Polling helpers ---
const joinUrl = (a, b) => a.replace(/\/$/, '') + (b.startsWith('/') ? b : `/${b}`);

function extractTxId(resp) {
  if (!resp || typeof resp !== 'object') return undefined;
  if (resp.txId || resp.txid) return resp.txId || resp.txid;
  if (resp.result && (resp.result.txId || resp.result.txid)) return resp.result.txId || resp.result.txid;
  return undefined;
}

async function pollTransaction({ baseUrl, txid, pollIntervalMs = 2000, collectorAfterMs = 20000, timeoutMs = 30000 }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const elapsed = Date.now() - start;
    const endpoint = elapsed > collectorAfterMs
      ? `/collector/api/transaction?appReceiptId=${encodeURIComponent(txid)}`
      : `/transaction/${encodeURIComponent(txid)}`;
    try {
      const res = await fetch(joinUrl(baseUrl, endpoint), { method: 'GET', headers: { Accept: 'application/json' } });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const tx = data?.transaction || data?.result || data;
        if (elapsed > timeoutMs && (!tx || (typeof tx === 'object' && Object.keys(tx).length === 0))) {
          return { status: 'timeout' };
        }
        if (tx?.success === true) {
          return { status: 'success', receipt: tx };
        }
        if (tx?.success === false) {
          return { status: 'failed', reason: tx?.reason || 'Transaction failed', receipt: tx };
        }
      }
    } catch {
      // ignore and retry
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return { status: 'timeout' };
}

async function waitForTransaction(baseUrl, txid, opts = {}) {
  const { status, reason, receipt } = await pollTransaction({ baseUrl, txid, ...opts });
  if (status === 'success') return receipt;
  if (status === 'failed') throw new Error(reason || 'Transaction failed');
  throw new Error('Transaction polling timed out');
}

module.exports = {
  libToWei,
  fundAddressLib,
  fundUserFromPage,
  pollTransaction,
  waitForTransaction,
};

