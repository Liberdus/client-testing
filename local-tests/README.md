# Offline full video cache regression tests

Use Node.js 20.19 or newer. Point `WEB_CLIENT_ROOT` to the absolute path of the client checkout under test.

```bash
export WEB_CLIENT_ROOT=/absolute/path/to/web-client-v2
node --test local-tests/tests/issue-1675-full-media-cache.test.mjs
```

The policy test runs the production cache classes with a synthetic IndexedDB transaction fixture. It checks the shared full-media budget, FIFO order, storage estimates, quota retry and rollback, oversized files, unavailable storage, deletion, and backup exclusion.

The browser regression uses the companion Playwright dependencies and installed Chromium. Set `PLAYWRIGHT_ROOT` if the dependencies are installed in another checkout. FFmpeg with `libvpx` generates the synthetic WebM at runtime.

```bash
PLAYWRIGHT_ROOT=/absolute/path/to/client-testing/playwright-tests \
  node --test local-tests/tests/issue-1675-full-video-cache.browser.test.mjs
```

The browser fixture uses production attachment controls, decryption, and IndexedDB with synthetic messages and a loopback file server. It verifies Open and Save in both orders, reload persistence, original saved bytes, existing image and thumbnail records, missing storage fallback, and cached preview safety. The mobile case uses an emulated viewport and a synthetic download bridge. The fixture uses no live account or external service.

These files run directly because the published companion `main` at `a7df4e9` lacks an offline runner. They require the client behavior in [web-client-v2 #1675](https://github.com/Liberdus/web-client-v2/issues/1675). After the client fix reaches `main`, rerun both commands against that revision and record its SHA before merging the companion PR.
