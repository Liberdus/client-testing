const { test: base, expect } = require('../fixtures/base');
const { createAndSignInUser, generateUsername } = require('../helpers/userHelpers');
const { newContext } = require('../helpers/toastHelpers');



// script injected into the sender context so getUserMedia({audio:true}) returns a real MediaStream
function mockMicInitScript() {
    (function () {
        const OriginalGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints) => {
            if (constraints && constraints.audio) {
                const AudioCtx = window.AudioContext || window.webkitAudioContext;
                const ctx = new AudioCtx();
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                gain.gain.value = 0.15;       // quiet test tone
                osc.type = 'sine';
                osc.frequency.value = 440;    // A4
                const dest = ctx.createMediaStreamDestination();
                osc.connect(gain).connect(dest);
                osc.start();

                const stream = dest.stream;
                // Make stop() clean up properly so subsequent tests don’t leak audio contexts
                for (const track of stream.getTracks()) {
                    const origStop = track.stop.bind(track);
                    track.stop = () => { try { osc.stop(); } catch { } ctx.close(); origStop(); };
                }
                return stream;
            }
            return OriginalGUM(constraints);
        };
    })();
}

// instrumentWebAudio sets up hooks to analyze audio output in the page context
function instrumentWebAudio() {
    (function () {
        const contexts = [];
        let sharedCtx = null;

        const ensureSharedCtx = async () => {
            if (sharedCtx) return sharedCtx;
            const AC = window.AudioContext || window.webkitAudioContext;
            sharedCtx = new AC();
            const analyser = sharedCtx.createAnalyser();
            analyser.fftSize = 4096;               // finer bins (~10–12 Hz)
            analyser.smoothingTimeConstant = 0;    // no averaging
            analyser.minDecibels = -100;
            sharedCtx.__pwAnalyser = analyser;
            try { await sharedCtx.resume(); } catch { }
            return sharedCtx;
        };

        // Patch AudioContext so any node->destination also tees to its analyser
        function wrapAC(name) {
            const Orig = window[name];
            if (!Orig) return;
            function PatchedAC(...args) {
                const ctx = new Orig(...args);
                const analyser = ctx.createAnalyser();
                analyser.fftSize = 4096;
                analyser.smoothingTimeConstant = 0;
                analyser.minDecibels = -100;
                ctx.__pwAnalyser = analyser;
                contexts.push(ctx);

                if (!window.__pwConnectPatched) {
                    const originalConnect = AudioNode.prototype.connect;
                    AudioNode.prototype.connect = function (...args) {
                        const out = originalConnect.apply(this, args);
                        try {
                            const dest = args[0];
                            if (dest === this.context.destination && this.context.__pwAnalyser) {
                                originalConnect.call(this, this.context.__pwAnalyser); // tee
                            }
                        } catch { }
                        return out;
                    };
                    window.__pwConnectPatched = true;
                }
                return ctx;
            }
            PatchedAC.prototype = Orig.prototype;
            window[name] = PatchedAC;
        }
        wrapAC('AudioContext'); wrapAC('webkitAudioContext');

        // Also hook HTMLMediaElement so decrypted <audio> is analyzed
        try {
            const origPlay = HTMLMediaElement.prototype.play;
            HTMLMediaElement.prototype.play = async function (...args) {
                try {
                    if (!this.__pwWired) {
                        const ctx = await ensureSharedCtx();
                        try { await ctx.resume(); } catch { }
                        const src = ctx.createMediaElementSource(this);
                        src.connect(ctx.__pwAnalyser);   // analyser only; don’t double output
                        this.__pwWired = true;
                    }
                } catch { }
                return origPlay.apply(this, args);
            };
        } catch { }

        // Page-side helper the test will poll
        window.__pwGetDominantFrequency = () => {
            const read = (an, sr, fftSize) => {
                const data = new Float32Array(an.frequencyBinCount);
                an.getFloatFrequencyData(data);
                let maxI = -1, maxV = -Infinity;
                for (let i = 0; i < data.length; i++) if (data[i] > maxV) { maxV = data[i]; maxI = i; }
                return maxI >= 0 ? (maxI * sr / fftSize) : null;
            };

            const freqs = [];
            for (const ctx of contexts) {
                if (ctx.__pwAnalyser) {
                    const f = read(ctx.__pwAnalyser, ctx.sampleRate, ctx.__pwAnalyser.fftSize);
                    if (f) freqs.push(f);
                }
            }
            if (sharedCtx && sharedCtx.__pwAnalyser) {
                const f = read(sharedCtx.__pwAnalyser, sharedCtx.sampleRate, sharedCtx.__pwAnalyser.fftSize);
                if (f) freqs.push(f);
            }
            if (!freqs.length) return null;
            freqs.sort((a, b) => a - b);
            return freqs[Math.floor(freqs.length / 2)];
        };
    })();
}


const test = base.extend({
    messageUsers: async ({ browser, browserName }, use) => {
        // Create two contexts first
        const ctx1 = await newContext(browser); // sender (will have fake mic)
        const ctx2 = await newContext(browser); // receiver

        // Grant mic permission (harmless even with our override; keeps UI flows happy)
        await ctx1.grantPermissions(['microphone']);
        await ctx2.grantPermissions(['microphone']);

        // Important: inject fake mic BEFORE creating pages so it applies to new tabs
        await ctx1.addInitScript(mockMicInitScript);
        await ctx2.addInitScript(instrumentWebAudio);

        // Pages
        const pg1 = await ctx1.newPage();
        const pg2 = await ctx2.newPage();

        const user1 = generateUsername(browserName);
        const user2 = generateUsername(browserName);
        await Promise.all([
            createAndSignInUser(pg1, user1),
            createAndSignInUser(pg2, user2),
        ]);

        await use({
            users: {
                user1: { username: user1, context: ctx1, page: pg1 },
                user2: { username: user2, context: ctx2, page: pg2 },
            },
        });

        await ctx1.close();
        await ctx2.close();
    },
});

test.describe('Voice Message Tests', () => {
    test('record and send voice message', async ({ messageUsers }) => {
        const { users: { user1, user2 } } = messageUsers;

        // Open chat: user1 -> user2
        await user1.page.click('#switchToChats');
        await expect(user1.page.locator('#newChatButton')).toBeVisible();
        await user1.page.click('#newChatButton');
        await expect(user1.page.locator('#newChatModal')).toBeVisible();
        await user1.page.locator('#chatRecipient').pressSequentially(user2.username);
        await expect(user1.page.locator('#chatRecipientError')).toHaveText('found', { timeout: 10_000 });
        await user1.page.locator('#newChatForm button[type="submit"]').click();
        await expect(user1.page.locator('#chatModal')).toBeVisible();

        // Click voice record button to open modal
        await expect(user1.page.locator('#voiceRecordButton')).toBeVisible({ timeout: 10_000 });
        await user1.page.click('#voiceRecordButton');

        // Expect the voice recording modal
        await expect(user1.page.locator('#voiceRecordingModal')).toBeVisible({ timeout: 10_000 });

        // Start recording
        await expect(user1.page.locator('#startRecordingButton')).toBeVisible();
        await user1.page.click('#startRecordingButton');

        // Wait a short time to emulate recording duration
        await user1.page.waitForTimeout(1200);

        // Stop recording
        await expect(user1.page.locator('#stopRecordingButton')).toBeVisible({ timeout: 5000 });
        await user1.page.click('#stopRecordingButton');

        // After stopping, 'Send' button should be visible
        await expect(user1.page.locator('#sendVoiceMessageButton')).toBeVisible({ timeout: 5000 });
        await user1.page.click('#sendVoiceMessageButton');

        // Close the modal if it's still open
        await user1.page.click('#closeChatModal').catch(() => { });

        // Verify recipient received a voice message
        await user2.page.click('#switchToChats');
        const chatItem = user2.page.locator('.chat-name', { hasText: user1.username });
        await expect(chatItem).toBeVisible({ timeout: 30_000 });
        await chatItem.click();
        await expect(user2.page.locator('#chatModal')).toBeVisible();

        // Wait for the voice message element to appear
        const voiceMsg = user2.page.locator('#chatModal .messages-list .message.received .voice-message');
        await expect(voiceMsg).toBeVisible({ timeout: 30_000 });

        // Check that voice-message has playback button and time display
        const playBtn = voiceMsg.locator('.voice-message-play-button');
        const timeDisplay = voiceMsg.locator('.voice-message-time-display');
        await expect(playBtn).toBeVisible();
        await expect(timeDisplay).toBeVisible();

        await playBtn.click();

        // poll the page helper until we read a tone
        async function waitForFreqInRange(page, lo, hi, timeoutMs = 8000) {
            const t0 = Date.now();
            while (Date.now() - t0 < timeoutMs) {
                const f = await page.evaluate(() => window.__pwGetDominantFrequency && window.__pwGetDominantFrequency());
                if (typeof f === 'number' && f >= lo && f <= hi) return f;
                await page.waitForTimeout(100);
            }
            throw new Error('Dominant frequency did not fall in range in time');
        }

        // 440 Hz expected; allow for bin width & codec drift
        const freq = await waitForFreqInRange(user2.page, 400, 500);
        expect(freq).toBeGreaterThan(430);
        expect(freq).toBeLessThan(450);
    });
});
