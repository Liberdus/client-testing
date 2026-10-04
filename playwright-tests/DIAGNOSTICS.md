# Failure diagnostics

The normal Playwright configuration retains traces from every failed attempt, including attempt zero. The shared fixture observes both standard pages and contexts created by `newContext()`; popup pages inherit their account role. Reused suite contexts are observed again for each test attempt.

Failed lookup/setup reports attach public usernames and addresses, timing, gateway URLs, HTTP outcomes, transport failures, pending requests, and sanitized lookup/injection/receipt responses. They do not read local storage or copy signed request bodies. Screenshots and UI state are captured before explicit recipient-page cleanup. The transfer fixture waits for both bounded setup results before closing either account and preserves the original error if cleanup fails.

`createAndSignInUser()` has a 90-second total setup budget for navigation, username availability and registration. It requires the active Chats screen and expected visible username; an error toast fails setup promptly. This budget leaves time inside the five-minute scenario timeout for evidence and cleanup. It does not repair application registration recovery ([web-client-v2 #1742](https://github.com/Liberdus/web-client-v2/issues/1742)).

Recipient lookup observes the request before entering the username, then gives the existing UI result up to ten seconds to become `found`. It does not retype, retry the lookup, or accept a negative result.

Run the offline harness from `playwright-tests`:

```sh
npm run test:diagnostics
```

Two cases deliberately fail attempt zero and pass their retry: a negative lookup and a missing registration confirmation in `beforeAll`. The report verifier checks the original trace, correct recipient screenshot, popup error, registration/cleanup evidence, and absence of the injected secret marker. Additional cases cover delayed success, explicit registration rejection, null/stalled receipts and transport failure. These routes do not create real accounts or contact a gateway.
