const { test, expect } = require('../fixtures/base');

test.describe('Storage Limit Tests', () => {
    test('should show Storage Warning toast when localStorage is full', async ({ page }) => {
        // Navigate to the app
        await page.goto('');
        await page.waitForLoadState('networkidle');

        // fill storage with 1KB chunks until we hit an error
        await page.evaluate(() => {
            // Clean up any existing test data
            const testPrefix = 'storage-test-';
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const key = localStorage.key(i);
                if (key && key.startsWith(testPrefix)) {
                    localStorage.removeItem(key);
                }
            }

            // Create 1KB of data
            function createKB() {
                const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
                let data = '';
                // Approximately 1KB of data (1024 chars)
                for (let i = 0; i < 1024; i++) {
                    data += chars.charAt(Math.floor(Math.random() * chars.length));
                }
                return data;
            }

            // Keep adding chunks until we get an error
            let i = 0;
            try {
                // Create 15000 chunks max (more than enough to fill 10MB)
                for (i = 0; i < 15000; i++) {
                    localStorage.setItem(`${testPrefix}-chunk-${i}`, createKB());
                }
            } catch (e) {
            }

        });

        // Reload the page to trigger the warning
        await page.reload();
        try {
            // Wait for and check the Storage Warning toast
            const toastLocator = page.locator('.toast.warning:has-text("Storage Warning")');
            await expect(toastLocator).toBeVisible({ timeout: 10000 });

            // Get and log the toast message
            const toastText = await toastLocator.textContent();
        } finally {
            // Clean up test data
            await page.evaluate(() => {
                const testPrefix = 'storage-test-';
                for (let i = localStorage.length - 1; i >= 0; i--) {
                    const key = localStorage.key(i);
                    if (key && key.startsWith(testPrefix)) {
                        localStorage.removeItem(key);
                    }
                }
            });
        }
    });
});
