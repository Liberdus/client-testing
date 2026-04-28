const { test: base, expect } = require('../fixtures/base');
const { FriendStatus, setFriendStatus } = require('../helpers/friendStatusHelpers');
const { sendMessageTo } = require('../helpers/messageHelpers');
const { createAndSignInUser, generateUsername } = require('../helpers/userHelpers');
const { newContext } = require('../helpers/toastHelpers');

const Reaction = {
  THUMBS_UP: '👍',
  HEART: '❤️',
  CUSTOM: '🤩',
};

const test = base.extend({
  users: async ({ browserName, browser }, use, testInfo) => {
    // Each test needs two independent signed-in users so we can verify both
    // the local reaction UI and the cross-device sync seen by the sender.
    const userA = generateUsername(browserName);
    const userB = generateUsername(browserName);
    const ctxA = await newContext(browser);
    const ctxB = await newContext(browser);
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await testInfo.attach('reaction-test-users.json', {
      body: JSON.stringify({ userA, userB }, null, 2),
      contentType: 'application/json',
    });

    try {
      await Promise.all([
        createAndSignInUser(pageA, userA),
        createAndSignInUser(pageB, userB),
      ]);

      await use({
        a: { username: userA, page: pageA, context: ctxA },
        b: { username: userB, page: pageB, context: ctxB },
      });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  },
});

async function openChat(page, contactUsername) {
  // Reopen an existing chat from the chat list. This is used after background
  // sync work so assertions run against the same UI path a returning user sees.
  await page.locator('#switchToChats').click();
  await expect(page.locator('#chatsScreen.active')).toBeVisible();

  const chatItem = page.locator('#chatList .chat-name', { hasText: contactUsername });
  await expect(chatItem).toBeVisible({ timeout: 30_000 });
  await chatItem.click();
  await expect(page.locator('#chatModal')).toBeVisible();
}

function messageBubble(page, direction, message) {
  // Scope message lookups to the open chat modal and the visible sent/received
  // side so repeated message text elsewhere on the page does not match.
  return page
    .locator(`#chatModal .messages-list .message.${direction}`)
    .filter({ hasText: message })
    .last();
}

async function openMessageContextMenu(page, direction, message) {
  // Reactions are exposed from the message context menu; opening it through the
  // bubble keeps the test on the same user-visible path as manual usage.
  const bubble = messageBubble(page, direction, message);
  await expect(bubble).toBeVisible({ timeout: 30_000 });
  await bubble.click();

  const contextMenu = page.locator('#messageContextMenu');
  await expect(contextMenu).toBeVisible({ timeout: 10_000 });
  await expect(contextMenu.getByLabel('Quick reactions')).toBeVisible();
  return contextMenu;
}

async function chooseQuickReaction(page, direction, message, accessibleName) {
  // Quick reactions should be reachable by accessible button names rather than
  // layout-specific selectors.
  const contextMenu = await openMessageContextMenu(page, direction, message);
  await contextMenu.getByRole('button', { name: accessibleName }).click();
}

async function expectReactionChip(page, direction, message, emoji, options = {}) {
  const bubble = messageBubble(page, direction, message);
  await expect(bubble.locator('.message-reaction-chip', { hasText: emoji })).toBeVisible({
    timeout: options.timeout || 15_000,
  });
}

async function expectNoReactionChip(page, direction, message, emoji, options = {}) {
  const bubble = messageBubble(page, direction, message);
  await expect(bubble.locator('.message-reaction-chip', { hasText: emoji })).toHaveCount(0, {
    timeout: options.timeout || 15_000,
  });
}

async function expectNoReactionChips(page, direction, message, options = {}) {
  const bubble = messageBubble(page, direction, message);
  await expect(bubble.locator('.message-reaction-chip')).toHaveCount(0, {
    timeout: options.timeout || 15_000,
  });
}

async function prepareReactableMessage({ a, b, message }) {
  // Common happy-path setup: A sends a message, A allows B to react toll-free,
  // and B opens the received copy before choosing a reaction.
  await sendMessageTo(a.page, b.username, message);
  await setFriendStatus(a.page, b.username, FriendStatus.CONNECTION);

  await openChat(b.page, a.username);
  await expect(pageTollLabel(b.page)).toHaveText('Toll free:', { timeout: 15_000 });
  await expect(messageBubble(b.page, 'received', message)).toBeVisible({ timeout: 30_000 });
}

function pageTollLabel(page) {
  return page.locator('#tollLabel');
}

test.describe('Message reactions', () => {
  test('user can add, change, and remove a quick reaction', async ({ users }) => {
    const { a, b } = users;
    const message = `reaction quick path ${Date.now()}`;

    // Arrange: prepare a received message where the recipient is allowed to
    // react without paying a toll.
    await prepareReactableMessage({ a, b, message });

    // Act and assert: add a thumbs-up reaction from the quick row and verify it
    // appears immediately for the reacting user.
    await chooseQuickReaction(b.page, 'received', message, 'React with thumbs up');
    await expectReactionChip(b.page, 'received', message, Reaction.THUMBS_UP);

    // Assert: the sender should eventually see the same reaction on their sent
    // copy of the message after sync.
    await openChat(a.page, b.username);
    await expectReactionChip(a.page, 'sent', message, Reaction.THUMBS_UP, { timeout: 60_000 });

    // Act and assert: choosing a different quick reaction replaces the old one
    // locally and on the sender view.
    await chooseQuickReaction(b.page, 'received', message, 'React with heart');
    await expectReactionChip(b.page, 'received', message, Reaction.HEART);
    await expectNoReactionChip(b.page, 'received', message, Reaction.THUMBS_UP);
    await expectReactionChip(a.page, 'sent', message, Reaction.HEART, { timeout: 60_000 });
    await expectNoReactionChip(a.page, 'sent', message, Reaction.THUMBS_UP);

    // Act and assert: selecting the already-active quick reaction toggles it off
    // for the reacting user.
    const contextMenu = await openMessageContextMenu(b.page, 'received', message);
    const activeHeart = contextMenu.getByRole('button', { name: 'React with heart' });
    await expect(activeHeart).toHaveAttribute('aria-pressed', 'true');
    await activeHeart.click();

    await expectNoReactionChips(b.page, 'received', message);
  });

  test('expanded emoji picker sets a custom reaction and surfaces it as active', async ({ users }) => {
    const { a, b } = users;
    const message = `reaction picker path ${Date.now()}`;

    // Arrange: start from the same toll-free received-message state as the quick
    // reaction path.
    await prepareReactableMessage({ a, b, message });

    // Act: open the expanded picker from the message context menu and choose a
    // non-default emoji.
    let contextMenu = await openMessageContextMenu(b.page, 'received', message);
    await contextMenu.getByRole('button', { name: 'Add reaction' }).click();

    const reactionDialog = b.page.getByRole('dialog', { name: 'Choose a reaction' });
    await expect(reactionDialog).toBeVisible();
    await reactionDialog.locator('.chat-reaction-sheet-button', { hasText: Reaction.CUSTOM }).first().click();

    // Assert: the chosen custom emoji is rendered as the reaction chip.
    await expectReactionChip(b.page, 'received', message, Reaction.CUSTOM);

    // Assert: reopening the context menu shows the custom emoji as the active
    // selection, which is how a user can tell it can be toggled or changed.
    contextMenu = await openMessageContextMenu(b.page, 'received', message);
    const customReactionButton = contextMenu.getByRole('button', { name: `React with ${Reaction.CUSTOM}` });
    await expect(customReactionButton).toBeVisible();
    await expect(customReactionButton).toHaveAttribute('aria-pressed', 'true');

    // Assert: the sender receives the custom reaction through sync.
    await openChat(a.page, b.username);
    await expectReactionChip(a.page, 'sent', message, Reaction.CUSTOM, { timeout: 60_000 });
  });

  test('reaction sends are blocked until the message author allows free reactions', async ({ users }) => {
    const { a, b } = users;
    const message = `reaction restriction path ${Date.now()}`;

    // Arrange: A sends B a message but B has not added A as a connection, so A
    // should not be able to send a reaction back to B.
    await sendMessageTo(a.page, b.username, message);
    await openChat(a.page, b.username);
    await expect(messageBubble(a.page, 'sent', message)).toBeVisible({ timeout: 30_000 });

    // Act and assert: the toll gate blocks the reaction and leaves the message
    // without any optimistic reaction chip.
    await chooseQuickReaction(a.page, 'sent', message, 'React with thumbs up');
    await expect(a.page.locator('.toast.info.show', {
      hasText: 'You can only send reactions to people who have added you as a connection',
    })).toBeVisible({ timeout: 10_000 });
    await expectNoReactionChips(a.page, 'sent', message);

    // Arrange: B opens the inbound chat so the contact exists locally, then
    // blocks A to exercise the stronger blocked-user gate.
    await a.page.locator('#closeChatModal').click();
    await openChat(b.page, a.username);
    await expect(messageBubble(b.page, 'received', message)).toBeVisible({ timeout: 30_000 });
    await b.page.locator('#closeChatModal').click();
    await setFriendStatus(b.page, a.username, FriendStatus.BLOCKED);

    // Act and assert: the blocked state is visible in the chat and prevents the
    // reaction from being sent or rendered.
    await openChat(a.page, b.username);
    await expect(a.page.locator('#tollValue')).toHaveText('blocked', { timeout: 15_000 });
    await chooseQuickReaction(a.page, 'sent', message, 'React with heart');
    await expect(a.page.locator('.toast.error.show', { hasText: 'You are blocked by this user' })).toBeVisible({
      timeout: 10_000,
    });
    await expectNoReactionChips(a.page, 'sent', message);
  });
});
