const { expect } = require('@playwright/test');

class AttachmentMenu {
  static async open(attachmentLink) {
    await attachmentLink.scrollIntoViewIfNeeded();
    await attachmentLink.evaluate(AttachmentMenu.waitForScrollSettled);
    await attachmentLink.click();

    const saveOption = attachmentLink.page().locator(
      '#imageAttachmentContextMenu .context-menu-option[data-action="save"]'
    );
    await expect(saveOption).toBeVisible();
    return saveOption;
  }

  // Runs in the page: allow queued scroll events and layout changes to settle
  // before opening a menu that intentionally closes whenever its container scrolls.
  static waitForScrollSettled(attachment) {
    const container = attachment.closest('.messages-container');
    if (!container) throw new Error('Attachment is not inside the message container');

    return new Promise((resolve, reject) => {
      let frame;
      let previousPosition;
      let stableSince = performance.now();
      const timeout = setTimeout(() => {
        cancelAnimationFrame(frame);
        reject(new Error('Attachment scrolling did not settle within 5 seconds'));
      }, 5_000);

      const sample = (now) => {
        const rect = attachment.getBoundingClientRect();
        const position = [
          container.scrollTop, container.scrollLeft,
          rect.top, rect.left, rect.width, rect.height
        ].join(',');
        if (position !== previousPosition) {
          previousPosition = position;
          stableSince = now;
        }
        if (now - stableSince >= 100) {
          clearTimeout(timeout);
          resolve();
          return;
        }
        frame = requestAnimationFrame(sample);
      };
      frame = requestAnimationFrame(sample);
    });
  }
}

module.exports = { AttachmentMenu };
