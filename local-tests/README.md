# Local client regression tests

This directory brings reusable tests and fixtures formerly stored in ignored client `tests/` directories or local branch history into version control on `codex/local-client-tests`. Original local copies remain available to existing commands. Add future tests here, and use the runner to select the client checkout explicitly. See [MIGRATION.md](MIGRATION.md) for provenance and baseline results.

See [REPAIRS.md](REPAIRS.md) for the current result: **54/62 files pass**, including all **100 cases in 13 individually committed repaired files**. It lists each repair commit and the client requirements for the eight remaining failures. [FAILURES.md](FAILURES.md) preserves the historical diagnosis of the original 21 failing files. Recheck these results against the selected client revision before using them to explain a failure.

## Run against an implementation checkout

From the `client-testing` repository root:

Use Node.js 20.19 or newer; the client source uses ES modules without a package-level `type` declaration.

```bash
export WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2
node local-tests/run.mjs --list
node local-tests/run.mjs
node local-tests/run.mjs dao-timeline.test.mjs
```

Pass filenames from `local-tests/tests/`. The default run selects Node tests that do not launch a browser. `--list` shows all filenames, including the `.browser.test.mjs` scripts and manual `.html` fixtures. The runner copies tests into a temporary directory, links the selected client's source and assets, and removes the temporary directory on normal completion. It leaves both repository checkouts unchanged. Some migrated tests describe behavior from a particular feature branch and can fail on a different client revision. Check the test's assumptions before changing an assertion or the implementation; record incompatible tests in the result instead of treating the entire migration as a passing baseline.

The recovered multichain suites import `fixtures/near-rpc.mjs`, which supplies a fixed contract-vector salt for `current_salt` queries to `intents.near` and rejects every other fetch. Their service mocks cover all other operations. The fixture applies only to those suites, and the runner copies it alongside the tests.

Run the 12 tests recovered from merged PR history with:

```bash
WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2 node local-tests/run.mjs \
  asset-icons.test.mjs intents.test.mjs \
  intents-activity.test.mjs intents-addresses.test.mjs intents-assets.test.mjs \
  intents-chat.test.mjs intents-deposits.test.mjs intents-swap.test.mjs \
  intents-transfer.test.mjs intents-withdraw.test.mjs \
  f01-security.test.mjs f02-attachment-security.test.mjs
```

For manual HTML fixtures, start the local overlay server:

```bash
WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2 node local-tests/run.mjs --serve
```

The server binds to loopback on port `8765` and serves the selected client together with the migrated test fixtures, for example `http://127.0.0.1:8765/tests/popup-select.browser.test.html`. Stop it with Ctrl-C. Manual HTML fixtures require a browser and user inspection; their presence does not mean they have passed an automated check. Browser-driving Node scripts are opt-in and are excluded from the default run. Run one by filename:

```bash
WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2 node local-tests/run.mjs evm-payment-explorer.browser.test.mjs
```

`evm-send-fee-usd.browser.test.mjs` also needs the `--serve` command running in another terminal against the same checkout. The other browser scripts start their own local servers. Browser scripts can write screenshots to `/tmp` as their original sources specify.

`lib-send-receive.browser.test.mjs` starts the actual client with synthetic wallet and recipient data, checks native Send/Receive and the separate EVM forms at desktop and mobile sizes, and measures visible USD estimates beneath native, EVM and multichain confirmation amounts. It saves screenshots and `confirmation-geometry.json` under `/tmp/lib-send-receive-browser`. It needs no live account: network responses are synthetic, external requests are blocked, and signing and broadcasts are forbidden. Run it with:

```bash
WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2 node local-tests/run.mjs lib-send-receive.browser.test.mjs
```

`issue-1755-attachment-cache-ids.browser.test.mjs` runs only the attachment cache classes in headless Chromium against real IndexedDB. It checks cache upgrades, storage-host changes, size eviction and thumbnail backup compatibility, and also runs the existing full-image HTML fixture. It starts its own loopback server and needs no account or external service. Run it alongside the focused Node tests with:

```bash
WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2 node local-tests/run.mjs \
  issue-1656-full-image-cache.test.mjs issue-1755-attachment-cache-ids.test.mjs \
  issue-1755-attachment-cache-ids.browser.test.mjs f02-attachment-security.test.mjs
```

`mock-catalog.test.mjs` verifies the generated mock catalog is current and covers every production modal. `mock-board.browser.test.mjs` serves the mock locally and checks rendered wallet fixtures, separate LIB/EVM transfer forms, contact and direct-address EVM transfers, DAO navigation states, EVM chat statuses and recovery menus, category filters, zoom controls, and canvas panning. It blocks external requests and the production `app.js`; no live account or wallet service runs. These tests require a client branch containing `mock/`. Run both with:

```bash
WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2 node local-tests/run.mjs mock-catalog.test.mjs mock-board.browser.test.mjs
```

When browser scripts need Playwright, install the repository's pinned dependencies:

```bash
npm ci --prefix playwright-tests
cd playwright-tests
npx playwright install chromium
```

The existing `playwright-tests/` suite targets live end-to-end flows. Its accounts, services, and transactions are separate from the default offline regression workflow; select and authorize that environment before running it.

## Add tests while implementing

1. Inspect the branch and dirty state of the client checkout and this repository. Set `WEB_CLIENT_ROOT` to the exact checkout receiving the implementation.
2. Start from `codex/local-client-tests`. For parallel work, give each agent a separate topic branch or worktree and integrate verified commits into the shared branch sequentially.
3. Add a focused test here using synthetic fixtures. Prefer observable behavior over assertions that duplicate source text, and keep any necessary source-extraction tests narrowly scoped.
4. Run the focused test and relevant existing tests against the implementation checkout. Include the client revision, commands, and results with the change.
5. Commit the test change in this repository and the implementation in the client repository. Reference the companion commit in each handoff or PR. Keep reports, profiles, real account data, and generated downloads ignored.

The branch is a shared history of reusable tests. Push it to the repository remote when publishing the tests for other machines or agents; a local commit alone does not make it available elsewhere.

## Point client agents here

Add a short instruction to the client repository's root `AGENTS.md`, for example:

```markdown
Reusable client regression tests live in the companion `client-testing` repository
on branch `codex/local-client-tests`. Locate it using `CLIENT_TESTING_ROOT` when
set; otherwise check for a sibling `../client-testing` checkout. If neither is
available, report the missing checkout instead of silently skipping validation.
Read its `AGENTS.md` and `local-tests/README.md`, set `WEB_CLIENT_ROOT` to this
implementation checkout's absolute path, and add/run relevant regression tests
there. Commit companion tests and include their commit in the implementation
handoff. Preserve other agents' branches and uncommitted work.
```

Set `CLIENT_TESTING_ROOT` locally when repositories are not siblings; avoid committing a machine-specific absolute path. A client worktree may live away from the main checkout, so its sibling discovery can require this override. Codex reads applicable `AGENTS.md` files from the working repository's ancestor directories, so an explicit reference is needed to use instructions in a companion repository. See [Codex agent configuration](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
