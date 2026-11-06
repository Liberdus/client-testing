# Focused offline client regression

`tests/issue-1880-near-receive.browser.test.mjs` serves the actual client with
synthetic account, contact, asset, and balance data. It checks the internal NEAR
Intents receive screen, copy controls, rendered QR round trips, optional fields,
navigation and account reset, and scanned payment requests. It blocks external
services and signing/broadcast operations; it creates no live account or payment.

Use Node.js 20.19 or newer and install the repository's pinned browser dependencies:

```bash
npm ci --prefix playwright-tests
cd playwright-tests
npx playwright install chromium
cd ..
WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2 \
  node local-tests/tests/issue-1880-near-receive.browser.test.mjs
```

The script starts its own loopback server. Screenshots are written under
`/tmp/issue-1880-near-receive`, outside the repository. The mobile case uses a
dark media preference; it does not assert a separate application theme.

This is a standalone focused test. At its base revision, companion `main` did not
contain the reusable `local-tests/run.mjs` runner or legacy local-test suites.
This change does not integrate those suites or imply they have passed. The new
test requires the client implementation for
[web-client-v2#1880](https://github.com/Liberdus/web-client-v2/issues/1880).
Keep it on its topic branch until that implementation reaches client `main` and
the test has been rerun against that revision.
