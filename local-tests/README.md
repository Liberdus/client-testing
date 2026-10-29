# Offline client regression tests

`client-testing/main` is the permanent integration target. The consolidated topic
`codex/tests-for-merged-client-prs` collects infrastructure and tests for client
changes already merged into web-client main. Its baseline contains 68 Node files,
nine opt-in browser suites, eight HTML fixtures and the message-confirmation demo.
[CONSOLIDATION.md](CONSOLIDATION.md) maps source PRs to client features and records
the pending test stack. [MIGRATION.md](MIGRATION.md) preserves historical provenance.
Publishing a topic is separate from integrating it into main.

## Run against a selected client

Use Node.js 20.19 or newer. From the companion repository root:

```bash
export WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2
node local-tests/run.mjs --list
node local-tests/run.mjs
node local-tests/run.mjs dao-timeline.test.mjs
```

Set the absolute path of the exact client checkout, including a worktree. The
default command selects Node suites, reports every file and exits nonzero on
failure. It copies tests and synthetic fixtures into a temporary overlay and
links the selected client's sources/assets. It does not change either checkout.
The NEAR suites use a deterministic RPC fixture; DAO and wallet suites use
synthetic state. No live accounts or transaction broadcasts are required.

Feature-topic branches add tests for unmerged client changes. Run those focused
tests against their matching client PR head; they may fail against client main
until the feature merges. Do not weaken or exclude their assertions to make a
mixed feature stack pass against an unrelated client revision.

## Opt-in browser checks

Install the repository's pinned dependencies and browser once:

```bash
npm ci --prefix playwright-tests
(cd playwright-tests && npx playwright install chromium)
```

With `WEB_CLIENT_ROOT` exported, these suites use the overlay runner:

```bash
node local-tests/run.mjs \
  evm-payment-explorer.browser.test.mjs \
  lib-send-receive.browser.test.mjs \
  issue-1755-attachment-cache-ids.browser.test.mjs \
  issue-1816-receive-copy-icon.browser.test.mjs \
  issue-1817-hide-send-crypto.browser.test.mjs \
  issue-1819-lib-payment-bubbles.browser.test.mjs \
  dao-committee-addresses.browser.test.mjs
```

These standalone suites resolve Playwright relative to the companion checkout:

```bash
node local-tests/tests/issue-1836-economic-parameters.browser.test.mjs
node local-tests/tests/issue-1848-intents-receipts.browser.test.mjs
```

Browser suites use loopback servers, synthetic accounts or cache records, and
blocked/intercepted external requests. They cover real IndexedDB migrations,
wallet/payment layout, copy actions, committee/economic proposal editing and
Intents receipts. Screenshots and generated reports belong outside commits.
These checks do not establish live-network, native WebView or screen-reader behavior.

## HTML fixtures

Start the loopback overlay server:

```bash
node local-tests/run.mjs --serve
```

Open `http://127.0.0.1:8765/tests/<fixture>.html`. The fixtures cover full-image
cache behavior, fonts, sign-in icons, welcome footer, Advanced controls, popup
selection and thumbnail presentation. Stop the server with Ctrl+C. The thumbnail
HTML fixture supplies static attachment markup and the current client's CSS;
it does not execute ChatModal rendering. Manual fixtures are not part of the
default Node result; record browser/visual checks separately.

## Message confirmation demo

```bash
node local-tests/tests/message-confirmation.browser-demo.mjs
```

Open `http://127.0.0.1:5502/`. Click **Prepare full null**, then the app's Send
arrow. Keep the tab visible: the normal checker starts its 30-second window at
the first eligible receipt lookup, usually about ten seconds after Send. Watch
the original bubble become failed, then repeat with **Prepare transaction null**
for `{ transaction: null }`. Changing visibility resets the production window.
`RECEIPT_DEMO_PORT` overrides the port; Ctrl+C stops the server.

The fixture serves the selected client's full app and appends a synthetic-account
bootstrap in memory. It retains actual encryption, signing, Send, injection,
receipt lookup, checking, failure rendering and Retry methods. Local HTTP
endpoints simulate submission and receipt responses; nothing is broadcast.
All gateways point to the local server, external requests are blocked and timers
are not accelerated. Events are available at `/__demo/events` on that server.
Production files and real account data are untouched.

## Add and integrate coverage

1. Inspect both checkouts and preserve other agents' work. Create a topic branch
   or isolated worktree from published companion main.
2. Run relevant existing tests against the exact implementation checkout. Add
   focused synthetic coverage under `local-tests/` only when needed.
3. Commit client and companion changes separately. Link open client and test PRs
   in both directions; reference already-merged client PRs from the test PR only.
4. Record client/test SHAs, commands, results and prerequisites. Keep generated
   reports, profiles, credentials and account data out of commits.
5. Keep tests for unmerged features on topic PRs. Once their client changes reach
   main, rerun focused tests against that exact main SHA before test integration.
6. A test stack may target its parent topic temporarily. After a parent merges,
   replay only the child's changes and retarget to main, accounting for a squash.

The current consolidation has one review target for already-merged client work.
The remaining open-feature test topics form a separate stack above it. Closed
reply-quote and call-link test PRs stay preserved and excluded. The #81–#87 E2E
stack is separate and unchanged. `playwright-tests/` live flows require an
explicitly selected environment and authorization for accounts/transactions;
they are not part of this offline audit.

## Account media ownership and removal

These focused tests exercise the production cache classes in headless Chromium with real IndexedDB. No application startup, live account, signing, broadcast, or external service is used.

Install the repository's locked Playwright dependencies and Chromium:

```bash
npm ci --prefix playwright-tests
cd playwright-tests
npx playwright install chromium
```

Run from the repository root with Node.js 20.19 or newer:

```bash
WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2 \
  node --test local-tests/tests/issue-1853-media-ownership.browser.test.mjs
```

Set `WEB_CLIENT_ROOT` to the exact implementation checkout, including when it is a worktree. Each test uses temporary database names and closes and removes them afterward. Tests load the client's actual cache classes without running the full app; they read persisted records and indexes to check observable IndexedDB behavior.

The 24 issue #1853 cases cover indexed media ownership, cache-hit registration, concurrent readers, preservation of legacy records (including full images missing an indexed timestamp), shared and selected-account removal, transaction aborts and action failures, delayed writes and eviction after removal and recreation, account switches, backup imports and exports, attachment identity and eviction, download fallbacks, and validation before storage access. Capture-failure cases distinguish unavailable caching from explicit untracked access and verify that avatar editing retains one operation context across awaited helpers. They require the unmerged issue #1853 client implementation and must remain on their companion topic branch until that implementation is on client `main` and the cases have passed against it.
