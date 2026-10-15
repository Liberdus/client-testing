# Migration record

Imported on 2026-10-15:

- 60 unique files from the primary `web-client-v2/tests/` directory at client commit `bc439f28ada1119a55397fd06d780641db1fefc5`.
- `message-confirmation.test.cjs` from the `codex/1797-message-confirmation-timeout` worktree at `861dd8e5260290e1bb6870cf2994d3d58c56a161`.
- Total: 50 Node test files, 3 opt-in browser scripts, and 8 manual HTML fixtures.
- The 60 primary files are byte-for-byte copies verified with SHA-256. The message-confirmation test keeps every assertion but replaces its custom async test loop with `node:test` (see below).
- Original copies remain available to existing local commands; future additions belong here.
- Excluded 251 generated screenshots, recordings, and result files (about 191 MB), plus `tests/browser/dao/config.local.json` containing local environment/account settings. The MLS tests and `dao-user-vote.test.mjs` in other worktrees already have Git history and were left in their existing branches.

## Baseline

With Node v20.19.6 against client `bc439f28ada1119a55397fd06d780641db1fefc5`, the 49 unchanged Node files produced identical exit statuses before and after migration: **29 passed and 20 failed**. The corrected message-confirmation harness also fails against this client, so the complete default run reports **29 of 50 files passed, 21 failed**.

The original message-confirmation harness logged assertion failures but could exit successfully when an awaited promise never settled and the event loop became empty. Using `node:test` reports both failures and cancelled tests with a nonzero exit status. On its feature checkout (`861dd8e5260290e1bb6870cf2994d3d58c56a161`), all **23 tests pass** with the corrected harness.

The migration does not claim that the historical suite is green. Default execution includes every Node test and exits nonzero on failure; no failures are silently skipped. Select tests relevant to the implementation and compare failures with this baseline. Repair stale tests in follow-up changes once the intended current behavior is established. Browser scripts and manual HTML fixtures were preserved and not counted as passing automated checks. The fixture server was checked for matching HTML, JavaScript, CSS, and font responses.

`dao-project-filters.test.mjs` and `dao-project-proposal-info.test.mjs` import the missing `dev-fixtures/dao-project-proposal-info-fixtures.js`. The latter also reads `dev-patches/dao-project-proposal-info-fixtures.patch`. Neither dependency exists in the available client worktrees; they were not fabricated. Several other failures concern changed DAO interfaces or exact application source strings.

Failing file baseline:

- `contextual-evm-modal.test.mjs`
- `dao-authoritative-claim-window.test.mjs`
- `dao-backend-fetcher.test.mjs`
- `dao-filter-layout.test.mjs`
- `dao-loading-toast.test.mjs`
- `dao-navigation.test.mjs`
- `dao-project-filters.test.mjs`
- `dao-project-proposal-info-state.test.mjs`
- `dao-project-proposal-info.test.mjs`
- `dao-project-proposal-ui.test.mjs`
- `dao-proposal-vote-tracker.test.mjs`
- `dao-summary-fetcher.test.mjs`
- `dao-user-vote-summary.test.mjs`
- `evm-note-editing-sync.test.mjs`
- `evm-note-editing.test.mjs`
- `evm-payment-explorer.test.mjs`
- `evm-send-fee-usd.test.mjs`
- `issue-1680-chat-attachment-thumbnails.test.mjs`
- `message-confirmation.test.cjs`
- `popup-select-container.test.mjs`
- `registration-confirmation.test.cjs`

## Recovered from merged PR history

Added 12 more offline test files on 2026-10-15. All original assertions are preserved. Changes are limited to module paths, filenames, run instructions, the NEAR fixture import, and awaiting the protocol suite's async entry point so an unsettled promise cannot produce a false success.

- The ten multichain suites come from `test/` on `backup-near-intents-before-consolidation-20260928`, commit `c99e209411ab60d3a3e5b2b1a414e68d3b7314b7`. They were excluded during the consolidation merged in [PR #1715](https://github.com/Liberdus/web-client-v2/pull/1715). Imports now target the consolidated `near-assets.js`, and filenames end in `.test.mjs` for runner discovery.
- `f01-security.test.mjs` comes from `c54312bae^:tests/f01-security.test.mjs`, before its removal during [PR #1700](https://github.com/Liberdus/web-client-v2/pull/1700). Its helper source path now points to `lib.js`.
- `f02-attachment-security.test.mjs` comes from `37c812f^:tests/f02-attachment-security.test.mjs`, before its removal during [PR #1702](https://github.com/Liberdus/web-client-v2/pull/1702). Its helper source path now points to `lib.js`.

The multichain suites import `fixtures/near-rpc.mjs`. It returns the deterministic `252812b3` contract-vector salt only for `current_salt` queries to `intents.near`; all other fetch calls reject without network access. Existing service mocks handle deposits, transfer preparation, quotes, withdrawals, and receipt checks. Live-account scripts and interactive development demos were excluded.

Verified against client checkout `92921ba4b51b3792295f5fbb4ea689fc5655de74` (application source identical to `bc439f28`), using Node v20.19.6 and the repository's `local-tests/run.mjs`:

| Added suite | Passing checks |
| --- | ---: |
| `asset-icons.test.mjs` | 36 |
| `intents.test.mjs` | 31 |
| `intents-activity.test.mjs` | 48 |
| `intents-addresses.test.mjs` | 65 |
| `intents-assets.test.mjs` | 57 |
| `intents-chat.test.mjs` | 60 |
| `intents-deposits.test.mjs` | 37 |
| `intents-swap.test.mjs` | 27 |
| `intents-transfer.test.mjs` | 33 |
| `intents-withdraw.test.mjs` | 44 |
| `f01-security.test.mjs` | 6 |
| `f02-attachment-security.test.mjs` | 7 |

All 12 added files passed: 438 multichain assertions and 13 security tests. The complete default offline run now contains **62 files: 41 passed, 21 failed**. Every previous file's result matches the initial baseline above; none of the new files fails. The 3 opt-in browser scripts and 8 manual HTML fixtures remain outside that default run.

The runner's fixture copy, deterministic salt response, and rejection of unsupported RPC methods and contract IDs were also checked. The focused command is documented in [README.md](README.md).
