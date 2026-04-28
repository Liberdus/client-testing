async function holdNextInject(page, responseBody) {
  await page.evaluate((mockResponseBody) => {
    if (!window.__injectMockOriginalFetch) {
      window.__injectMockOriginalFetch = window.fetch.bind(window);
    }

    let releaseResponse;
    const state = {
      intercepted: false,
      postData: null,
      released: false,
      responded: false,
      responseBody: mockResponseBody,
      url: null,
    };

    state.releasePromise = new Promise((resolve) => {
      releaseResponse = resolve;
    });

    state.release = () => {
      state.released = true;
      releaseResponse();
    };

    window.__injectMockState = state;
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      const method = (init?.method || input?.method || 'GET').toUpperCase();

      if (!state.intercepted && method === 'POST' && /\/inject(?:$|\?)/.test(url)) {
        state.intercepted = true;
        state.postData = init?.body || null;
        state.url = url;

        await state.releasePromise;
        state.responded = true;
        return new Response(JSON.stringify(state.responseBody), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        });
      }

      return window.__injectMockOriginalFetch(input, init);
    };
  }, responseBody);

  return {
    dispose: async () => {
      await page.evaluate(() => {
        if (window.__injectMockOriginalFetch) {
          window.fetch = window.__injectMockOriginalFetch;
        }
        delete window.__injectMockOriginalFetch;
        delete window.__injectMockState;
      }).catch(() => {});
    },
    fulfill: async () => {
      await page.evaluate(() => window.__injectMockState?.release());
      await page.waitForFunction(() => window.__injectMockState?.responded === true);
    },
    intercepted: page.waitForFunction(() => window.__injectMockState?.intercepted === true).then(() => {
      return page.evaluate(() => ({
        postData: window.__injectMockState.postData,
        url: window.__injectMockState.url,
      }));
    }),
    release: async () => {
      await page.evaluate(() => window.__injectMockState?.release()).catch(() => {});
    },
  };
}

function failedInjectResponse(reason = 'forced_inject_failure') {
  return {
    result: {
      success: false,
      reason,
    },
  };
}

module.exports = {
  failedInjectResponse,
  holdNextInject,
};
