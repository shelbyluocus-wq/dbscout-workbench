import test from 'node:test';
import assert from 'node:assert/strict';
import { textInputClipboard, usesNativeTextMenu } from './utils/textInputClipboard.js';

function field(overrides = {}) {
  const input = {
    tagName: 'INPUT', type: 'search', value: 'hero', selectionStart: 1, selectionEnd: 3,
    isConnected: true, disabled: false, readOnly: false,
    focus() {}, setSelectionRange() {}, ...overrides,
  };
  input.closest = () => input;
  return input;
}

test('copy uses the captured selection even after menu focus changes', async () => {
  const input = field();
  let copied;
  const actions = textInputClipboard(input, { copyText: async (text) => { copied = text; return true; } });
  input.selectionStart = input.selectionEnd = 4;
  assert.equal(await actions.copy(), true);
  assert.equal(copied, 'er');
});

test('text actions distinguish read-only fields, passwords, disabled and non-text controls', () => {
  assert.equal(textInputClipboard(field({ readOnly: true })).canPaste, false);
  assert.equal(textInputClipboard(field({ readOnly: true })).canCopy, true);
  assert.equal(textInputClipboard(field({ type: 'password' })).canCopy, false);
  assert.equal(textInputClipboard(field({ selectionStart: 2, selectionEnd: 2 })).canCopy, false);
  assert.equal(textInputClipboard(field({ disabled: true })), null);
  assert.equal(textInputClipboard(field({ type: 'checkbox' })), null);
});

test('a delayed clipboard read cannot overwrite changed, unmounted or newly locked fields', async () => {
  for (const change of [{ value: 'new query' }, { isConnected: false }, { readOnly: true }, { disabled: true }]) {
    const input = field({ focus() { assert.fail('stale paste must not steal focus'); } });
    let finishRead;
    const actions = textInputClipboard(input, { readText: () => new Promise((resolve) => { finishRead = resolve; }) });
    const paste = actions.paste();
    Object.assign(input, change);
    finishRead('replacement');
    assert.equal(await paste, false);
    assert.equal(input.value, change.value ?? 'hero');
  }
});

test('number and email selections stay with the native text menu', () => {
  for (const type of ['number', 'email']) {
    const input = field({ type, selectionStart: null, selectionEnd: null });
    assert.equal(usesNativeTextMenu(input), true);
    assert.equal(textInputClipboard(input), null);
  }
  assert.equal(usesNativeTextMenu(field()), false);
});
