# Client regression tests

This repository owns reusable tests for `web-client-v2`. `main` is the permanent
integration target. The old `codex/local-client-tests` branch is a preservation
snapshot, not the base for new work.

- Read `local-tests/README.md` before offline source tests or manual fixtures.
  Set `WEB_CLIENT_ROOT` to the absolute path of the exact client checkout being
  tested, including when it is a worktree.
- Inspect branch and dirty state in both repositories. Preserve other agents'
  work and use a task-specific test branch/worktree. Never commit or push
  directly to `main`.
- When additional coverage is needed, add focused tests and synthetic fixtures
  under `local-tests/`. Keep implementation and companion commits separate.
  Running existing tests or changing only client documentation does not itself
  require a companion test PR; report N/A with a reason when appropriate.
- Open draft test PRs against `main`. For a genuine test dependency, a stacked
  PR may temporarily target its parent test branch; record that dependency and
  retarget/rebase onto `main` after the parent merges, accounting for squash
  merges. Do not modify unrelated open PR stacks.
- Link each test PR to its relevant web-client PRs. For an open client PR, add
  the reciprocal test PR link there. For an already-merged client PR, link it
  from the test PR without creating or editing a replacement client PR.
- Record client and test SHAs, exact commands, results and prerequisites. Test
  each feature layer against its matching current client PR head. Keep dependent
  tests unmerged until all required client features are on main, then rerun the
  focused tests against that main revision before merging the test PR.
- Report pending commits, topic publication, PR review, dependencies and merge
  status accurately. Follow the user's commit/push authorization and verify
  publication before claiming a branch is available remotely.
- Keep generated reports, browser profiles, credentials and account data out of
  commits. Offline source tests need no live account. Live `playwright-tests/`
  flows require a suitable test environment and authorization for their account
  and transaction interactions.
