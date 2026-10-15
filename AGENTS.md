# Agent instructions

This repository owns reusable tests for `web-client-v2`.

- Use `local-tests/` for offline source regression tests and manual browser fixtures. Read `local-tests/README.md` before adding or running them.
- Use `playwright-tests/` for live end-to-end tests. These tests may create accounts and send transactions; run them only with an explicitly selected test environment and authorization for those interactions.
- Set `WEB_CLIENT_ROOT` to the absolute path of the implementation checkout being tested. Do not assume the nearest `web-client-v2` directory is the intended checkout.
- Inspect `git status` and the current branch in both repositories before changing files. Preserve existing work and stage only the files belonging to your change.
- `codex/local-client-tests` is the shared branch that accumulates the reusable test suite. With concurrent agents, use separate topic branches or worktrees based on that branch; integrate tested commits into the shared branch sequentially. Do not switch branches in another agent's checkout.
- Add or update a focused regression test when implementing a behavior change. Run that test against `WEB_CLIENT_ROOT`, and run the broader offline suite when appropriate. Record the tested client commit or checkout, command, and result in the handoff; report any legacy or branch-specific failures accurately.
- Commit test source, fixtures containing synthetic data, runner changes, and documentation. Keep generated reports, browser profiles, account data, credentials, and downloaded artifacts out of commits.
- Install dependencies with `npm ci --prefix playwright-tests`. If a browser is needed, run `npx playwright install chromium` from `playwright-tests/`. Offline source tests do not require a live network or account.

Client implementation agents need an instruction in their own repository pointing here. Codex does not automatically discover instructions in a sibling repository; see `local-tests/README.md` for a portable example.
