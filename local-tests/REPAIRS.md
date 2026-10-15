# Test repairs and remaining client requirements

On 2026-10-15, repaired **13 test files in 13 separate commits** on `codex/local-client-tests`. Most repairs update stale harnesses, interfaces or UI contracts. The two missing-fixture suites needed a shared synthetic current-schema fixture; none of these repairs changes client application code.

Verified with Node v20.19.6 against client checkout `92921ba4b51b3792295f5fbb4ea689fc5655de74`, whose application source matches `bc439f28ada1119a55397fd06d780641db1fefc5`. The test branch through `da3064c` produces:

- **13/13 repaired files, 100/100 cases passing**, both individually and within the default suite. No repaired case is skipped, cancelled or marked todo.
- **54/62 files passing; 8 failing** in the full default offline suite, compared with the original 41 passing / 21 failing. The command exits nonzero and continues to expose every remaining failing file.
- The 3 opt-in browser scripts and 8 manual HTML fixtures are outside the default run and were not rerun as part of these repairs. CSS contract checks in the repaired layout test do not replace browser layout measurements.

The original 21 failures were in the migrated batch. The additional 12 suites recovered from merged PR history all passed before these repairs and still pass. See [FAILURES.md](FAILURES.md) for the historical diagnosis and [MIGRATION.md](MIGRATION.md) for provenance.

## Individually verified repair commits

Each commit contains one test file. The project-filter commit also introduces `fixtures/dao-projects.mjs`, which the following proposal-info commit reuses. New fixture data is synthetic and has coherent proposal/voting/project timestamps. It provides read-only DAO responses without an application patch or live network access.

| Test file | Repair | Passing cases | Commit |
| --- | --- | ---: | --- |
| [dao-authoritative-claim-window.test.mjs](tests/dao-authoritative-claim-window.test.mjs) | Account-owned vote callbacks and current tracker signatures; pending, authoritative, expiry and confirmed-claim coverage retained. | 6/6 | `727a5a8` |
| [dao-proposal-vote-tracker.test.mjs](tests/dao-proposal-vote-tracker.test.mjs) | Current account/network state callbacks, authoritative claim windows and callback-error behavior. | 8/8 | `d62d218` |
| [dao-summary-fetcher.test.mjs](tests/dao-summary-fetcher.test.mjs) | Call real `fetchMeta()` / `fetchProposals()` methods; retain indexed-only and metadata-only request checks. | 3/3 | `92a8cc4` |
| [dao-loading-toast.test.mjs](tests/dao-loading-toast.test.mjs) | Supply current loading-session globals and repository reset mocks. | 5/5 | `48079c1` |
| [dao-navigation.test.mjs](tests/dao-navigation.test.mjs) | Supply current session, reset and toast dependencies; retain transition/reopen behavior. | 3/3 | `1b3bd33` |
| [dao-filter-layout.test.mjs](tests/dao-filter-layout.test.mjs) | Current Proposals/Projects contexts, filter order, accessibility and responsive CSS contracts. | 2/2 | `953bf18` |
| [dao-project-proposal-info-state.test.mjs](tests/dao-project-proposal-info-state.test.mjs) | Authoritative top-level lifecycle states; retain options/results disclosure coverage. | 2/2 | `de0a605` |
| [dao-project-proposal-ui.test.mjs](tests/dao-project-proposal-ui.test.mjs) | Millisecond durations, current exported limits and production project-builder execution. | 11/11 | `6077ba4` |
| [contextual-evm-modal.test.mjs](tests/contextual-evm-modal.test.mjs) | Execute dedicated EVM modal loading, context selection, deferred refresh and stale-session behavior. | 6/6 | `02f031b` |
| [evm-send-fee-usd.test.mjs](tests/evm-send-fee-usd.test.mjs) | Load real confirmation controls; retain 31 numerical cases and replace four obsolete shared-modal cases with dedicated-modal lifecycle checks. | 35/35 | `ff54083` |
| [popup-select-container.test.mjs](tests/popup-select-container.test.mjs) | Enhance every select in current markup; execute idempotence, network sync and LIB/EVM selector behavior. | 5/5 | `218a42c` |
| [dao-project-filters.test.mjs](tests/dao-project-filters.test.mjs) | Add synthetic current-schema lifecycle fixtures, repository filter/count checks and production row previews. | 7/7 | `2da421a` |
| [dao-project-proposal-info.test.mjs](tests/dao-project-proposal-info.test.mjs) | Use shared synthetic fixtures with real read-model/rendering helpers; cover funding, milestones, malformed data, escaping and read-only routes. | 7/7 | `da3064c` |

## Eight failures preserved for their intended client implementation

These test files were not modified by the repair commits. A passing result on a surviving feature snapshot validates that snapshot, not the current client or a later remote PR revision. Branch and PR evidence below was checked on 2026-10-15.

| Test file | Result on current client | Verified client requirement and next action |
| --- | --- | --- |
| [dao-backend-fetcher.test.mjs](tests/dao-backend-fetcher.test.mjs) | 6 failures: historical callable fetcher and cache/invalidation API absent. | All 6 pass unchanged on historical client commit `d41942e0c8cea1be1fb306cafe4fe03d89b5ba9a`. The latest surviving `feat/dao-proposal-detail-cache` snapshot `5e77169e` also fails all 6, so selecting that branch by name is insufficient. Decide whether to retain/reimplement the historical cache contract or replace it with a separately scoped current contract. |
| [dao-user-vote-summary.test.mjs](tests/dao-user-vote-summary.test.mjs) | Import failure before its 6 declared cases run. | Required prototype exports are absent. No compatible implementation snapshot was found; the related net-vote snapshot `b1fecafd5` has a different interface. Resolve the intended feature API before repairing this suite. |
| [evm-note-editing-sync.test.mjs](tests/evm-note-editing-sync.test.mjs) | 2 failures: missing `ChatModal.getEditText`. | 2/2 pass unchanged on local `codex/1798-evm-note-editing` at `c321ad6b`. [PR #1800](https://github.com/Liberdus/web-client-v2/pull/1800) was closed and unmerged. Decide whether to resume that feature before expecting the current client to pass. |
| [evm-note-editing.test.mjs](tests/evm-note-editing.test.mjs) | Setup failure before its 19 declared cases run. | 19/19 pass unchanged on the same local note-editing snapshot `c321ad6b`; requires that feature's edit eligibility and helper implementation. |
| [evm-payment-explorer.test.mjs](tests/evm-payment-explorer.test.mjs) | 8 failures, then setup abort before another 8 cases register. | 16/16 pass unchanged on local `codex/1728-evm-explorer-links` at `6f0cd99c`. [PR #1793](https://github.com/Liberdus/web-client-v2/pull/1793) was open and unmerged; rerun after integration. |
| [issue-1680-chat-attachment-thumbnails.test.mjs](tests/issue-1680-chat-attachment-thumbnails.test.mjs) | 1 pass, 4 failures: missing attachment classes and descriptive alt text. | 5/5 pass unchanged on local `issue-1680-chat-attachment-thumbnails` at `9df4bbf2`. [PR #1685](https://github.com/Liberdus/web-client-v2/pull/1685) was open and unmerged; preserve its accessibility expectations. |
| [message-confirmation.test.cjs](tests/message-confirmation.test.cjs) | 2 pass, 14 fail, 7 cancelled; includes a real null/missing receipt bug. | 23/23 pass unchanged on local `codex/1797-message-confirmation-timeout` at `861dd8e5`. [PR #1802](https://github.com/Liberdus/web-client-v2/pull/1802) was open and unmerged. Prioritize its null-safe receipt handling and bounded observation/abort behavior. One unresolved request causes the 7 cancellations; they are not seven independently established bugs. |
| [registration-confirmation.test.cjs](tests/registration-confirmation.test.cjs) | 17 failures: missing registration recovery methods and pending-recovery behavior. | 17/17 pass unchanged on local `fix/registration-confirmation-recovery` at `e84cff62`. [PR #1744](https://github.com/Liberdus/web-client-v2/pull/1744) was closed and unmerged. Decide whether to resume recovery implementation. |

The current message-confirmation bug remains application work: `queryNetwork()` can return null, but the receipt checker dereferences `res.transaction` and can call `Object.keys()` on an undefined transaction. The source evidence and reproduction are recorded in [FAILURES.md](FAILURES.md#current-client-bug). Its assertions remain intact.

## Reproduce

From the `client-testing` repository root, select the implementation checkout explicitly:

```bash
WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2 node local-tests/run.mjs
WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2 node local-tests/run.mjs dao-project-filters.test.mjs
```

For a feature-specific suite, set `WEB_CLIENT_ROOT` to a separate checkout at the required verified client commit, then run that filename. The runner does not switch branches or select historical implementations automatically. Keep feature tests intact until their intended implementation is available; adding blanket skips would hide the remaining work.
