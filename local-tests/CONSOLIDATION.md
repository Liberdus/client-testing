# Consolidated offline coverage

[Client-testing #125](https://github.com/Liberdus/client-testing/pull/125) brings
together the offline runner and coverage from 43 companion PRs. The first 21
sources were consolidated at companion `57e9a31`. The update incorporates the
remaining feature stack and later standalone tests on top of companion main
`01dcbcdaad7976050b581ffeed28ee42ae722aaf`.

The original client baseline was `e33e6808e42551d4310d9753de752343bc8a87c3`.
The client changes required by the added coverage are all in client main
`2829a5c7db9ecaf5158dca6090c02b5def4b6e24`. See #125 for validation commands
and results.

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
| [#120](https://github.com/Liberdus/client-testing/pull/120) | [#1852](https://github.com/Liberdus/web-client-v2/pull/1852) | `82f27f2f` |
| [#121](https://github.com/Liberdus/client-testing/pull/121) | [#1855](https://github.com/Liberdus/web-client-v2/pull/1855) | `31575b79` |
| [#122](https://github.com/Liberdus/client-testing/pull/122) | [#1856](https://github.com/Liberdus/web-client-v2/pull/1856) | `b8409357` |
| [#123](https://github.com/Liberdus/client-testing/pull/123) | [#1857](https://github.com/Liberdus/web-client-v2/pull/1857) | `6e22400f` |
| [#124](https://github.com/Liberdus/client-testing/pull/124) | [#1857](https://github.com/Liberdus/web-client-v2/pull/1857), [#1859](https://github.com/Liberdus/web-client-v2/pull/1859) | `9735a655` |
| [#131](https://github.com/Liberdus/client-testing/pull/131) | [#1864](https://github.com/Liberdus/web-client-v2/pull/1864) | `a98c8294` |
| [#132](https://github.com/Liberdus/client-testing/pull/132) | [#1865](https://github.com/Liberdus/web-client-v2/pull/1865) | `498d837e` |
| [#133](https://github.com/Liberdus/client-testing/pull/133) | [#1868](https://github.com/Liberdus/web-client-v2/pull/1868), [#1869](https://github.com/Liberdus/web-client-v2/pull/1869) | `9ccc6e50` |
| [#134](https://github.com/Liberdus/client-testing/pull/134) | [#1869](https://github.com/Liberdus/web-client-v2/pull/1869) | `14c694be` |
| [#135](https://github.com/Liberdus/client-testing/pull/135) | [#1870](https://github.com/Liberdus/web-client-v2/pull/1870) | `09d3f2d4` |
| [#136](https://github.com/Liberdus/client-testing/pull/136) | [#1871](https://github.com/Liberdus/web-client-v2/pull/1871) | `9b8f8deb` |
| [#137](https://github.com/Liberdus/client-testing/pull/137) | [#1859](https://github.com/Liberdus/web-client-v2/pull/1859), [#1873](https://github.com/Liberdus/web-client-v2/pull/1873) | `c756a586` |
| [#138](https://github.com/Liberdus/client-testing/pull/138) | [#1874](https://github.com/Liberdus/web-client-v2/pull/1874) | `1266305f` |
| [#139](https://github.com/Liberdus/client-testing/pull/139) | [#1874](https://github.com/Liberdus/web-client-v2/pull/1874), [#1876](https://github.com/Liberdus/web-client-v2/pull/1876) | `fee857c2` |
| [#140](https://github.com/Liberdus/client-testing/pull/140) | [#1879](https://github.com/Liberdus/web-client-v2/pull/1879) | `e304b905` |
| [#141](https://github.com/Liberdus/client-testing/pull/141) | [#1881](https://github.com/Liberdus/web-client-v2/pull/1881) | `10dc6917` |
| [#142](https://github.com/Liberdus/client-testing/pull/142) | [#1888](https://github.com/Liberdus/web-client-v2/pull/1888) | `2003e7ca` |
| [#143](https://github.com/Liberdus/client-testing/pull/143) | [#1893](https://github.com/Liberdus/web-client-v2/pull/1893) | `a0e8cfd2` |
| [#144](https://github.com/Liberdus/client-testing/pull/144) | [#1879](https://github.com/Liberdus/web-client-v2/pull/1879), [#1896](https://github.com/Liberdus/web-client-v2/pull/1896) | `4d384645` |
| [#145](https://github.com/Liberdus/client-testing/pull/145) | [#1907](https://github.com/Liberdus/web-client-v2/pull/1907) | `b2ae7839` |
| [#146](https://github.com/Liberdus/client-testing/pull/146) | [#1912](https://github.com/Liberdus/web-client-v2/pull/1912) | `89099203` |
| [#147](https://github.com/Liberdus/client-testing/pull/147) | [#1912](https://github.com/Liberdus/web-client-v2/pull/1912), [#1913](https://github.com/Liberdus/web-client-v2/pull/1913) | `6a771615` |

The earlier source rows record the preserved tips for the initial consolidation.
The later rows record the source PR heads used for this update. Each stacked PR
contributes its own coverage, using the latest source when an older child was
based on an earlier parent revision. Original cherry-pick trailers retain source
provenance.

## Excluded and protected work

- Closed reply-quote test PR [#97](https://github.com/Liberdus/client-testing/pull/97)
  and closed call-link test PR [#99](https://github.com/Liberdus/client-testing/pull/99)
  stay closed and preserved. Their coverage remains excluded.
- Test PRs #81–#87 and unrelated live-network harness PR #62 remain unchanged.
- MLS coverage stays with its implementation in
  [web-client #1655](https://github.com/Liberdus/web-client-v2/pull/1655).
- Historical/prototype coverage without a matching selected client implementation
  remains on its existing preservation branch.
