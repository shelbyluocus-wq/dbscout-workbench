// Number/email controls do not expose selection offsets. Keep their native
// text menu so the browser can copy/paste the actual internal selection.
export function usesNativeTextMenu(target) {
  const input = target?.closest?.('input');
  return Boolean(input && ['number', 'email'].includes(input.type));
}

// Snapshot the text selection before a menu can move focus away from the field.
export function textInputClipboard(target, { copyText, readText } = {}) {
  const input = target?.closest?.('input, textarea');
  if (!input || input.disabled) return null;
  const tag = input.tagName?.toLowerCase();
  if (tag !== 'textarea' && !['text', 'search', 'url', 'tel', 'password'].includes(input.type)) return null;
  const value = String(input.value ?? '');
  const start = input.selectionStart ?? value.length;
  const end = input.selectionEnd ?? start;
  const canCopy = end > start && input.type !== 'password';
  const canPaste = !input.readOnly;
  const restore = () => {
    input.focus({ preventScroll: true });
    if (input.selectionStart !== null) input.setSelectionRange(start, end);
  };
  return {
    canCopy,
    canPaste,
    async copy() {
      if (!canCopy) return false;
      const copied = await copyText(value.slice(start, end));
      if (input.isConnected && input.value === value) restore();
      return copied;
    },
    async paste() {
      if (!canPaste) return false;
      const text = String(await readText());
      // Clipboard access may be asynchronous. Never overwrite a field that has
      // since changed, unmounted, or become read-only.
      if (!input.isConnected || input.disabled || input.readOnly || input.value !== value) return false;
      restore();
      // Native insertion preserves the browser's undo history and input events.
      if (input.ownerDocument.execCommand?.('insertText', false, text)) return true;
      const insertion = input.tagName.toLowerCase() === 'textarea' ? text : text.replace(/[\r\n]/g, '');
      const limit = input.maxLength;
      const clipped = limit >= 0 ? insertion.slice(0, Math.max(0, limit - value.length + end - start)) : insertion;
      const before = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: clipped });
      if (!input.dispatchEvent(before)) return false;
      if (input.selectionStart !== null) input.setRangeText(clipped, start, end, 'end');
      else input.value = value.slice(0, start) + clipped + value.slice(end);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: clipped }));
      return true;
    },
  };
}
