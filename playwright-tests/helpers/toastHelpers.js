/**
 * The toast-closing script. Exported so it can be used with both
 * page.addInitScript() and context.addInitScript().
 */
const toastCloserScript = () => {
  console.log('🍞 [ToastCloser] Script loaded');

  // Only close toasts whose text matches one of these substrings.
  const whitelist = [
    'The LIB in this Testnet is not of any value and will not be transferred to the Mainnet',
    'This user has deposited a toll to message you'
  ];

  function tryCloseToast(el) {
    try {
      if (!el || el.nodeType !== 1) return;
      const text = (el.innerText || '').toLowerCase();
      console.log('🍞 [ToastCloser] Checking toast:', text.substring(0, 80));
      // only proceed if toast text matches our whitelist
      const matched = whitelist.some(s => text.includes(s.toLowerCase()));
      if (!matched) {
        console.log('🍞 [ToastCloser] Not in whitelist, ignoring');
        return;
      }
      console.log('🍞 [ToastCloser] Whitelist match! Closing...');
      const closeBtn = el.querySelector && el.querySelector('.toast-close-btn');
      if (closeBtn && typeof closeBtn.click === 'function') {
        closeBtn.click();
        return;
      }
      // fallback: remove the node if it's a toast
      if (el.classList && el.classList.contains('toast')) {
        el.remove();
      }
    } catch (e) {
      console.log('🍞 [ToastCloser] Error:', e);
    }
  }

  function attachObserver() {
    const target = document.body || document.documentElement;
    if (!target) {
      console.log('🍞 [ToastCloser] No DOM target yet, retrying...');
      setTimeout(attachObserver, 50);
      return;
    }

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          try {
            if (!node || node.nodeType !== 1) continue;
            // direct match for any toast node
            if (node.matches && node.matches('.toast')) {
              tryCloseToast(node);
              continue;
            }
            // children matching for any toast
            if (node.querySelectorAll) {
              const toasts = node.querySelectorAll('.toast');
              for (const t of toasts) tryCloseToast(t);
            }
          } catch (e) {}
        }
      }
    });

    try {
      observer.observe(target, { childList: true, subtree: true });
      console.log('🍞 [ToastCloser] MutationObserver attached');
    } catch (e) {
      console.log('🍞 [ToastCloser] Failed to attach observer:', e);
    }

    // initial pass for already-present toasts
    setTimeout(() => {
      try {
        const list = document.querySelectorAll('.toast');
        console.log('🍞 [ToastCloser] Initial pass found', list ? list.length : 0, 'toast(s)');
        if (list && list.forEach) list.forEach(t => tryCloseToast(t));
      } catch (e) {}
    }, 200);
  }

  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachObserver);
    console.log('🍞 [ToastCloser] Waiting for DOMContentLoaded');
  } else {
    attachObserver();
  }
};

/**
 * Injects toast-closing script into a page.
 * @param {import('@playwright/test').Page} page
 */
async function injectToastCloser(page) {
  await page.addInitScript(toastCloserScript);
}

/**
 * Injects toast-closing script into a context (applies to all pages).
 * @param {import('@playwright/test').BrowserContext} context
 */
async function injectToastCloserToContext(context) {
  await context.addInitScript(toastCloserScript);
}

/**
 * Creates a new browser context with toast-closing script pre-injected.
 * Use this instead of browser.newContext() in tests.
 * @param {import('@playwright/test').Browser} browser
 * @param {import('@playwright/test').BrowserContextOptions} [options]
 * @returns {Promise<import('@playwright/test').BrowserContext>}
 */
async function newContext(browser, options) {
  const context = await browser.newContext(options);
  await context.addInitScript(toastCloserScript);
  return context;
}

module.exports = { injectToastCloser, injectToastCloserToContext, newContext, toastCloserScript };
