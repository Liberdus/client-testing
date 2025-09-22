const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

function toNumber(val, def = 0) {
  const n = typeof val === 'string' ? parseFloat(val) : Number(val);
  return Number.isFinite(n) ? n : def;
}

function loadNetworkParams() {
  const defaultBalance = 50;

  try {
    const cachePath = path.resolve(__dirname, '..', '.cache', 'network-params.json');
    const raw = fs.readFileSync(cachePath, 'utf8');
    const cached = JSON.parse(raw);
    const stabilityFactor = toNumber(cached.stabilityFactor, NaN);
    const networkFeeLib = toNumber(cached.networkFeeLib, NaN);
    const networkFeeUsd = toNumber(cached.networkFeeUsd, NaN);
    const defaultTollLib = toNumber(cached.defaultTollLib, NaN);
    const defaultTollUsd = toNumber(cached.defaultTollUsd, NaN);
    const networkTollTax = toNumber(cached.networkTollTax, NaN);

    if (!(stabilityFactor > 0) || !Number.isFinite(networkFeeLib) || !Number.isFinite(defaultTollLib) || !Number.isFinite(networkTollTax)) {
      throw new Error('Network parameters cache missing or invalid');
    }

    return {
      networkFeeLib,
      networkFeeUsd,
      networkTollTax,
      defaultBalance,
      defaultTollLib,
      defaultTollUsd,
      stabilityFactor,
      _source: cached
    };
  } catch (err) {
    // No fallback for network-derived values: force tests to fail fast
    throw err instanceof Error ? err : new Error(String(err));
  }
}

// Resolve synchronously at require-time for compatibility with existing tests
const resolved = loadNetworkParams();

module.exports = resolved;