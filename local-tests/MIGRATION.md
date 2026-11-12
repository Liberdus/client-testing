# Regression test provenance

The current consolidation is described in [CONSOLIDATION.md](CONSOLIDATION.md).
It builds a new topic directly on companion main, collects coverage only for
merged client work, and leaves open-feature tests stacked above that topic.
The source PR and commit map is preserved there and in cherry-pick trailers.

## Historical foundation import

The original foundation started from companion main
`2fc3036c11900073e0616cf9ddcdf3cf233904e3`. It imported tests and synthetic fixtures
from repaired snapshot `f0f2c07d6df5b08f8f5c96850391bb16fe317262` and passed
54/54 files against client `cc0cc31e0063751bfe68875ab9a07ae6cfda18da`.
Those counts and that client SHA are historical, not current validation.
Later feature commits, current-main fixture repairs and the consolidated
validation are recorded separately. The legacy branch and original feature
topics remain preserved; old mixed-revision results are not a current baseline.

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

## Consolidated and preserved suites

Merged client features formerly split across source test PRs are now collected
in the consolidated review topic: native LIB Send/Receive and USD conversion,
attachment-ID caches/migrations, message confirmation and its browser demo,
EVM/Intents receipts, thumbnails, receive copy controls, faucet configuration,
committee/economic parameters and metadata, composer size and restored drafts,
and salted account locks. See CONSOLIDATION.md for the exact client/source PRs.

| Files or group | Disposition |
| --- | --- |
| Signed-in vote summary, media ownership/removal, Delete for all feedback, video preview and immersive controls | Open-feature topics #120 → #121 → #122 → #123 → #124 above the consolidated branch; validate against their matching client heads. |
| `reply-quotes.*` | Closed test #97 stays excluded; no reply-quote commits or fixtures are imported. |
| `issue-1553-call-links.test.mjs` | Closed test #99 stays preserved and excluded. |
| MLS `test/*.mjs` | Retain the implementation-dependent suites in client #1655; do not duplicate them here. |
| `mock-catalog.test.mjs`, `mock-board.browser.test.mjs` | Preserved in legacy history; no selected current client PR. |
| `evm-note-editing*`, `registration-confirmation.test.cjs` | Preserve historical closed/unmerged feature coverage until its client work resumes. |
| `dao-backend-fetcher.test.mjs`, `dao-user-vote-summary.test.mjs` | Preserve prototype contracts; the open vote-summary PR has its own focused current tests. |
| `evm-send-fee-usd.browser.test.mjs` | Historical harness remains preserved; numerical/lifecycle Node coverage is included. |

The MLS audit at client `8e1c86a13af1f82a7df3d31d06cd7a8f9e191559`
ran all 11 unchanged suites individually under Node 20.19.6. Ten completed;
`test/leave-effective.mjs` repeatedly aborted after seven checks with a V8
invalid-size fatal error (SIGTRAP). The cause was an unbounded path traversal
from the removed member's retained leaf after the tree contracted. Client fix
[`90398a3d`](https://github.com/Liberdus/web-client-v2/commit/90398a3d4b5505cec22b2518695382e3f85ab05e)
adds a reproducible tree-path bounds guard. The unchanged leave test and all
11 suites in `npm run test:mls` pass with that fix. This was existing client
coverage, not a test imported by this foundation.

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
