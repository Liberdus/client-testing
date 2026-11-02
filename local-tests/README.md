# Offline wallet-price regressions

Use Node.js 20.19 or newer and select the exact implementation checkout:

```bash
WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2 node local-tests/tests/issue-1732-multichain-totals.test.mjs
WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2 node local-tests/tests/issue-1732-wallet-price-ui.test.mjs
```

The focused tests exercise real Multichain discovery/rendering, EVM catalog and
controller rendering, and native WalletScreen rendering with synthetic read-only
fixtures. They cover missing/partial/complete USD valuations, retained quantities,
known zeroes and zero prices, malformed price inputs, balance failures, recovery,
reset, and account changes. They do not use accounts, external services, signing,
or broadcasts.

For real browser/layout validation, reuse the repository's pinned Playwright
dependencies and their installed Chromium browser:

```bash
WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2 \
PLAYWRIGHT_ROOT=/absolute/path/to/client-testing/playwright-tests \
node local-tests/tests/issue-1732-price-availability.browser.test.mjs
```

The browser test starts its own loopback server and intercepts service requests
with synthetic replies. Screenshots/reports are written outside this repository.
No live-account or transaction flow runs.

Price captions stay on one line in modal totals and at Wallet widths of
360px and above; 320px Wallet rows may wrap rather than overlap asset labels
or overflow. Browser coverage includes 320, 360, 420, and 1100px widths.

These tests require the updated client fix for Liberdus/web-client-v2#1732 in
PR #1864. Keep this topic branch unmerged until the behavior is on client main,
then rerun focused tests against that exact main revision and record its SHA
before merging. Published main at `a7df4e9` has neither the broader offline runner
nor its instructions, so these files run directly and do not claim full-suite
validation by that unavailable runner.
