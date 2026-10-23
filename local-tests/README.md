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

The existing `playwright-tests/` E2E flows have separate live-account and service
requirements. Select and authorize an appropriate environment before running
those flows.

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

## Committee address proposals (#1652)

Run the focused domain and actual-modal browser coverage with the implementation
checkout selected (Playwright/Chromium setup is described above):

```bash
WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2 node local-tests/run.mjs \
  dao-committee-addresses.test.mjs dao-parameter-descriptions.test.mjs \
  dao-proposal-create.test.mjs dao-proposal-option-layout.test.mjs
WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2 node local-tests/run.mjs \
  dao-committee-addresses.browser.test.mjs
```

The browser fixture renders the client's actual proposal editor, PopupSelect,
confirmation classes, modal markup and CSS at 1100, 390 and 320 pixels. It checks
prefill and independent option copies; add/remove with 0/3/4/10 rows; validation;
optional prefixes; canonical confirmation and captured transaction values;
Review → Back; mixed numeric changes; failed submission/retry; unavailable config;
and a scalar-only regression. Screenshots go to `/tmp/committee-addresses-*.png`.
Network/account/submission services are synthetic, and external requests are
blocked. This does not test full application startup, Menu/DAO navigation, real
signing, broadcasts or Proposal Info navigation.

Validated client: `d89a4e8c572b800a34d907c4ed645f11af5fc412`. The four focused Node
files pass 18 cases, and Chromium passes all three viewport sizes with no page
errors or external requests. The three existing suites also passed all 10 cases against
original client `01a232471ca26ddc280064721ca1cec121d719c1`. The new domain file fails
against that revision because the committee-address export does not exist yet.
The full inherited suite and live E2E were not run.

This topic uses the published offline-runner dependency
[client-testing #90](https://github.com/Liberdus/client-testing/pull/90), branch
`codex/offline-test-foundation`, recorded parent tip
`d04fcc1f9dfd6cc47d220002bac0a822cc3ced4d`. Shared main
`2fc3036c11900073e0616cf9ddcdf3cf233904e3` lacks the runner and instructions.
The test PR temporarily targets that parent branch; rebase only
this topic's changes and retarget to main after its integration (use the recorded
parent tip as the replay boundary for a squash merge). Keep these tests unmerged
until the committee client implementation reaches main, then rerun against that
exact client main revision. Publication, linked PRs, review and integration are
separate steps; publishing this topic does not integrate it into main.

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
