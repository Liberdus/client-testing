# Local client regression tests

This directory brings 61 reusable test and fixture files formerly stored in ignored client `tests/` directories into version control on `codex/local-client-tests`. The original files are kept during the initial migration so existing local commands remain usable. Add future tests here, and use the runner to select the client checkout explicitly. See [MIGRATION.md](MIGRATION.md) for provenance and baseline results.

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

For manual HTML fixtures, start the local overlay server:

```bash
WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2 node local-tests/run.mjs --serve
```

The server binds to loopback on port `8765` and serves the selected client together with the migrated test fixtures, for example `http://127.0.0.1:8765/tests/popup-select.browser.test.html`. Stop it with Ctrl-C. Manual HTML fixtures require a browser and user inspection; their presence does not mean they have passed an automated check. Browser-driving Node scripts are opt-in and are excluded from the default run. Run one by filename:

```bash
WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2 node local-tests/run.mjs evm-payment-explorer.browser.test.mjs
```

`evm-send-fee-usd.browser.test.mjs` also needs the `--serve` command running in another terminal against the same checkout. The other two browser scripts start their own local servers. Browser scripts can write screenshots to `/tmp` as their original sources specify.

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
