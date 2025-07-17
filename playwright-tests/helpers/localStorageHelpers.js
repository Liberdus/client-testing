// Helpers for inspecting localStorage for Liberdus client tests

/**
 * Get localStorage data from a page
 * @param {Page} page - The Playwright page object
 * @returns {Promise<Object>} - The localStorage object
 */
async function getLocalStorage(page) {
    return await page.evaluate(() => ({ ...window.localStorage }));
}

/**
 * Get the netid for a username from the accounts object in localStorage
 * @param {Object} localStorageObj - The localStorage object
 * @param {string} username - The username to look up
 * @returns {string} - The netid for the username
 */
function getNetidFromAccounts(localStorageObj, username) {
    const accounts = JSON.parse(localStorageObj.accounts);
    for (const netid of Object.keys(accounts.netids)) {
        if (
            accounts.netids[netid] &&
            accounts.netids[netid].usernames &&
            Object.keys(accounts.netids[netid].usernames).includes(username)
        ) {
            return netid;
        }
    }
    throw new Error('Could not find netid for username in accounts');
}

/**
 * Get user data from localStorage for a specific user
 * @param {Object} localStorageObj - The localStorage object
 * @param {string} username - The username to get data for
 * @returns {Object} - The parsed user data object
 */
function getUserData(localStorageObj, username) {
    const netid = getNetidFromAccounts(localStorageObj, username);
    const key = `${username}_${netid}`;
    const value = localStorageObj[key];
    if (!value) throw new Error(`No localStorage entry for key ${key}`);
    try {
        return JSON.parse(value);
    } catch (e) {
        throw new Error(`Could not parse localStorage value for key ${key}`);
    }
}

/**
 * Get the chats array for a user
 * @param {Object} localStorageObj - The localStorage object
 * @param {string} username - The username to get chats for
 * @returns {Array} - The chats array for the user (empty array if no chats)
 */
function getUserChats(localStorageObj, username) {
    const userData = getUserData(localStorageObj, username);
    return (userData.account && Array.isArray(userData.account.chats)) 
        ? userData.account.chats 
        : [];
}

/**
 * Get all messages from all contacts for a user
 * @param {Object} localStorageObj - The localStorage object
 * @param {string} username - The username to get messages for
 * @returns {Object} - Object containing contact addresses and their messages
 */
function getUserContactMessages(localStorageObj, username) {
    const userData = getUserData(localStorageObj, username);
    if (!userData.account || !userData.account.contacts) {
        return {};
    }
    
    // Extract all contacts that have messages
    const contactMessages = {};
    for (const [address, contactData] of Object.entries(userData.account.contacts)) {
        if (contactData.messages && Array.isArray(contactData.messages) && contactData.messages.length > 0) {
            contactMessages[address] = {
                username: contactData.username,
                messages: contactData.messages
            };
        }
    }
    
    return contactMessages;
}

/**
 * Count all messages across all contacts for a user
 * @param {Object} localStorageObj - The localStorage object
 * @param {string} username - The username to count messages for
 * @returns {number} - Total number of messages across all contacts
 */
function countUserMessages(localStorageObj, username) {
    const contacts = getUserContactMessages(localStorageObj, username);
    let totalMessages = 0;
    
    Object.values(contacts).forEach(contact => {
        totalMessages += contact.messages.length;
    });
    
    return totalMessages;
}

/**
 * Find a contact by username
 * @param {Object} localStorageObj - The localStorage object
 * @param {string} ownerUsername - The username of the user whose contacts to search
 * @param {string} contactUsername - The username of the contact to find
 * @returns {Object|null} - The contact data or null if not found
 */
function findContactByUsername(localStorageObj, ownerUsername, contactUsername) {
    const userData = getUserData(localStorageObj, ownerUsername);
    if (!userData.contacts ) {
        return null;
    }
    
    for (const contactData of Object.values(userData.contacts)) {
        if (contactData.username === contactUsername) {
            return contactData;
        }
    }
    
    return null;
}

/**
 * Get messages between two users
 * @param {Object} localStorageObj - The localStorage object
 * @param {string} ownerUsername - The username of the user whose localStorage we're checking
 * @param {string} contactUsername - The username of the contact whose messages we want
 * @returns {Array} - Array of messages between the users or empty array if none found
 */
function getMessagesBetweenUsers(localStorageObj, ownerUsername, contactUsername) {
    const contact = findContactByUsername(localStorageObj, ownerUsername, contactUsername);
    
    if (contact && contact.messages && Array.isArray(contact.messages)) {
        return contact.messages;
    }
    
    return [];
}

module.exports = {
    getLocalStorage,
    getNetidFromAccounts,
    getUserData,
    getUserChats,
    getUserContactMessages,
    countUserMessages,
    findContactByUsername,
    getMessagesBetweenUsers
};