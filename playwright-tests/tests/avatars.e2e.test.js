const { test, expect } = require('../fixtures/base');
const fs = require('fs');
const { createAndSignInUser, generateUsername } = require('../helpers/userHelpers');
const { newContext } = require('../helpers/toastHelpers');

test.describe('Avatar management', () => {
  test('User can upload, view, and remove an avatar via My Info', async ({ browser }, testInfo) => {
    const ctx = await newContext(browser);
    const page = await ctx.newPage();
    const username = generateUsername('pw');

    try {
      await createAndSignInUser(page, username);

      // Open My Info modal
      await page.click('.app-name');
      const myInfoModal = page.locator('#myInfoModal');
      await expect(myInfoModal).toBeVisible({ timeout: 15_000 });

      // Create a tiny PNG avatar file
      const avatarPath = testInfo.outputPath('avatar.png');
      const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=';
      fs.writeFileSync(avatarPath, Buffer.from(base64, 'base64'));

      // click avatar to open edit modal
      await page.click('#myInfoAvatar');

      // Click the upload button to open file browser and upload avatar
      const uploadButton = page.locator('#avatarEditUploadButton');
      await expect(uploadButton).toBeVisible({ timeout: 5_000 });
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        uploadButton.click()
      ]);
      await fileChooser.setFiles(avatarPath);

      // Wait for avatar edit preview and controls, then save
      const previewImg = page.locator('#avatarEditPreview img').first();
      await expect(previewImg).toBeVisible({ timeout: 10_000 });

      // If a zoom slider exists, set it to a mid/high value to exercise cropping
      const zoomRange = page.locator('#avatarZoomRange');
      await expect(zoomRange).toBeVisible({ timeout: 5_000 });

      // Click save to apply the avatar
      const saveBtn = page.locator('#avatarEditSaveButton');
      await expect(saveBtn).toBeVisible({ timeout: 5_000 });
      await saveBtn.click();

      // Wait for avatar image to appear/update in the My Info modal
      const avatarImg = myInfoModal.locator('img').first();
      await expect(avatarImg).toBeVisible({ timeout: 10_000 });
      const src = await avatarImg.getAttribute('src');
      expect(src).not.toBeNull();
      expect(src.length).toBeGreaterThan(0);

      // click avatar to open edit modal
      await page.click('#myInfoAvatar');

      // Expect a remove avatar button, click it to remove avatar and return to contact info
      const deleteBtn = page.locator('#avatarEditDeleteButton');
      await expect(deleteBtn.first()).toBeVisible({ timeout: 5_000 });
      await deleteBtn.first().click();

      // after removal we return to contact info; ensure the uploaded image is gone
      await page.click('#closeAvatarEditModal');
      const srcAfter = await avatarImg.getAttribute('src').catch(() => null);
      expect(srcAfter === null || srcAfter === '' || srcAfter !== src).toBeTruthy();

      // Verify an identicon SVG is shown in the contact info avatar element
      const contactIdenticon = page.locator('#myInfoAvatar svg');
      await expect(contactIdenticon).toBeVisible({ timeout: 5_000 });

    } finally {
      try { await ctx.close(); } catch (e) {}
    }
  });
});
