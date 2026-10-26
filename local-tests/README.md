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
  dao-proposal-create.test.mjs dao-proposal-option-layout.test.mjs \
  dao-project-proposal-ui.test.mjs
WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2 node local-tests/run.mjs \
  dao-committee-addresses.browser.test.mjs
```

The browser fixture renders the client's actual proposal editor, PopupSelect,
confirmation classes, modal markup and CSS at 1100×900, 390×900, 320×900 and
391×751 pixels. It checks prefill and independent option copies; add/remove with 0/3/4/10 rows; validation;
optional prefixes; wallet-length prefill/Current/confirmation display; canonical
64-character captured transaction values;
Review → Back; mixed numeric changes; failed submission/retry; unavailable config;
a scalar-only regression; measured full-wallet input fit; single-line Current
addresses; equal character widths in monospace inputs/Current/confirmation;
centered displayed addresses with mouse/keyboard copy and clipboard feedback; and
accessible trash icons with option/parameter/committee/milestone
removal and minimum-count disabled states. Screenshots go to
`/tmp/committee-addresses-*.png`.
Network/account/submission services and the clipboard API are synthetic, and
external requests are blocked. This does not test full application startup, Menu/DAO navigation, real
signing, broadcasts or Proposal Info navigation.

Before display shortening, client `d89a4e8c572b800a34d907c4ed645f11af5fc412` passed
18 focused Node cases and Chromium at all three viewport sizes with no page
errors or external requests. The three existing suites also passed all 10 cases against
original client `01a232471ca26ddc280064721ca1cec121d719c1`. The new domain file fails
against that revision because the committee-address export does not exist yet.
The full inherited suite and live E2E were not run.

Display-shortening follow-up: client
`38f039bb2bf13d454c99d9440c10d748d3e6a991` passes all 20 focused Node cases and
Chromium at 1100/390/320 pixels, with no page errors or external requests. Two
new display cases first failed on `d89a4e8c572b800a34d907c4ed645f11af5fc412`
(8 passed, 2 failed because `toDisplayAddress` was absent). They verify that
only the 24 network-padding zeros are removed, preserving meaningful trailing
wallet zeros and full network addresses without that padding. Browser checks
verify shortened Current/prefilled/review lists while both transaction JSON
strings remain canonical 64-character addresses, and Back retains raw edits.
Fresh complete initial-prefill modal captures are
`/tmp/committee-addresses-1100-prefilled-modal.png` and
`/tmp/committee-addresses-390-prefilled-modal.png`; generated images are not
committed. The same synthetic-service and navigation limitations above apply.

Compact-text and trash-icon follow-up: client
`ba2225acdbeabebb840005b00e4e6ada711543a0` passes all 31 focused Node cases
(the unchanged 20 committee/scalar cases plus 11 project UI cases) and Chromium
at all four viewport sizes above. The browser measures actual wallet text with
Canvas against each input's content width and counts Current text lines with
Range; it does not infer fit from an input's scroll width. Before this change,
the new check failed at 391×751 on client
`38f039bb2bf13d454c99d9440c10d748d3e6a991`: the varied 40-character wallet text
needed 337.0px while its input had 180.0px. All four viewports now fit those
addresses on one line with no form overflow, page errors or external requests.
The browser also checks icon-only removal controls and exercises accessible
option, parameter, committee-row and project-milestone removal, preserving
one-item disabled states. Project icon coverage now inspects rendered milestone
markup rather than counting inline SVG literals in source. Screenshot waits
check that no animations are running, so legitimate transition cancellation
does not reject a capture. Fresh 391×751 captures are
`/tmp/committee-addresses-391-prefilled-viewport.png` and the complete parameter
row `/tmp/committee-addresses-391-prefilled-row.png`.

Monospace follow-up: client `e5d332ce23af14dcd0a1ff422d9cc654152939ba`
passes the same 31 Node cases and Chromium at all four viewport sizes, including
the existing text-fit and overflow checks. The browser measures 40 `8` characters
and 40 `f` characters with each input or display element's actual computed font
style, weight, size and family; their advances must match within that element's
style. It checks inputs, Current lists and confirmation lists separately, so
their intentionally different font sizes need not produce the same physical
width across controls. Before this change, the new check failed at 391×751 on
client `ba2225acdbeabebb840005b00e4e6ada711543a0`: the input's Inter font stack
produced 280.0px for the `8` string and 160.0px for the `f` string. There were no
page errors or external requests in the final run. Fresh complete parameter-row
captures are `/tmp/committee-addresses-391-prefilled-row.png` and
`/tmp/committee-addresses-1100-prefilled-row.png`; the 391×751 viewport capture is
`/tmp/committee-addresses-391-prefilled-viewport.png`.

Center-and-copy follow-up: client `547d2c343f54e51f76f9fe2e84345d4332d1b7a5`
passes the same 31 Node cases and Chromium at all four viewport sizes. The new
browser check first failed on `e5d332ce23af14dcd0a1ff422d9cc654152939ba` because
Current had zero copy buttons instead of four. The final browser flow measures
each displayed text line's center against its list item, while inputs remain
left-aligned, editable and within the existing fit bounds. Mouse, Enter and
Space activation copy the visible 40-character wallet or unpadded 64-character
network address exactly through a stubbed `navigator.clipboard.writeText`.
Assertions check success/error toast text, duration and type; one write per
activation after repeated listener loading; copying after editor and review
rerenders; and no form submission, proposal mutation or clipboard calls from
input editing. There are no page errors or external requests. Fresh captures
include `/tmp/committee-addresses-391-prefilled-row.png`,
`/tmp/committee-addresses-391-prefilled-viewport.png` and
`/tmp/committee-addresses-391-review.png`. This tests the shared display through
the editor and confirmation; it does not exercise Proposal Info navigation or
the operating system clipboard.

Review-label alignment follow-up: CSS-only client
`a1f6227a4cf03a07732565ccd39d8f594206fa50` passes the existing browser suite at
all four viewport sizes. Fresh review screenshots show the parameter title and
address lists centered, with Current/New labels left-aligned; editable inputs
remain left-aligned. Copy controls, keyboard activation, text fit and overflow
checks continue to pass, with no page errors or external requests. Captures are
`/tmp/committee-addresses-391-review.png` and
`/tmp/committee-addresses-1100-review.png`. The selector also scopes Proposal
Info, but that modal's navigation was not exercised. No reusable tests changed.
The 31 Node cases were not rerun for this CSS-only adjustment; their previous
passing client revision remains `547d2c343f54e51f76f9fe2e84345d4332d1b7a5`.

DAO ownership follow-up: the committee domain tests now use the existing
`daoRepo` methods, and the browser fixture preserves those methods while
substituting synthetic proposal submission. Against client
`e685d1437d6f071345cf8e60abb5a4c55ce7d379`,
the focused commands above pass all 31 Node cases and Chromium at all four
viewport sizes. Existing validation, display and captured-transaction assertions
are unchanged; there are no page errors or external requests. Verification used
Node 20.19.6, the pinned Playwright 1.52.0 and cached Chromium, with loopback/browser
permissions enabled for the synthetic browser fixture.

UI ownership follow-up: client `8a0329fe324859fd28857a904553e445f28b5f37`
moves the committee display and copy helpers into the existing `AddProposalModal`
class. The browser fixture uses that class directly for repeated listener binding;
all behavior assertions are unchanged. The focused commands above pass all 31
Node cases and Chromium at all four viewport sizes, with no page errors or
external requests. The same pinned browser setup and synthetic-service limits
above apply.

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
