# Offline Multichain regression

Use Node.js 20.19 or newer and select the exact implementation checkout:

```bash
WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2 node --test local-tests/tests/issue-1732-multichain-totals.test.mjs
```

This standalone test imports the client module and exercises catalog fallback,
balance failures, pricing recovery, partial valuations, known zero balances, and
reset/loading styling in both Multichain totals. DOM elements are lightweight
fixtures; all network requests are intercepted with synthetic read-only replies.
No account, external service, signing, or broadcast is used.

The test requires the client fix for Liberdus/web-client-v2#1732. Keep this topic
branch unmerged until that fix is on client main, then rerun against that main
revision before merging. At companion base `a7df4e9`, published main has neither
the broader offline runner nor its instructions, so this file runs directly with
Node and does not claim validation by that unavailable suite.
