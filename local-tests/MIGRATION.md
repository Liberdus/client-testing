# Foundation provenance and feature split

This main-compatible foundation is based on `client-testing/main` at
`2fc3036c11900073e0616cf9ddcdf3cf233904e3`. It imports tests, fixtures and the
runner from repaired snapshot `f0f2c07d6df5b08f8f5c96850391bb16fe317262`, with
test source unchanged. The default run passes **54/54 files** against web-client
main `cc0cc31e0063751bfe68875ab9a07ae6cfda18da`.

The legacy branch remains preserved at
[`d1ac844`](https://github.com/Liberdus/client-testing/tree/d1ac844db0523e2c68ecbaccf60e8e1ab402de5c).
Its full historical audits and all omitted test versions remain recoverable
there. The old 54/62 and newer 53/66 results describe different mixed revisions,
not this foundation. No test assertions were weakened or skipped to obtain this
foundation's passing baseline: feature files are assigned to separate branches.

## Related client work already on main

These links identify the client work covered by the imported tests; they do not
request new client PRs for already-merged behavior.

| Coverage | Relevant merged web-client PRs |
| --- | --- |
| DAO read model, project creation/activation/milestones/claims/closeout | [#1687](https://github.com/Liberdus/web-client-v2/pull/1687), [#1688](https://github.com/Liberdus/web-client-v2/pull/1688), [#1689](https://github.com/Liberdus/web-client-v2/pull/1689), [#1690](https://github.com/Liberdus/web-client-v2/pull/1690), [#1691](https://github.com/Liberdus/web-client-v2/pull/1691), [#1692](https://github.com/Liberdus/web-client-v2/pull/1692), [#1693](https://github.com/Liberdus/web-client-v2/pull/1693) |
| DAO navigation, filters and session loading | [#1750](https://github.com/Liberdus/web-client-v2/pull/1750), [#1767](https://github.com/Liberdus/web-client-v2/pull/1767) |
| EVM assets, dedicated modals, prices and payment queue/chat sync | [#1696](https://github.com/Liberdus/web-client-v2/pull/1696), [#1733](https://github.com/Liberdus/web-client-v2/pull/1733), [#1738](https://github.com/Liberdus/web-client-v2/pull/1738), [#1747](https://github.com/Liberdus/web-client-v2/pull/1747), [#1756](https://github.com/Liberdus/web-client-v2/pull/1756), [#1757](https://github.com/Liberdus/web-client-v2/pull/1757), [#1758](https://github.com/Liberdus/web-client-v2/pull/1758), [#1764](https://github.com/Liberdus/web-client-v2/pull/1764) |
| NEAR Intents/multichain suites recovered from pre-consolidation history | [#1715](https://github.com/Liberdus/web-client-v2/pull/1715) |
| DOM/attachment security and chat authentication | [#1700](https://github.com/Liberdus/web-client-v2/pull/1700), [#1702](https://github.com/Liberdus/web-client-v2/pull/1702), [#1708](https://github.com/Liberdus/web-client-v2/pull/1708) |
| Full-image caching | [#1671](https://github.com/Liberdus/web-client-v2/pull/1671), [#1677](https://github.com/Liberdus/web-client-v2/pull/1677) |
| Popup selects, fonts, sign-in icons, welcome footer, Advanced options and launch icons | [#1631](https://github.com/Liberdus/web-client-v2/pull/1631), [#1663](https://github.com/Liberdus/web-client-v2/pull/1663), [#1664](https://github.com/Liberdus/web-client-v2/pull/1664), [#1665](https://github.com/Liberdus/web-client-v2/pull/1665), [#1667](https://github.com/Liberdus/web-client-v2/pull/1667), [#1669](https://github.com/Liberdus/web-client-v2/pull/1669) |

## Feature-specific and preserved suites

| Files or group | Disposition |
| --- | --- |
| `lib-send-receive.*`, `usd-lib-conversion.test.mjs` and related updates | Separate layers matching [#1806](https://github.com/Liberdus/web-client-v2/pull/1806) → [#1807](https://github.com/Liberdus/web-client-v2/pull/1807) → [#1810](https://github.com/Liberdus/web-client-v2/pull/1810), using each layer's compatible historical version. |
| `issue-1755-attachment-cache-ids.*` and ID-keyed full-image fixture changes | Separate tests for [#1811](https://github.com/Liberdus/web-client-v2/pull/1811); this foundation retains the pre-change URL-keyed full-image tests. |
| `message-confirmation.test.cjs` | Separate coverage for [#1802](https://github.com/Liberdus/web-client-v2/pull/1802). |
| `evm-payment-explorer.*` | Separate coverage for [#1793](https://github.com/Liberdus/web-client-v2/pull/1793). |
| `issue-1680-chat-attachment-thumbnails.*` | Dependent coverage for [#1684](https://github.com/Liberdus/web-client-v2/pull/1684) → [#1685](https://github.com/Liberdus/web-client-v2/pull/1685). |
| `issue-1553-call-links.test.mjs` | New focused companion coverage for [#1553](https://github.com/Liberdus/web-client-v2/pull/1553); 5/5 cases pass at its client head, while the eligible-link regression case fails on current client main. |
| MLS `test/*.mjs` | Already committed in client [#1655](https://github.com/Liberdus/web-client-v2/pull/1655), including its `npm run test:mls` entry point; retain the 11 suites there without duplicating their implementation dependencies in this repository. |
| `mock-catalog.test.mjs`, `mock-board.browser.test.mjs` | Preserved in the legacy branch; the mock implementation has no matching open client PR in this migration. |
| `evm-note-editing*`, `registration-confirmation.test.cjs` | Preserve until closed/unmerged client features resume: [#1800](https://github.com/Liberdus/web-client-v2/pull/1800), [#1744](https://github.com/Liberdus/web-client-v2/pull/1744). |
| `dao-backend-fetcher.test.mjs`, `dao-user-vote-summary.test.mjs` | Preserve historical/prototype contracts; no compatible current-main implementation is established. |
| `evm-send-fee-usd.browser.test.mjs` | Preserve the historical browser harness pending adaptation from shared-modal selectors; the repaired numerical/lifecycle Node suite is in this foundation. |

The MLS audit at client `8e1c86a13af1f82a7df3d31d06cd7a8f9e191559`
ran all 11 unchanged suites individually under Node 20.19.6. Ten completed;
`test/leave-effective.mjs` repeatedly aborted after seven checks with a V8
invalid-size fatal error (SIGTRAP). Full MLS validation remains incomplete;
the crash cause is unresolved. This failure belongs to existing client coverage,
not to a test imported by this foundation.

The original imports came from ignored client tests and commit
`861dd8e5260290e1bb6870cf2994d3d58c56a161` (message confirmation); recovered
multichain tests came from `c99e209411ab60d3a3e5b2b1a414e68d3b7314b7`, and the
security tests from parents of `c54312bae` and `37c812f`. See the legacy migration
record for detailed repair commit history.

This foundation excludes unrelated Playwright changes already belonging to the
existing PR stack [#81](https://github.com/Liberdus/client-testing/pull/81) →
[#82](https://github.com/Liberdus/client-testing/pull/82) →
[#83](https://github.com/Liberdus/client-testing/pull/83) →
[#87](https://github.com/Liberdus/client-testing/pull/87), and diagnostics commit
`3237bb3`. Their branches, commits and PR metadata are unchanged.
