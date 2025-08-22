const { test, expect } = require('../fixtures/newUserFixture');
const { createAndSignInUser, generateUsername } = require('../helpers/userHelpers');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Helper to create test files with unique names based on test info to avoid conflicts in parallel runs
async function createTestFile(baseFileName, sizeInMB = 0.5, type = 'image/png', uniqueId) {
  // Generate a unique filename by adding the unique ID before the extension
  const fileExt = path.extname(baseFileName);
  const fileNameWithoutExt = path.basename(baseFileName, fileExt);
  const uniqueFileName = `${fileNameWithoutExt}-${uniqueId}${fileExt}`;
  
  const filePath = path.join(__dirname, '..', 'fixtures', uniqueFileName);
  const dirPath = path.dirname(filePath);

  // Create directory if it doesn't exist
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  // Generate file with appropriate size and type
  const sizeInBytes = sizeInMB * 1024 * 1024;

  if (type.includes('image')) {
    // Create a simple PNG file
    const buffer = Buffer.alloc(sizeInBytes, 0);
    // PNG header
    buffer.write('\x89PNG\r\n\x1A\n', 0);
    // Add some data to make it a valid PNG
    buffer.write('IHDR', 8);
    fs.writeFileSync(filePath, buffer);
  } else if (baseFileName.endsWith('.pdf')) {
    // Create a simple PDF file
    const buffer = Buffer.alloc(sizeInBytes, 0);
    // PDF header
    buffer.write('%PDF-1.5', 0);
    // EOF marker - ensure we use Math.floor to get an integer offset
    const eofOffset = Math.max(0, Math.floor(sizeInBytes) - 5);
    buffer.write('%%EOF', eofOffset);
    fs.writeFileSync(filePath, buffer);
  } else {
    // Create a generic file
    const buffer = Buffer.alloc(sizeInBytes, 0);
    fs.writeFileSync(filePath, buffer);
  }

  return { filePath, fileName: uniqueFileName };
}

// Helper to clean up test files for a specific test run
async function cleanUpTestFiles(uniqueId) {
  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  if (!fs.existsSync(fixturesDir)) {
    return;
  }
  
  const files = fs.readdirSync(fixturesDir);
  
  // Only clean up files specific to this test run (with the unique ID)
  const filesToCleanup = files.filter(file => file.includes(`-${uniqueId}`));
  
  for (const file of filesToCleanup) {
    const filePath = path.join(fixturesDir, file);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

test.describe('File Attachment Tests', () => {
  // Create a unique ID for this test run to avoid conflicts in parallel execution
  const testRunUniqueId = crypto.randomUUID().substring(0, 8);
  
  // Per-test fixture to hold recipient info for this specific test run
  let testRecipient = {
    username: null,
    context: null
  };
  
  // File paths for this test run
  let testFiles = {
    image: null,
    pdf: null,
    large: null,
    invalid: null
  };
  
  // Create test files and recipient user before all tests
  test.beforeAll(async ({ browser, browserName }) => {
    // Create test files with unique names for this test run
    const imageResult = await createTestFile('test-image.png', 0.5, 'image/png', testRunUniqueId);
    const pdfResult = await createTestFile('test-pdf.pdf', 0.5, 'application/pdf', testRunUniqueId);
    const largeResult = await createTestFile('test-large.png', 11, 'image/png', testRunUniqueId); // Over the 10MB limit
    const invalidResult = await createTestFile('test-invalid.xyz', 0.1, 'application/octet-stream', testRunUniqueId);
    
    // Store file info for this test run
    testFiles.image = imageResult;
    testFiles.pdf = pdfResult;
    testFiles.large = largeResult;
    testFiles.invalid = invalidResult;

    // Create downloads directory if it doesn't exist
    const downloadsDir = path.join(__dirname, '..', 'test-results', 'downloads', testRunUniqueId);
    if (!fs.existsSync(downloadsDir)) {
      fs.mkdirSync(downloadsDir, { recursive: true });
    }

    // Create a unique recipient user for this test run
    // Note: The sender user is automatically created and signed in by the newUserFixture for each test
    testRecipient.context = await browser.newContext();
    const recipientPage = await testRecipient.context.newPage();
    const recipientName = generateUsername(browserName);

    await createAndSignInUser(recipientPage, recipientName);
    testRecipient.username = recipientName;
    await recipientPage.close();
  });

  test.afterAll(async () => {
    // Clean up files specific to this test run
    await cleanUpTestFiles(testRunUniqueId);
    
    // Clean up the downloads folder for this test run
    const downloadsDir = path.join(__dirname, '..', 'test-results', 'downloads', testRunUniqueId);
    if (fs.existsSync(downloadsDir)) {
      try {
        const files = fs.readdirSync(downloadsDir);
        for (const file of files) {
          fs.unlinkSync(path.join(downloadsDir, file));
        }
        fs.rmdirSync(downloadsDir);
      } catch (error) {
        console.error(`Failed to clean up downloads dir: ${error}`);
      }
    }
    
    // Close the browser context
    if (testRecipient.context) {
      await testRecipient.context.close();
    }
  });


  [
    { name: 'image attachment', fileKey: 'image' },
    { name: 'PDF attachment', fileKey: 'pdf' }
  ].forEach(testCase => {
    test(`should upload and preview a valid ${testCase.name}`, async ({ page, username }) => {
      const recipient = testRecipient.username;
      const fileInfo = testFiles[testCase.fileKey];
      const fileName = fileInfo.fileName;
      const testFilePath = fileInfo.filePath;

      // Open New Chat
      await page.click('#newChatButton');
      await expect(page.locator('#newChatModal')).toBeVisible();
      await page.fill('#chatRecipient', recipient);
      await page.waitForTimeout(3_000);
      await expect(page.locator('#chatRecipientError')).toHaveText('found', { timeout: 10_000 });
      const continueBtn = page.locator('#newChatForm button[type="submit"]');
      await expect(continueBtn).toBeEnabled();
      await continueBtn.click();

      // Ensure we're in the chat modal
      await expect(page.locator('#chatModal')).toBeVisible();

      // Set the file input for upload
      const fileInput = page.locator('#chatFileInput');
      await fileInput.setInputFiles(testFilePath);

      // Verify attachment preview appears
      await expect(page.locator('#attachmentPreview .attachment-name', { hasText: fileName })).toBeVisible();

      // Send message with attachment
      await page.click('#handleSendMessage');
      // If an error toast appears, fail fast
      if (await page.locator('.toast.error.show').count()) {
        const errText = await page.locator('.toast.error.show').textContent();
        throw new Error(`Error toast displayed after sending message: ${errText}`);
      }

      // Verify message with attachment was sent
      const attachmentLink = page.locator('.message.sent .attachment-label');
      await expect(attachmentLink).toBeVisible({ timeout: 15000 });
      await expect(attachmentLink).toHaveText(fileName);
    });
  });

  test('should show error for file over size limit', async ({ page, username }) => {
    const recipient = testRecipient.username;
    const fileInfo = testFiles.large;
    const testFilePath = fileInfo.filePath;

    // Open New Chat
    await page.click('#newChatButton');
    await expect(page.locator('#newChatModal')).toBeVisible();
    await page.fill('#chatRecipient', recipient);
    await page.waitForTimeout(3_000);
    const recipientStatus = await page.locator('#chatRecipientError').textContent().catch(() => '');
    expect(recipientStatus).toBe('found');
    const continueBtn = page.locator('#newChatForm button[type="submit"]');
    await expect(continueBtn).toBeEnabled();
    await continueBtn.click();

    // Ensure we're in the chat modal
    await expect(page.locator('#chatModal')).toBeVisible();

    // Set the file input for upload
    const fileInput = page.locator('#chatFileInput');
    await fileInput.setInputFiles(testFilePath);

    // Verify error toast appears for file size limit
    await expect(page.locator('.toast.error.show')).toBeVisible({ timeout: 10_000 });
    const errorMsg = await page.locator('.toast.error.show').textContent();
    expect(errorMsg).toContain('File size too large');

    // Verify attachment preview does not appear
    await expect(page.locator('#attachmentPreview')).toHaveAttribute('style', 'display: none;');
  });

  test('should allow removing an attachment', async ({ page, username }) => {
    const recipient = testRecipient.username;
    const fileInfo = testFiles.image;
    const fileName = fileInfo.fileName;
    const testFilePath = fileInfo.filePath;

    // Open New Chat
    await page.click('#newChatButton');
    await expect(page.locator('#newChatModal')).toBeVisible();
    await page.fill('#chatRecipient', recipient);
    await page.waitForTimeout(3_000);
    const recipientStatus = await page.locator('#chatRecipientError').textContent().catch(() => '');
    expect(recipientStatus).toBe('found');
    const continueBtn = page.locator('#newChatForm button[type="submit"]');
    await expect(continueBtn).toBeEnabled();
    await continueBtn.click();

    // Ensure we're in the chat modal
    await expect(page.locator('#chatModal')).toBeVisible();

    // Set the file input for upload
    const fileInput = page.locator('#chatFileInput');
    await fileInput.setInputFiles(testFilePath);

    // Verify attachment preview appears
    await expect(page.locator('#attachmentPreview .attachment-name', { hasText: fileName })).toBeVisible();

    // Click remove attachment button
    await page.click('.remove-attachment');

    // Verify attachment preview is hidden
    await expect(page.locator('#attachmentPreview')).toHaveAttribute('style', 'display: none;');
  });

  test('should download own attachments', async ({ page, context, username }) => {
    const recipient = testRecipient.username;
    const fileInfo = testFiles.image;
    const fileName = fileInfo.fileName;
    const testFilePath = fileInfo.filePath;

    // Start waiting for download before clicking
    const downloadPromise = page.waitForEvent('download');

    // Open New Chat
    await page.click('#newChatButton');
    await expect(page.locator('#newChatModal')).toBeVisible();
    await page.fill('#chatRecipient', recipient);
    await page.waitForTimeout(3_000);
    await expect(page.locator('#chatRecipientError')).toHaveText('found', { timeout: 10_000 });
    const continueBtn = page.locator('#newChatForm button[type="submit"]');
    await expect(continueBtn).toBeEnabled();
    await continueBtn.click();

    // Ensure we're in the chat modal
    await expect(page.locator('#chatModal')).toBeVisible();

    // Set the file input for upload
    const fileInput = page.locator('#chatFileInput');
    await fileInput.setInputFiles(testFilePath);

    // Send message with attachment
    await page.click('#handleSendMessage');

    // If an error toast appears, fail fast
    if (await page.locator('.toast.error.show').count()) {
      const errText = await page.locator('.toast.error.show').textContent();
      throw new Error(`Error toast displayed after sending message: ${errText}`);
    }

    // Verify message with attachment was sent
    const attachmentLink = page.locator('.message.sent .attachment-label');
    await expect(attachmentLink).toBeVisible({ timeout: 15000 });
    await expect(attachmentLink).toHaveText(fileName);

    // Click the attachment link - should trigger download
    await attachmentLink.click();

    // Wait for the download to start
    const download = await downloadPromise;

    // Verify the downloaded file has the correct name
    expect(download.suggestedFilename()).toBe(fileName);
    
    // Use a unique path for this test run to avoid conflicts
    const downloadPath = path.join(__dirname, '..', 'test-results', 'downloads', testRunUniqueId, download.suggestedFilename());

    try {
      // Save the download to a temporary location and verify it exists
      await download.saveAs(downloadPath);

      // Verify the file was downloaded
      expect(fs.existsSync(downloadPath)).toBe(true);
      
      // Compare the original uploaded file with the downloaded file
      const originalFileBuffer = fs.readFileSync(testFilePath);
      const downloadedFileBuffer = fs.readFileSync(downloadPath);
      
      // Check if file sizes match
      expect(downloadedFileBuffer.length).toBe(originalFileBuffer.length);
      
      // Check if file contents match (byte by byte comparison)
      expect(downloadedFileBuffer.equals(originalFileBuffer)).toBe(true);
    } finally {
      // Clean up is handled in afterAll
    }
  });

  test('should verify recipient receives message and attachment and can download it', async ({ page, username, browser }) => {
    const sender = username;
    const recipient = testRecipient.username;
    const fileInfo = testFiles.image;
    const fileName = fileInfo.fileName;
    const testFilePath = fileInfo.filePath;
    const testMessage = 'Message with attachment for verification';

    // Send a message with attachment from sender
    await page.click('#newChatButton');
    await expect(page.locator('#newChatModal')).toBeVisible();
    await page.fill('#chatRecipient', recipient);
    await page.waitForTimeout(3_000);
    const recipientStatus = await page.locator('#chatRecipientError').textContent().catch(() => '');
    expect(recipientStatus).toBe('found');
    const continueBtn = page.locator('#newChatForm button[type="submit"]');
    await expect(continueBtn).toBeEnabled();
    await continueBtn.click();

    await expect(page.locator('#chatModal')).toBeVisible();

    // Set the file input for upload
    const fileInput = page.locator('#chatFileInput');
    await fileInput.setInputFiles(testFilePath);

    // Add text to message
    await page.fill('.message-input', testMessage);

    // Send message with attachment
    await page.click('#handleSendMessage');
    // If an error toast appears, fail fast
    if (await page.locator('.toast.error.show').count()) {
      const errText = await page.locator('.toast.error.show').textContent();
      throw new Error(`Error toast displayed after sending message: ${errText}`);
    }

    // Verify message was sent
    await expect(page.locator('.message.sent .attachment-label', { hasText: fileName })).toBeVisible({ timeout: 15000 });

    // Reuse the recipient context that was created in beforeAll
    const recipientPage = await testRecipient.context.newPage();

    try {
      // Start waiting for download before clicking
      const downloadPromise = recipientPage.waitForEvent('download');
      
      // Sign in as recipient
      await recipientPage.goto('');
      await recipientPage.locator('#signInButton').click();

      // Check that recipient has a chat notification from sender
      await expect(recipientPage.locator('#chatsScreen.active')).toBeVisible({ timeout: 15000 });
      const chatItem = recipientPage.locator('.chat-name', { hasText: sender });
      await expect(chatItem).toBeVisible({ timeout: 15000 });

      // Open the chat
      await chatItem.click();
      await expect(recipientPage.locator('#chatModal')).toBeVisible();

      // Verify recipient received both the message text and attachment
      await expect(recipientPage.locator('.message.received .message-content', { hasText: testMessage })).toBeVisible({ timeout: 15000 });
      const recipientAttachmentLink = recipientPage.locator('.message.received .attachment-label', { hasText: fileName });
      await expect(recipientAttachmentLink).toBeVisible({ timeout: 15000 });
      
      // Click on the attachment link to download it
      await recipientAttachmentLink.click();
      
      // Wait for the download to start
      const download = await downloadPromise;
      
      // Verify the downloaded file has the correct name
      expect(download.suggestedFilename()).toBe(fileName);
      
      // Use a unique path for this test run to avoid conflicts
      const downloadPath = path.join(__dirname, '..', 'test-results', 'downloads', testRunUniqueId, `recipient-${download.suggestedFilename()}`);
      
      try {
        // Save the download to a temporary location and verify it exists
        await download.saveAs(downloadPath);
        
        // Verify the file was downloaded
        expect(fs.existsSync(downloadPath)).toBe(true);
        
        // Compare the original uploaded file with the downloaded file
        const originalFileBuffer = fs.readFileSync(testFilePath);
        const downloadedFileBuffer = fs.readFileSync(downloadPath);
        
        // Check if file sizes match
        expect(downloadedFileBuffer.length).toBe(originalFileBuffer.length);
        
        // Check if file contents match (byte by byte comparison)
        expect(downloadedFileBuffer.equals(originalFileBuffer)).toBe(true);
      } finally {
        // Clean up is handled in afterAll
      }
    } finally {
      await recipientPage.close();
    }
  });

  test('should send and download multiple attachments', async ({ page, username, browser }) => {
    const sender = username;
    const recipient = testRecipient.username;
    const testMessage = 'Message with multiple attachments';
    
    // Define multiple attachments to test with
    const attachmentTypes = [
      { baseName: 'test-image-1.png', type: 'image/png' },
      { baseName: 'test-image-2.png', type: 'image/png' },
      { baseName: 'test-pdf-1.pdf', type: 'application/pdf' },
      { baseName: 'test-pdf-2.pdf', type: 'application/pdf' },
      { baseName: 'test-image-3.png', type: 'image/png' }
    ];
    
    // Create all the test files with unique names
    const attachments = [];
    for (const attachment of attachmentTypes) {
      const result = await createTestFile(attachment.baseName, 0.2, attachment.type, `${testRunUniqueId}-multi`);
      attachments.push({
        filePath: result.filePath,
        fileName: result.fileName,
        type: attachment.type
      });
    }
        
    // STEP 1: SENDER SENDS MULTIPLE ATTACHMENTS
    // Open New Chat
    await page.click('#newChatButton');
    await expect(page.locator('#newChatModal')).toBeVisible();
    await page.fill('#chatRecipient', recipient);
    await page.waitForTimeout(3_000);
    await expect(page.locator('#chatRecipientError')).toHaveText('found', { timeout: 10_000 });
    const continueBtn = page.locator('#newChatForm button[type="submit"]');
    await expect(continueBtn).toBeEnabled();
    await continueBtn.click();
    
    // Ensure we're in the chat modal
    await expect(page.locator('#chatModal')).toBeVisible();
    
    // Add all files one by one
    for (let i = 0; i < attachments.length; i++) {
      const attachment = attachments[i];
      
      // Set the file input for upload
      const fileInput = page.locator('#chatFileInput');
      await fileInput.setInputFiles(attachment.filePath);
      
      // Verify attachment preview appears for each file
      await expect(page.locator('#attachmentPreview .attachment-name', { hasText: attachment.fileName })).toBeVisible();
      
      // Add text to message if it's the last attachment
      if (i === attachments.length - 1) {
        await page.fill('.message-input', testMessage);
      }
    }
    
    // Send message with all attachments
    await page.click('#handleSendMessage');
    // If an error toast appears, fail fast
    if (await page.locator('.toast.error.show').count()) {
      const errText = await page.locator('.toast.error.show').textContent();
      throw new Error(`Error toast displayed after sending message: ${errText}`);
    }
    
    // Verify messages with attachments were sent
    for (const attachment of attachments) {
      const attachmentLink = page.locator('.message.sent .attachment-label', { hasText: attachment.fileName });
      await expect(attachmentLink).toBeVisible({ timeout: 15000 });
    }
    
    // STEP 2: RECIPIENT RECEIVES AND DOWNLOADS ALL ATTACHMENTS
    const recipientPage = await testRecipient.context.newPage();
    
    try {
      // Sign in as recipient
      await recipientPage.goto('');
      await recipientPage.locator('#signInButton').click();
      
      // Check that recipient has a chat notification from sender
      await expect(recipientPage.locator('#chatsScreen.active')).toBeVisible({ timeout: 15000 });
      const chatItem = recipientPage.locator('.chat-name', { hasText: sender });
      await expect(chatItem).toBeVisible({ timeout: 15000 });
      
      // Open the chat
      await chatItem.click();
      await expect(recipientPage.locator('#chatModal')).toBeVisible();
      
      // Verify recipient received the message text
      await expect(recipientPage.locator('.message.received .message-content', { hasText: testMessage })).toBeVisible({ timeout: 15000 });
      
      // Verify and download each attachment
      for (const attachment of attachments) {        
        // Verify the attachment link is visible
        const attachmentLink = recipientPage.locator('.message.received .attachment-label', { hasText: attachment.fileName });
        await expect(attachmentLink).toBeVisible({ timeout: 15000 });
        
        // Set up download listener for this specific attachment
        const downloadPromise = recipientPage.waitForEvent('download');
        
        // Click to download
        await attachmentLink.click();
        
        // Wait for download to start
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toBe(attachment.fileName);
        
        // Define path for the downloaded file with unique ID to avoid conflicts
        const downloadPath = path.join(__dirname, '..', 'test-results', 'downloads', testRunUniqueId, `multi-${download.suggestedFilename()}`);
        
        // Save the download
        await download.saveAs(downloadPath);
        
        // Verify file was downloaded
        expect(fs.existsSync(downloadPath)).toBe(true);
        
        // Compare files
        const originalFileBuffer = fs.readFileSync(attachment.filePath);
        const downloadedFileBuffer = fs.readFileSync(downloadPath);
        
        // Check file sizes
        expect(downloadedFileBuffer.length).toBe(originalFileBuffer.length);
        
        // Byte-by-byte comparison
        expect(downloadedFileBuffer.equals(originalFileBuffer)).toBe(true);
      }
    } finally {
      // Close recipient page
      await recipientPage.close();
      
      // Clean up is handled in afterAll
    }
  });
});
