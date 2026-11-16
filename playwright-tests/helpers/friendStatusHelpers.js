const { expect } = require('@playwright/test');
const { getInjectedTransaction } = require('./injectHelpers');

const FriendStatus = Object.freeze({
  BLOCKED: 0,
  OTHER: 1,
  CONNECTION: 2,
});

const FRIEND_STATUS_LABELS = Object.freeze({
  [FriendStatus.BLOCKED]: 'Blocked',
  [FriendStatus.OTHER]: 'Tolled',
  [FriendStatus.CONNECTION]: 'Connection',
});

const FRIEND_STATUS_STATE_TIMEOUT = 15_000;
const FRIEND_STATUS_SETTLEMENT_TIMEOUT = 60_000;

function isFriendStatusInjection(response) {
  return getInjectedTransaction(response.request())?.type === 'update_toll_required';
}

async function readFriendStatusState(page) {
  const firstStatusInput = page.locator('#friendForm input[name="friendStatus"]').first();
  if (await firstStatusInput.isEnabled()) {
    return 'ready';
  }

  // Pending and refreshing use loading toasts; only errors appear inside the modal.
  const pendingToast = page.locator('#toastContainer .toast.loading.show', {
    hasText: /^Status update pending\u2026$/,
  });
  if (await pendingToast.isVisible()) return 'pending';

  const refreshMessage = page.locator('#friendStatusRefreshMessage');
  if (await refreshMessage.isVisible()) {
    const message = await refreshMessage.textContent();
    if (/offline/i.test(message)) return 'offline';
    if (/could not refresh|failed/i.test(message)) return 'failed';
  }

  return 'checking';
}

async function waitForFriendStatusState(page) {
  let currentState;
  // A selected pending value is optimistic; wait for confirmed, usable controls.
  await expect.poll(async () => {
    currentState = await readFriendStatusState(page);
    return currentState;
  }, {
    message: 'Contact Status did not finish settling and refreshing',
    timeout: FRIEND_STATUS_STATE_TIMEOUT,
  }).toMatch(/^(ready|offline|failed)$/);
  return currentState;
}

async function openFriendStatusModal(page, openButton) {
  await openButton.click();
  await expect(page.locator('#friendModal.active')).toBeVisible();
}

async function closeFriendStatusModal(page) {
  await page.locator('#closeFriendModal').click();
  await expect(page.locator('#friendModal')).not.toHaveClass(/active/);
}

function friendStatusUnavailableError(state, status) {
  const requestedStatus = FRIEND_STATUS_LABELS[status] || String(status);
  return new Error(`Cannot change Contact Status to ${requestedStatus} while the modal is ${state}`);
}

async function getAcceptedFriendStatusTxid(response, status) {
  const result = await response.json();
  const success = result?.result?.success ?? result?.success;
  if (success !== true) {
    const reason = result?.result?.reason || result?.reason || 'unknown reason';
    throw new Error(`Contact Status ${FRIEND_STATUS_LABELS[status]} injection failed: ${reason}`);
  }

  const txid = result?.result?.txId || result?.result?.txid || result?.txId || result?.txid;
  if (!txid) {
    throw new Error(`Contact Status ${FRIEND_STATUS_LABELS[status]} injection returned no transaction ID`);
  }

  return txid;
}

async function waitForFriendStatusSettlement(page, status, txid) {
  let response;
  try {
    response = await page.waitForResponse(async (candidate) => {
      const url = candidate.url();
      const matchesTransaction = url.includes(`/transaction/${txid}`)
        || (url.includes('/collector/api/transaction') && url.includes(`appReceiptId=${txid}`));
      if (!matchesTransaction) {
        return false;
      }

      try {
        const body = await candidate.json();
        return body?.transaction?.success === true || body?.transaction?.success === false;
      } catch {
        return false;
      }
    }, { timeout: FRIEND_STATUS_SETTLEMENT_TIMEOUT });
  } catch {
    throw new Error(`Contact Status ${FRIEND_STATUS_LABELS[status]} did not settle within 60 seconds`);
  }

  const result = await response.json();
  if (result.transaction?.success !== true) {
    const reason = result.transaction?.reason || 'unknown reason';
    throw new Error(`Contact Status ${FRIEND_STATUS_LABELS[status]} failed to settle: ${reason}`);
  }
}

async function updateFriendStatus(page, openButton, status) {
  await openFriendStatusModal(page, openButton);
  const state = await waitForFriendStatusState(page);
  if (state !== 'ready') {
    throw friendStatusUnavailableError(state, status);
  }

  const checkedStatus = Number(await page
    .locator('#friendForm input[name="friendStatus"]:checked')
    .getAttribute('value'));

  if (checkedStatus === status) {
    await closeFriendStatusModal(page);
    return;
  }

  const statusInput = page.locator(`#friendForm input[name="friendStatus"][value="${status}"]`);
  const submitButton = page.locator('#friendForm button[type="submit"]');
  await statusInput.check();
  await expect(submitButton).toBeEnabled();

  const injectionPromise = page.waitForResponse(isFriendStatusInjection);
  await submitButton.click();
  const txid = await getAcceptedFriendStatusTxid(await injectionPromise, status);

  const settlementPromise = waitForFriendStatusSettlement(page, status, txid);
  await expect(page.locator('#friendModal')).not.toHaveClass(/active/);
  await settlementPromise;
  await expect(openButton).toHaveClass(new RegExp(`\\bstatus-${status}\\b`));
}

async function setFriendStatus(page, username, status) {
  // Use the contacts screen path when the caller only knows the username and
  // does not already have that chat open.
  await page.locator('#switchToContacts').click();
  await expect(page.locator('#contactsScreen.active')).toBeVisible();
  await page.locator('#contactsList .chat-name', { hasText: username }).click();
  await expect(page.locator('#contactInfoModal.active')).toBeVisible();

  await updateFriendStatus(page, page.locator('#addFriendButtonContactInfo'), status);

  await page.locator('#closeContactInfoModal').click();
  await expect(page.locator('#contactInfoModal')).not.toHaveClass(/active/);
}

async function setFriendStatusInChat(page, status) {
  // Use the chat header button when the caller already has the relevant chat
  // modal open and wants to keep working in that conversation.
  await updateFriendStatus(page, page.locator('#addFriendButtonChat'), status);
}

async function getCurrentFriendStatus(page, username) {
  // Open the friend modal just long enough to read the refreshed radio value,
  // then return the page to its previous modal-free state.
  await page.locator('#switchToContacts').click();
  await expect(page.locator('#contactsScreen.active')).toBeVisible();
  await page.locator('#contactsList .chat-name', { hasText: username }).click();
  await expect(page.locator('#contactInfoModal.active')).toBeVisible();
  await page.locator('#addFriendButtonContactInfo').click();
  await expect(page.locator('#friendModal.active')).toBeVisible();
  const state = await waitForFriendStatusState(page);
  if (state !== 'ready') {
    throw new Error(`Cannot read confirmed Contact Status while the modal is ${state}`);
  }

  const checked = await page.locator('#friendForm input[name="friendStatus"]:checked').getAttribute('value');

  await closeFriendStatusModal(page);
  await page.locator('#closeContactInfoModal').click();
  await expect(page.locator('#contactInfoModal')).not.toHaveClass(/active/);

  return Number(checked);
}

module.exports = {
  FriendStatus,
  getCurrentFriendStatus,
  setFriendStatus,
  setFriendStatusInChat,
};
