/**
 * Playwright global setup
 *
 * Purpose:
 *  - Read `baseURL` from Playwright's resolved config
 *  - Fetch `${baseURL}/network.js` and extract the first gateway web URL
 *  - Fetch the zero-account from the gateway and read network parameters
 *  - Convert USD values to LIB using stabilityFactor
 *  - Write a fresh cache file for tests to synchronously consume
 *
 * Strictness:
 *  - If any step fails, throw to abort the test run
 *  - No hardcoded fallbacks for network params
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

function resolveBaseURL(config) {
  const envBaseURL = process.env.PLAYWRIGHT_BASE_URL || process.env.BASE_URL;
  if (envBaseURL) return envBaseURL;

  const projectBaseURL = config && config.projects && config.projects[0] && config.projects[0].use
    ? config.projects[0].use.baseURL
    : undefined;
  if (projectBaseURL) return projectBaseURL;

  const sharedBaseURL = config && config.use ? config.use.baseURL : undefined;
  if (sharedBaseURL) return sharedBaseURL;

  throw new Error('baseURL not found in Playwright config');
}

/**
 * Fetch remote text with a timeout and redirect limit.
 * @param {string} url
 * @param {number} timeoutMs - request timeout in ms (default 15000)
 * @param {number} maxRedirects - maximum number of redirects to follow (default 5)
 */
function fetchText(url, timeoutMs = 15000, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const requestOnce = (u, redirects = 0) => {
      const lib = u.startsWith('https') ? https : http;
      const req = lib.get(u, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects >= maxRedirects) {
            reject(new Error(`Too many redirects fetching ${u}`));
            return;
          }
          requestOnce(res.headers.location, redirects + 1);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} fetching ${u}`));
          return;
        }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Request timed out after ${timeoutMs}ms for ${u}`));
      });
      req.on('error', reject);
    };
    requestOnce(url);
  });
}

function parseNumber(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseLiberdusAmount(value, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') return parseNumber(value, fallback);
  if (!value || typeof value !== 'object') return fallback;

  if (value.dataType === 'bi' && typeof value.value === 'string') {
    try {
      return Number(BigInt('0x' + value.value)) / 1e18;
    } catch {
      return fallback;
    }
  }

  if ('value' in value) return parseNumber(value.value, fallback);
  return fallback;
}

async function globalSetup(config) {
  const outDir = path.resolve(__dirname, '..', '.cache');
  // Clear any previous cache to ensure fresh fetch each run
  try {
    fs.rmSync(outDir, { recursive: true, force: true });
  } catch {}
  fs.mkdirSync(outDir, { recursive: true });

  // 1) Discover base URL from Playwright's resolved config
  const baseURL = resolveBaseURL(config);
  const networkJsUrl = baseURL.replace(/\/+$/, '') + '/network.js';

  // 2) Fetch and evaluate network.js to extract gateway web URL
  const js = await fetchText(networkJsUrl);
  const vm = require('vm');
  const sandbox = {};
  vm.createContext(sandbox);
  const sanitized = js
    .replace(/export\s+default\s+network\s*;?/g, '')
    .replace(/module\.exports\s*=\s*network\s*;?/g, '');
  vm.runInContext(
    sanitized + '\n;globalThis.__network__ = typeof network !== "undefined" ? network : (typeof globalThis.network !== "undefined" ? globalThis.network : undefined);',
    sandbox,
    { timeout: 2000 }
  );
  const net = sandbox.__network__;
  if (!net || !Array.isArray(net.gateways) || !net.gateways[0] || !net.gateways[0].web) {
    throw new Error('gateway web not found in network.js');
  }
  const gatewayWeb = net.gateways[0].web;

  // 3) Fetch zero-account from gateway and derive network params
  const zeroAccountId = '0'.repeat(64);
  const acctUrl = gatewayWeb.replace(/\/+$/, '') + '/account/' + zeroAccountId;
  const acctText = await fetchText(acctUrl);
  const account = JSON.parse(acctText);
  const current = account && account.account && account.account.current ? account.account.current : {};

  const stabilityFactor = current.stabilityFactorStr
    ? parseNumber(current.stabilityFactorStr)
    : parseLiberdusAmount(current.stabilityScaleMul) / parseLiberdusAmount(current.stabilityScaleDiv, 1);
  const feeUsd = current.transactionFeeUsdStr
    ? parseNumber(current.transactionFeeUsdStr)
    : parseLiberdusAmount(current.transactionFee);
  const minTollUsd = current.minTollUsdStr
    ? parseNumber(current.minTollUsdStr)
    : parseLiberdusAmount(current.defaultToll);
  const networkTollTaxPercent = Number(current.tollNetworkTaxPercent || 0);

  // USD → LIB conversions using: LIB = USD / stabilityFactor
  const networkFeeLib = stabilityFactor > 0 && feeUsd > 0 ? feeUsd / stabilityFactor : NaN;
  const defaultTollLib = stabilityFactor > 0 && minTollUsd > 0 ? minTollUsd / stabilityFactor : NaN;

  // Validate derived values
  if (!(stabilityFactor > 0) || !Number.isFinite(networkFeeLib) || !Number.isFinite(defaultTollLib) || !(networkTollTaxPercent >= 0)) {
    throw new Error('Invalid or missing network parameters from gateway');
  }

  // 4) Persist cache for tests
  const payload = {
    baseURL,
    gatewayWeb,
    networkFeeLib: networkFeeLib,
    networkFeeUsd: feeUsd,
    defaultTollLib: defaultTollLib,
    defaultTollUsd: minTollUsd,
    stabilityFactor,
    networkTollTax: Number.isFinite(networkTollTaxPercent) ? networkTollTaxPercent / 100 : undefined,
    fetchedAt: Date.now()
  };
  fs.writeFileSync(path.join(outDir, 'network-params.json'), JSON.stringify(payload, null, 2));
}

module.exports = globalSetup;
