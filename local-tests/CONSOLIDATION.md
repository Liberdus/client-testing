# Consolidated coverage and pending features

The `codex/tests-for-merged-client-prs` topic starts directly from published
`client-testing/main` at `2fc3036c11900073e0616cf9ddcdf3cf233904e3`. It collects only
the own commits of the source test PRs below. Inherited changes from the
#81–#87 E2E stack are not imported. Existing source commits are recorded in
`cherry picked from commit` trailers; source branches remain recoverable.

Every required merged client PR was verified on client main `e33e6808e42551d4310d9753de752343bc8a87c3`.
Validation results and commands are recorded in the consolidation PR. These
tests remain on a review branch until that PR is merged; no direct main push is used.

## Source test PRs incorporated

| Source test PR | Related merged client PRs | Preserved source tip |
| --- | --- | --- |
| [#90](https://github.com/Liberdus/client-testing/pull/90) | Shared offline runner and historical coverage; see MIGRATION.md | `d04fcc1f` |
| [#91](https://github.com/Liberdus/client-testing/pull/91) | [#1806](https://github.com/Liberdus/web-client-v2/pull/1806) | `edf9a3d2` |
| [#92](https://github.com/Liberdus/client-testing/pull/92) | [#1807](https://github.com/Liberdus/web-client-v2/pull/1807) | `360ac3c2` |
| [#93](https://github.com/Liberdus/client-testing/pull/93) | [#1810](https://github.com/Liberdus/web-client-v2/pull/1810) | `a17c1e89` |
| [#94](https://github.com/Liberdus/client-testing/pull/94) | [#1811](https://github.com/Liberdus/web-client-v2/pull/1811) | `29a9ed39` |
| [#95](https://github.com/Liberdus/client-testing/pull/95) | [#1802](https://github.com/Liberdus/web-client-v2/pull/1802) | `bd609c01` |
| [#96](https://github.com/Liberdus/client-testing/pull/96) | [#1793](https://github.com/Liberdus/web-client-v2/pull/1793) | `6bf02090` |
| [#98](https://github.com/Liberdus/client-testing/pull/98) | [#1685](https://github.com/Liberdus/web-client-v2/pull/1685) | `1feaa00b` |
| [#106](https://github.com/Liberdus/client-testing/pull/106) | [#1825](https://github.com/Liberdus/web-client-v2/pull/1825) | `d394b08c` |
| [#107](https://github.com/Liberdus/client-testing/pull/107) | [#1826](https://github.com/Liberdus/web-client-v2/pull/1826) | `d91fa29f` |
| [#108](https://github.com/Liberdus/client-testing/pull/108) | [#1827](https://github.com/Liberdus/web-client-v2/pull/1827) | `765164a4` |
| [#109](https://github.com/Liberdus/client-testing/pull/109) | [#1828](https://github.com/Liberdus/web-client-v2/pull/1828) | `de6fd8d0` |
| [#110](https://github.com/Liberdus/client-testing/pull/110) | [#1831](https://github.com/Liberdus/web-client-v2/pull/1831), [#1833](https://github.com/Liberdus/web-client-v2/pull/1833) | `2c74518d` |
| [#111](https://github.com/Liberdus/client-testing/pull/111) | [#1834](https://github.com/Liberdus/web-client-v2/pull/1834) | `b18d4835` |
| [#112](https://github.com/Liberdus/client-testing/pull/112) | [#1837](https://github.com/Liberdus/web-client-v2/pull/1837) | `3a9e06e6` |
| [#113](https://github.com/Liberdus/client-testing/pull/113) | [#1840](https://github.com/Liberdus/web-client-v2/pull/1840) | `e83626c6` |
| [#114](https://github.com/Liberdus/client-testing/pull/114) | [#1840](https://github.com/Liberdus/web-client-v2/pull/1840), [#1841](https://github.com/Liberdus/web-client-v2/pull/1841) | `cb81021f` |
| [#115](https://github.com/Liberdus/client-testing/pull/115) | [#1844](https://github.com/Liberdus/web-client-v2/pull/1844) | `475010e8` |
| [#116](https://github.com/Liberdus/client-testing/pull/116) | [#1846](https://github.com/Liberdus/web-client-v2/pull/1846) | `ad25624d` |
| [#118](https://github.com/Liberdus/client-testing/pull/118) | [#1850](https://github.com/Liberdus/web-client-v2/pull/1850) | `9809a021` |
| [#119](https://github.com/Liberdus/client-testing/pull/119) | [#1851](https://github.com/Liberdus/web-client-v2/pull/1851) | `9bf97d79` |

The source PRs are superseded only after the new PR is published and coverage
preservation is verified. Closing a superseded PR does not merge it or remove
its original branch. Later fixture-only compatibility repairs are separate
commits and retain behavioral assertions.

## Pending stack

The pending topics remain separate PRs in this order above the consolidated
topic. Each PR contains only its own new layer relative to its direct parent.

| Test PR | Required open client PRs | Branch |
| --- | --- | --- |
| [#120](https://github.com/Liberdus/client-testing/pull/120) | [1852](https://github.com/Liberdus/web-client-v2/pull/1852) | `codex/1654-your-vote-tests` |
| [#121](https://github.com/Liberdus/client-testing/pull/121) | [1855](https://github.com/Liberdus/web-client-v2/pull/1855) | `codex/1853-media-owner-tests` |
| [#122](https://github.com/Liberdus/client-testing/pull/122) | [1856](https://github.com/Liberdus/web-client-v2/pull/1856) | `codex/1854-delete-feedback-tests` |
| [#123](https://github.com/Liberdus/client-testing/pull/123) | [1857](https://github.com/Liberdus/web-client-v2/pull/1857) | `codex/1847-video-preview-tests` |
| [#124](https://github.com/Liberdus/client-testing/pull/124) | [1857](https://github.com/Liberdus/web-client-v2/pull/1857), [1859](https://github.com/Liberdus/web-client-v2/pull/1859) | `codex/1858-immersive-media-tests` |

Pending tests are validated individually against their required client PR heads.
A cumulative test topic can require several client features; it is not expected
to pass wholesale against a client head that contains only one of them. Keep
these tests unmerged until their client features are on main, then revalidate.
After parent test integration, rebase and retarget children toward shared main,
using the recorded parent boundary when a parent was squash-merged.

## Excluded and protected work

- Closed reply-quote test PR [#97](https://github.com/Liberdus/client-testing/pull/97)
  and closed call-link test PR [#99](https://github.com/Liberdus/client-testing/pull/99)
  stay closed and preserved. Neither their own commits nor their tests enter the new stack.
- Test PRs #81–#87 and unrelated live-network harness PR #62 remain unchanged.
- MLS coverage stays with its implementation in
  [web-client #1655](https://github.com/Liberdus/web-client-v2/pull/1655).
- Historical/prototype coverage without a matching selected client implementation
  remains on its existing preservation branch; it is not silently promoted.
