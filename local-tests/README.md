# Local client regression tests

This directory brings reusable tests and fixtures formerly stored in ignored client `tests/` directories or local branch history into version control on `codex/local-client-tests`. Original local copies remain available to existing commands. Add future tests on dedicated topic branches and submit PRs to that shared branch. Use the runner to select the client checkout explicitly. See [MIGRATION.md](MIGRATION.md) for provenance and baseline results.

The 2026-10-15 [repair baseline](REPAIRS.md) recorded **54/62 files passing**, including all **100 cases in 13 individually committed repaired files**. It lists the repair commits and client requirements at that time. [FAILURES.md](FAILURES.md) preserves the historical diagnosis of the original 21 failing files. These are historical results; rerun against the selected client and test revisions before using them to explain a failure.

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
2. For every change, create a dedicated topic branch in an isolated worktree based on the latest published `codex/local-client-tests`. Give concurrent agents separate branches and worktrees; preserve existing checkouts and local work.
3. Add a focused test here using synthetic fixtures. Prefer observable behavior over assertions that duplicate source text, and keep any necessary source-extraction tests narrowly scoped.
4. Run the focused test and relevant existing tests against the implementation checkout. Record the exact client and test commits, commands, results, and any required client features.
5. Commit implementation and companion tests separately. Publish the topic branches and open a test PR targeting `codex/local-client-tests`, following the user's authorization. Link the test PR in the client PR and the client PR in the test PR. For standalone test maintenance, identify the client revision the test PR supports.
6. Leave a feature-dependent test PR unmerged until all required client features have merged into `web-client-v2/main`. Before merging a PR that changes tests, set `WEB_CLIENT_ROOT` to a checkout of the merged `main` revision, rerun the focused tests, and record the exact client SHA, test commit, commands, and results in the test PR. Merge through the PR only after those tests pass. Report broader legacy failures separately. Documentation-only PRs can use documentation checks and explain why runtime coverage is N/A.
7. Include both PR links, commit IDs, validation results, and remaining publication or merge steps in the handoff. Keep reports, profiles, real account data, and generated downloads ignored.

The shared branch changes through reviewed test PRs. Do not commit, run `git merge` or `git cherry-pick`, or push directly to `codex/local-client-tests`. A local commit alone does not publish a test; verify the topic branch and PR are available remotely before reporting them as available for review. After PR merge, verify the remote shared branch contains the resulting merge or squash commit before reporting integration as complete.

## Point client agents here

Add a short instruction to the client repository's root `AGENTS.md`, for example:

```markdown
Reusable regression tests live in `Liberdus/client-testing`; its shared PR target
is `codex/local-client-tests`. Use `CLIENT_TESTING_ROOT` when set and report an
invalid override. Otherwise inspect nearby checkouts and the primary client's
sibling directory using `git worktree list`; clone the testing repository if
needed and report access failures or a missing shared branch.
Read its `AGENTS.md` and `local-tests/README.md`. Set `WEB_CLIENT_ROOT` to this
implementation checkout's absolute path, then add/run relevant regression tests
on a dedicated topic branch and isolated worktree based on the latest shared target.
Open a companion test PR to `codex/local-client-tests`; link it in the client PR
and link the client PR in the test PR. Commit implementation and tests separately
and include both commit IDs, commands, and results in the handoff.
Keep feature-dependent test PRs unmerged until their required client features are
on main. Before merging changed tests, rerun focused tests against the merged main
SHA. For documentation-only PRs, report documentation checks and runtime N/A.
Do not commit, git merge, cherry-pick, or push directly to the shared branch.
Preserve other agents' branches and uncommitted work, and report remaining PR,
publication, or validation steps accurately.
```

Set `CLIENT_TESTING_ROOT` locally when repositories are not siblings; avoid committing a machine-specific absolute path. A client worktree may live away from the main checkout, so its sibling discovery can require this override. Codex reads applicable `AGENTS.md` files from the working repository's ancestor directories, so an explicit reference is needed to use instructions in a companion repository. See [Codex agent configuration](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
