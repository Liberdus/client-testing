import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
const classStart = appSource.indexOf('class CreateAccountModal');
const classEnd = appSource.indexOf('// Initialize the create account modal');
const classSource = appSource.slice(classStart, classEnd);
const context = {
  Event: class Event {
    constructor(type) { this.type = type; }
  },
};
const CreateAccountModal = vm.runInNewContext(`${classSource}; CreateAccountModal`, context);

function createModal() {
  const modal = new CreateAccountModal();
  modal.advancedSection = { open: false };
  modal.privateAccountCheckbox = { checked: false };
  modal.toggleButton = { checked: false };
  modal.privateKeySection = { hidden: true };
  modal.privateKeyInput = { type: 'password', value: '' };
  modal.privateKeyError = { style: { display: 'none' } };
  modal.togglePrivateKeyVisibility = {
    classList: { toggle: (name, isVisible) => { modal.visibilityState = isVisible; } },
    setAttribute: (name, value) => { modal[name] = value; },
  };
  return modal;
}

test('CreateAccount markup uses an Advanced disclosure and right-side controls', () => {
  const modalStart = indexSource.indexOf('id="createAccountModal"');
  const modalEnd = indexSource.indexOf('<!-- Update Warning Modal -->', modalStart);
  const modalHtml = indexSource.slice(modalStart, modalEnd);

  assert.match(modalHtml, /placeholder="Choose a username"/);
  assert.match(modalHtml, /This is how people find you, and it is permanent — a name cannot be changed once it is taken\./);
  assert.match(modalHtml, /<details class="create-account-advanced" id="advancedOptions">[^]*<summary[^]*Advanced[^]*create-account-chevron/s);
  assert.match(modalHtml, /Private account[^]*Can only message and pay other private accounts\. Cannot be changed later\./s);
  assert.match(modalHtml, /Use my own private key[^]*Otherwise one is generated for you\./s);
  assert.match(modalHtml, /id="privateAccountHelpButton"[^]*aria-label="About private accounts"/s);
  assert.doesNotMatch(modalHtml, /More Options|toggleMoreOptions/);

  const advancedEnd = modalHtml.indexOf('</details>');
  const submitAction = modalHtml.indexOf('class="form-actions create-account-actions"');
  assert.ok(submitAction > advancedEnd, 'submit should follow the complete Advanced section');
});

test('collapsing Advanced clears every hidden option', () => {
  const modal = createModal();
  modal.privateAccountCheckbox.checked = true;
  modal.toggleButton.checked = true;
  modal.privateKeySection.hidden = false;
  modal.privateKeyInput.type = 'text';
  modal.privateKeyInput.value = 'secret';
  modal.privateKeyError.style.display = 'inline';

  modal.handleAdvancedToggle();

  assert.equal(modal.privateAccountCheckbox.checked, false);
  assert.equal(modal.toggleButton.checked, false);
  assert.equal(modal.privateKeySection.hidden, true);
  assert.equal(modal.privateKeyInput.value, '');
  assert.equal(modal.privateKeyInput.type, 'password');
  assert.equal(modal.privateKeyError.style.display, 'none');
  assert.equal(modal.visibilityState, false);
  assert.equal(modal['aria-label'], 'Show private key');
  assert.equal(modal['aria-pressed'], 'false');
});

test('opening Advanced preserves its current option values', () => {
  const modal = createModal();
  modal.advancedSection.open = true;
  modal.privateAccountCheckbox.checked = true;
  modal.toggleButton.checked = true;
  modal.privateKeyInput.value = 'secret';

  modal.handleAdvancedToggle();

  assert.equal(modal.privateAccountCheckbox.checked, true);
  assert.equal(modal.toggleButton.checked, true);
  assert.equal(modal.privateKeyInput.value, 'secret');
});

test('the private-key option reveals in place and clears only when disabled', () => {
  const modal = createModal();
  modal.toggleButton.checked = true;
  modal.privateKeyInput.value = 'prefilled';

  modal.handleTogglePrivateKeyInput();
  assert.equal(modal.privateKeySection.hidden, false);
  assert.equal(modal.privateKeyInput.value, 'prefilled');

  modal.toggleButton.checked = false;
  modal.handleTogglePrivateKeyInput();
  assert.equal(modal.privateKeySection.hidden, true);
  assert.equal(modal.privateKeyInput.value, '');
});

test('recreate flow opens Advanced with the saved private key visible', () => {
  const modal = createModal();
  let opened = false;
  let dispatched;
  modal.usernameInput = {
    value: '',
    dispatchEvent: (event) => { dispatched = event.type; },
  };
  modal.open = () => { opened = true; };

  modal.openWithPrivateKey('alice', 'saved-key');

  assert.equal(modal.usernameInput.value, 'alice');
  assert.equal(modal.advancedSection.open, true);
  assert.equal(modal.toggleButton.checked, true);
  assert.equal(modal.privateKeySection.hidden, false);
  assert.equal(modal.privateKeyInput.value, 'saved-key');
  assert.equal(opened, true);
  assert.equal(dispatched, 'input');
});

test('Advanced styling provides chevron, focus, right alignment, and normal-flow submit', () => {
  assert.match(styles, /\.create-account-advanced > summary:focus-visible\s*{[^}]*box-shadow:\s*var\(--focus-ring-primary\)/s);
  assert.match(styles, /\.create-account-advanced\[open\] \.create-account-chevron\s*{[^}]*transform:/s);
  assert.match(styles, /\.create-account-option\s*{[^}]*display:\s*flex/s);
  assert.match(styles, /\.create-account-option-copy\s*{[^}]*flex:\s*1/s);
  assert.match(styles, /\.create-account-option-toggle\s*{[^}]*flex:\s*none/s);
  assert.match(styles, /\.create-account-option-toggle input:focus-visible \+ \.create-account-check\s*{[^}]*box-shadow:/s);
  assert.match(styles, /\.create-account-actions\s*{[^}]*margin-top:/s);
  assert.doesNotMatch(styles.match(/\.create-account-actions\s*{[^}]*}/s)?.[0] || '', /position:\s*(fixed|sticky)/);
});
