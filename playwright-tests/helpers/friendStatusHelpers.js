const { expect } = require('@playwright/test');

const FriendStatus = Object.freeze({
  BLOCKED: 0,
  OTHER: 1,
  CONNECTION: 2,
});

async function waitForFriendStatusTransaction(page) {
  await page.waitForEvent('console', {
    timeout: 60_000,
    predicate: (msg) => /update_toll_required transaction successfully processed/i.test(msg.text()),
  });
}

async function setFriendStatus(page, username, status) {
  // Use the contacts screen path when the caller only knows the username and
  // does not already have that chat open.
  await page.locator('#switchToContacts').click();
  await expect(page.locator('#contactsScreen.active')).toBeVisible();
  await page.locator('#contactsList .chat-name', { hasText: username }).click();
  await expect(page.locator('#contactInfoModal.active')).toBeVisible();
  await page.locator('#addFriendButtonContactInfo').click();
  await expect(page.locator('#friendModal.active')).toBeVisible();
  await page.locator(`#friendForm input[type=radio][value="${status}"]`).check();

  await Promise.all([
    waitForFriendStatusTransaction(page),
    page.locator('#friendForm button[type="submit"]').click(),
  ]);

  await page.locator('#closeContactInfoModal').click();
  await expect(page.locator('#contactInfoModal')).not.toHaveClass(/active/);
}

async function setFriendStatusInChat(page, status) {
  // Use the chat header button when the caller already has the relevant chat
  // modal open and wants to keep working in that conversation.
  await page.locator('#addFriendButtonChat').click();
  await expect(page.locator('#friendModal.active')).toBeVisible();
  await page.locator(`#friendForm input[type=radio][value="${status}"]`).check();

  await Promise.all([
    waitForFriendStatusTransaction(page),
    page.locator('#friendForm button[type="submit"]').click(),
  ]);

  await expect(page.locator('#friendModal')).not.toHaveClass(/active/);
}

async function getCurrentFriendStatus(page, username) {
  // Open the friend modal just long enough to read the selected radio value,
  // then return the page to its previous modal-free state.
  await page.locator('#switchToContacts').click();
  await expect(page.locator('#contactsScreen.active')).toBeVisible();
  await page.locator('#contactsList .chat-name', { hasText: username }).click();
  await expect(page.locator('#contactInfoModal.active')).toBeVisible();
  await page.locator('#addFriendButtonContactInfo').click();
  await expect(page.locator('#friendModal.active')).toBeVisible();

  const checked = await page.locator('#friendForm input[type=radio]:checked').getAttribute('value');

  await page.locator('#closeFriendModal').click();
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
