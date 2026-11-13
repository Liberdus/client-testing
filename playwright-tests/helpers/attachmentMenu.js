const { expect } = require('@playwright/test');

class AttachmentMenu {
  static attachmentRow(page, direction, fileName) {
    const encodedName = encodeURIComponent(fileName);
    return page.locator(`#chatModal .message.${direction} .attachment-row[data-name="${encodedName}"]`);
  }

  static async open(attachmentRow, action) {
    await attachmentRow.scrollIntoViewIfNeeded();
    await attachmentRow.evaluate(AttachmentMenu.waitForScrollSettled);
    await attachmentRow.click();

    const option = attachmentRow.page().locator(
      `#imageAttachmentContextMenu .context-menu-option[data-action="${action}"]`
    );
    await expect(option).toBeVisible();
    return option;
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
