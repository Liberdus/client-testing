const { test, expect } = require('../fixtures/newUserFixture');
const { createAndSignInUser, generateUsername } = require('../helpers/userHelpers');
const fs = require('fs');
const path = require('path');

// RECIPIENT will store the username of the user who will receive messages
let RECIPIENT;
// Store the browser context for the recipient user
let RECIPIENT_CONTEXT;
// SENDER is automatically created and signed in by the newUserFixture

// Helper to create test files
async function createTestFile(fileName, sizeInMB = 0.5, type = 'image/png') {
  const filePath = path.join(__dirname, '..', 'fixtures', fileName);
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
  } else if (fileName.endsWith('.pdf')) {
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

  return filePath;
}

// Helper to clean up test files
async function cleanUpTestFiles() {
  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  const filesToCleanup = [
    'test-image.png',
    'test-pdf.pdf',
    'test-large.png',
    'test-invalid.xyz',
    // Add multi-attachment test files
    'test-image-1.png',
    'test-image-2.png',
    'test-image-3.png',
    'test-pdf-1.pdf',
    'test-pdf-2.pdf'
  ];

  for (const file of filesToCleanup) {
    const filePath = path.join(fixturesDir, file);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

test.describe('File Attachment Tests', () => {
  // Create test files and recipient user before all tests
  test.beforeAll(async ({ browser, browserName }) => {
    // Create test files
    await createTestFile('test-image.png', 0.5, 'image/png');
    await createTestFile('test-pdf.pdf', 0.5, 'application/pdf');
    await createTestFile('test-large.png', 11, 'image/png'); // Over the 10MB limit
    await createTestFile('test-invalid.xyz', 0.1);

    // Create downloads directory if it doesn't exist
    const downloadsDir = path.join(__dirname, '..', 'test-results', 'downloads');
    if (!fs.existsSync(downloadsDir)) {
      fs.mkdirSync(downloadsDir, { recursive: true });
    }

    // Create recipient user
    // Note: The sender user is automatically created and signed in by the newUserFixture for each test
    RECIPIENT_CONTEXT = await browser.newContext();
    const recipientPage = await RECIPIENT_CONTEXT.newPage();
    const recipientName = generateUsername(browserName);

    await createAndSignInUser(recipientPage, recipientName);
    RECIPIENT = recipientName;
    await recipientPage.close();
  });

  test.afterAll(async () => {
    await cleanUpTestFiles();
    if (RECIPIENT_CONTEXT) {
      await RECIPIENT_CONTEXT.close();
    }
  });


  [
    { name: 'image attachment', fileName: 'test-image.png' },
    { name: 'PDF attachment', fileName: 'test-pdf.pdf' }
  ].forEach(testCase => {
    test(`should upload and preview a valid ${testCase.name}`, async ({ page, username }) => {
      const recipient = RECIPIENT;
      const fileName = testCase.fileName;

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
      const testFilePath = path.join(__dirname, '..', 'fixtures', fileName);
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
      const attachmentLink = page.locator('.message.sent .attachment-link');
      await expect(attachmentLink).toBeVisible({ timeout: 15000 });
      await expect(attachmentLink).toHaveText(fileName);
    });
  });

  test('should show error for file over size limit', async ({ page, username }) => {
    const recipient = RECIPIENT;

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
    const testFilePath = path.join(__dirname, '..', 'fixtures', 'test-large.png');
    await fileInput.setInputFiles(testFilePath);

    // Verify error toast appears for file size limit
    await expect(page.locator('.toast.error.show')).toBeVisible({ timeout: 10_000 });
    const errorMsg = await page.locator('.toast.error.show').textContent();
    expect(errorMsg).toContain('File size too large');

    // Verify attachment preview does not appear
    await expect(page.locator('#attachmentPreview')).toHaveAttribute('style', 'display: none;');
  });

  test('should show error for invalid file type', async ({ page, username }) => {
    const recipient = RECIPIENT;

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

    // Set the file input for upload with an invalid file type
    const fileInput = page.locator('#chatFileInput');
    const testFilePath = path.join(__dirname, '..', 'fixtures', 'test-invalid.xyz');
    await fileInput.setInputFiles(testFilePath);

    // Verify error toast appears for invalid file type
    await expect(page.locator('.toast.error.show')).toBeVisible({ timeout: 10_000 });
    const errorMsg = await page.locator('.toast.error.show').textContent();
    expect(errorMsg).toContain('File type not supported');

    // Verify attachment preview does not appear
    await expect(page.locator('#attachmentPreview')).toHaveAttribute('style', 'display: none;');
  });

  test('should allow removing an attachment', async ({ page, username }) => {
    const recipient = RECIPIENT;

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
    const testFilePath = path.join(__dirname, '..', 'fixtures', 'test-image.png');
    await fileInput.setInputFiles(testFilePath);

    // Verify attachment preview appears
    const attachmentLink = page.locator('.message.sent .attachment-link');
    await expect(attachmentLink).toBeVisible({ timeout: 15000 });
    await expect(attachmentLink).toHaveText(fileName);

    // Click remove attachment button
    await page.click('.remove-attachment');

    // Verify attachment preview is hidden
    await expect(page.locator('#attachmentPreview')).toHaveAttribute('style', 'display: none;');
  });

  test('should download own attachments', async ({ page, context, username }) => {
    const recipient = RECIPIENT;
    const fileName = 'test-image.png';

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
    const testFilePath = path.join(__dirname, '..', 'fixtures', fileName);
    await fileInput.setInputFiles(testFilePath);

    // Send message with attachment
    await page.click('#handleSendMessage');

    // If an error toast appears, fail fast
    if (await page.locator('.toast.error.show').count()) {
      const errText = await page.locator('.toast.error.show').textContent();
      throw new Error(`Error toast displayed after sending message: ${errText}`);
    }

    // Verify message with attachment was sent
    const attachmentLink = page.locator('.message.sent .attachment-link');
    await expect(attachmentLink).toBeVisible({ timeout: 15000 });
    await expect(attachmentLink).toHaveText(fileName);

    // Click the attachment link - should trigger download
    await attachmentLink.click();

    // Wait for the download to start
    const download = await downloadPromise;

    // Verify the downloaded file has the correct name
    expect(download.suggestedFilename()).toBe(fileName);
    const downloadPath = path.join(__dirname, '..', 'test-results', 'downloads', download.suggestedFilename());

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
      // Clean up downloaded file
      if (fs.existsSync(downloadPath)) {
        fs.unlinkSync(downloadPath);
      }
    }
  });

  test('should verify recipient receives message and attachment and can download it', async ({ page, username, browser }) => {
    const sender = username;
    const recipient = RECIPIENT;
    const testMessage = 'Message with attachment for verification';
    const fileName = 'test-image.png';
    const originalFilePath = path.join(__dirname, '..', 'fixtures', fileName);

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
    await fileInput.setInputFiles(originalFilePath);

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
    await expect(page.locator('.message.sent .attachment-link', { hasText: fileName })).toBeVisible({ timeout: 15000 });

    // Reuse the recipient context that was created in beforeAll
    const recipientPage = await RECIPIENT_CONTEXT.newPage();

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
      const recipientAttachmentLink = recipientPage.locator('.message.received .attachment-link', { hasText: fileName });
      await expect(recipientAttachmentLink).toBeVisible({ timeout: 15000 });
      
      // Click on the attachment link to download it
      await recipientAttachmentLink.click();
      
      // Wait for the download to start
      const download = await downloadPromise;
      
      // Verify the downloaded file has the correct name
      expect(download.suggestedFilename()).toBe(fileName);
      
      // Save the download to a temporary location
      const downloadPath = path.join(__dirname, '..', 'test-results', 'downloads', `recipient-${download.suggestedFilename()}`);
      
      try {
        // Save the download to a temporary location and verify it exists
        await download.saveAs(downloadPath);
        
        // Verify the file was downloaded
        expect(fs.existsSync(downloadPath)).toBe(true);
        
        // Compare the original uploaded file with the downloaded file
        const originalFileBuffer = fs.readFileSync(originalFilePath);
        const downloadedFileBuffer = fs.readFileSync(downloadPath);
        
        // Check if file sizes match
        expect(downloadedFileBuffer.length).toBe(originalFileBuffer.length);
        
        // Check if file contents match (byte by byte comparison)
        expect(downloadedFileBuffer.equals(originalFileBuffer)).toBe(true);
      } finally {
        // Clean up downloaded file
        if (fs.existsSync(downloadPath)) {
          fs.unlinkSync(downloadPath);
        }
      }
    } finally {
      await recipientPage.close();
    }
  });

  test('should send and download multiple attachments', async ({ page, username, browser }) => {
    const sender = username;
    const recipient = RECIPIENT;
    const testMessage = 'Message with multiple attachments';
    
    // Define multiple attachments to test with
    const attachments = [
      { name: 'test-image-1.png', type: 'image/png' },
      { name: 'test-image-2.png', type: 'image/png' },
      { name: 'test-pdf-1.pdf', type: 'application/pdf' },
      { name: 'test-pdf-2.pdf', type: 'application/pdf' },
      { name: 'test-image-3.png', type: 'image/png' }
    ];
    
    // Create all the test files
    const filePaths = [];
    for (const attachment of attachments) {
      const filePath = await createTestFile(attachment.name, 0.2, attachment.type);
      filePaths.push(filePath);
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
    for (const filePath of filePaths) {
      // Set the file input for upload
      const fileInput = page.locator('#chatFileInput');
      await fileInput.setInputFiles(filePath);
      
      // Verify attachment preview appears for each file
      const fileName = path.basename(filePath);
      await expect(page.locator('#attachmentPreview .attachment-name', { hasText: fileName })).toBeVisible();
      
      // Add text to message if it's the last attachment
      if (filePath === filePaths[filePaths.length - 1]) {
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
      const attachmentLink = page.locator('.message.sent .attachment-link', { hasText: attachment.name });
      await expect(attachmentLink).toBeVisible({ timeout: 15000 });
    }
    
    // STEP 2: RECIPIENT RECEIVES AND DOWNLOADS ALL ATTACHMENTS
    const recipientPage = await RECIPIENT_CONTEXT.newPage();
    const downloadedFiles = [];
    
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
        const attachmentLink = recipientPage.locator('.message.received .attachment-link', { hasText: attachment.name });
        await expect(attachmentLink).toBeVisible({ timeout: 15000 });
        
        // Set up download listener for this specific attachment
        const downloadPromise = recipientPage.waitForEvent('download');
        
        // Click to download
        await attachmentLink.click();
        
        // Wait for download to start
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toBe(attachment.name);
        
        // Define path for the downloaded file
        const downloadPath = path.join(__dirname, '..', 'test-results', 'downloads', `multi-${download.suggestedFilename()}`);
        downloadedFiles.push(downloadPath);
        
        // Save the download
        await download.saveAs(downloadPath);
        
        // Verify file was downloaded
        expect(fs.existsSync(downloadPath)).toBe(true);
        
        // Get original file for comparison
        const originalFilePath = path.join(__dirname, '..', 'fixtures', attachment.name);
        
        // Compare files
        const originalFileBuffer = fs.readFileSync(originalFilePath);
        const downloadedFileBuffer = fs.readFileSync(downloadPath);
        
        // Check file sizes
        expect(downloadedFileBuffer.length).toBe(originalFileBuffer.length);
        
        // Byte-by-byte comparison
        expect(downloadedFileBuffer.equals(originalFileBuffer)).toBe(true);
      }
    } finally {
      // Clean up downloaded files
      for (const filePath of downloadedFiles) {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
      
      // Close recipient page
      await recipientPage.close();
    }
  });
});
