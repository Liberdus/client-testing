# Offline client regression tests

`client-testing/main` is the permanent integration target. This foundation
contains **54 Node suites** verified against web-client main `cc0cc31e` and seven
manual HTML fixtures. Feature-specific tests live on separate draft PR branches.
See [MIGRATION.md](MIGRATION.md) for source revisions, related merged client PRs,
and preserved tests not included in this main-compatible set.

## Run against a selected client

Use Node.js 20.19 or newer. From the repository root:

```bash
export WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2
node local-tests/run.mjs --list
node local-tests/run.mjs
node local-tests/run.mjs dao-timeline.test.mjs
```

The default command runs every Node suite in this checkout and exits nonzero
when any file fails. There are no failure exclusions or blanket skips. The
runner copies the selected tests and fixtures into a temporary overlay and
links source/assets from `WEB_CLIENT_ROOT`, leaving both checkouts unchanged.

The ten NEAR suites use `fixtures/near-rpc.mjs` for a deterministic contract salt;
other network requests reject. DAO fixtures use synthetic current-schema data.
These offline suites require no live account or transaction broadcasts.

For the manual HTML fixtures, start the loopback overlay server:

```bash
WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2 node local-tests/run.mjs --serve
```

Open a fixture such as
`http://127.0.0.1:8765/tests/issue-1656-full-image-cache.browser.test.html`.
Stop with Ctrl-C. Manual fixtures are not counted as passing automated checks.
Feature branches may add opt-in `.browser.test.mjs` scripts; run them by filename
and follow that branch's setup instructions. When Playwright is needed:

```bash
npm ci --prefix playwright-tests
cd playwright-tests
npx playwright install chromium
```

`issue-1755-attachment-cache-ids.browser.test.mjs` runs the cache classes against
real IndexedDB in headless Chromium. It checks version-by-version ordering in one
upgrade transaction, asynchronous step completion, URL-to-ID migration, newest-record
deduplication, schema-based preservation, rollback across multiple version steps,
unregistered-version rejection, hostname changes, size eviction and old thumbnail
backup imports. A synthetic registered v4 step verifies future upgrades after v3.
It also runs the full-image HTML fixture automatically. Only a loopback server
and synthetic cache records are used; no account or external service is required.
Run it with:

```bash
WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2 node local-tests/run.mjs issue-1755-attachment-cache-ids.browser.test.mjs
```

`issue-1817-hide-send-crypto.browser.test.mjs` opens the actual chat + menu at
desktop and mobile sizes, checks the remaining attachment actions, and verifies
the retained payment handler and wallet Multichain Receive screens. It uses
synthetic account/deposit data, blocks external requests and transactions, and
saves menu screenshots under `/tmp/1817-hide-send-crypto`. Run it with:

```bash
WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2 node local-tests/run.mjs issue-1817-hide-send-crypto.browser.test.mjs
```

The existing `playwright-tests/` E2E flows have separate live-account and service
requirements. Select and authorize an appropriate environment before running
those flows.

### Watch message confirmation expire in the browser

With `WEB_CLIENT_ROOT` pointing to the client checkout to test, run:

```bash
WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2 \
node local-tests/tests/message-confirmation.browser-demo.mjs
```

Open `http://127.0.0.1:5502/`. Click **Prepare full null**, then the app's Send arrow. Keep the tab visible: the normal checker starts its 30-second window at the first eligible receipt lookup, usually about 10 seconds after Send. Watch the original bubble become failed, then repeat with **Prepare transaction null** for `{ transaction: null }`. The side panel reads the real pending timestamp and message status; it does not change either. Changing visibility resets the window as production does. `RECEIPT_DEMO_PORT` overrides the default port if needed; Ctrl+C stops the server.

This manual fixture serves the selected checkout's full app and appends a synthetic-account bootstrap to the served module in memory. It retains the actual encryption, signing, Send, injection, receipt lookup, checker, failure rendering, and Retry methods. Local HTTP endpoints simulate accepted submission and the selected receipt response; nothing is broadcast. Background network-parameter data is supplied by the fixture, all gateways point to the local server, and its content security policy blocks external requests. Production files are not edited, real accounts are not loaded, and timers are not accelerated. Results and receipt attempts are available at `/__demo/events` on that local server. This is browser coverage with synthetic network responses, not a live-network delivery test.

## Add or update relevant coverage

1. Inspect the client/test branches and existing work. Set `WEB_CLIENT_ROOT` to
   the exact implementation checkout, and record both repository SHAs.
2. Create a task-specific topic worktree from published `main`. For a genuine
   test dependency, use its parent test branch and state the intended stack.
3. Run relevant existing tests before implementation. Add focused coverage only
   where needed, using synthetic fixtures and observable behavior.
4. Validate against the matching client PR head and record exact commands,
   results and prerequisites. Keep test changes separate from client commits.
5. Publish the topic and open a draft PR targeting `main`, or its parent test
   branch while stacked. Do not commit, locally merge, cherry-pick or push task
   changes directly into main.
6. Link relevant client PRs from the test PR. Add reciprocal links to open client
   PRs. Coverage for already-merged client PRs only needs their existing links;
   do not create a new client PR for that historical work.
7. Wait for required client features to merge, rerun focused tests against the
   resulting client main SHA, then review/merge the test PR. After a parent test
   PR merges, retarget/rebase children onto main using its resulting merge or
   squash commit. Verify the published main contains the final test merge.

Preserve the existing E2E PR stacks and the legacy branch. A full run on a feature
branch can reveal unrelated client/test incompatibilities; report those with
the tested pair of SHAs instead of weakening assertions or hiding failures.

## Point implementation agents here

Client agents need a pointer in their own `AGENTS.md` to find this companion
repository. Prefer an explicit absolute `CLIENT_TESTING_ROOT`, then nearby
checkouts or the primary client checkout's sibling directory. Clone
`https://github.com/Liberdus/client-testing.git` when needed; local repositories
can live anywhere. Select `main`, read this repository's instructions, and use
a separate topic worktree for relevant test changes.

At client PR creation, create/link the relevant companion PR only if tests need
changes; otherwise report N/A and the validation performed. Include test/client
commits, commands/results and any remaining publication, review or dependency
steps in the handoff.
