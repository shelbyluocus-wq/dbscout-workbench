import test from "node:test";
import assert from "node:assert/strict";

import { createDialogLayerManager } from "./dialogLayerManager.js";
import { noteKeyboardInteraction, notePointerInteraction } from "./focusModality.js";

function createHarness() {
  const listeners = new Map();
  const documentTarget = {
    activeElement: null,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };

  function element(name, { attributes = {} } = {}) {
    const elementListeners = new Map();
    const node = {
      name,
      hidden: false,
      isConnected: true,
      focusables: [],
      preferred: null,
      focus(options) {
        node.lastFocusOptions = options;
        documentTarget.activeElement = node;
      },
      addEventListener(type, listener) {
        elementListeners.set(type, listener);
      },
      removeEventListener(type, listener) {
        if (elementListeners.get(type) === listener) elementListeners.delete(type);
      },
      listener(type) {
        return elementListeners.get(type);
      },
      getAttribute(attribute) {
        return attributes[attribute] ?? null;
      },
      getClientRects() {
        return [{}];
      },
      contains(candidate) {
        return candidate === node || node.focusables.includes(candidate);
      },
      querySelector() {
        return node.preferred;
      },
      querySelectorAll() {
        return node.focusables;
      },
    };
    return node;
  }

  return {
    documentTarget,
    element,
    listener(type) {
      return listeners.get(type);
    },
  };
}

function keyEvent(key, options = {}) {
  return {
    key,
    shiftKey: Boolean(options.shiftKey),
    ctrlKey: Boolean(options.ctrlKey),
    metaKey: Boolean(options.metaKey),
    altKey: Boolean(options.altKey),
    defaultPrevented: Boolean(options.defaultPrevented),
    preventDefault() {
      this.defaultPrevented = true;
      this.prevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    stopImmediatePropagation() {
      this.immediatePropagationStopped = true;
    },
  };
}

function layer(root, close, isBusy) {
  return { dialogRef: { value: root }, close, isBusy };
}

test("Escape closes only the topmost dialog layer", () => {
  const harness = createHarness();
  const manager = createDialogLayerManager(() => harness.documentTarget);
  const outerRoot = harness.element("outer");
  const innerRoot = harness.element("inner");
  let outerCloses = 0;
  let innerCloses = 0;
  const outer = layer(outerRoot, () => { outerCloses += 1; });
  const inner = layer(innerRoot, () => { innerCloses += 1; });

  manager.activate(outer);
  manager.activate(inner);
  harness.listener("keydown")(keyEvent("Escape"));

  assert.equal(innerCloses, 1);
  assert.equal(outerCloses, 0);

  manager.deactivate(inner);
  harness.listener("keydown")(keyEvent("Escape"));
  assert.equal(outerCloses, 1);
});

test("an editor that handles Escape keeps its surrounding dialog open", () => {
  const harness = createHarness();
  const manager = createDialogLayerManager(() => harness.documentTarget);
  let closes = 0;
  manager.activate(layer(harness.element("dialog"), () => { closes += 1; }));

  const event = keyEvent("Escape", { defaultPrevented: true });
  harness.listener("keydown")(event);

  assert.equal(closes, 0);
  assert.equal(event.immediatePropagationStopped, true);
});

test("busy dialogs consume Escape without closing", () => {
  const harness = createHarness();
  const manager = createDialogLayerManager(() => harness.documentTarget);
  let closes = 0;
  manager.activate(layer(harness.element("dialog"), () => { closes += 1; }, () => true));

  const event = keyEvent("Escape");
  harness.listener("keydown")(event);

  assert.equal(closes, 0);
  assert.equal(event.defaultPrevented, true);
});

test("Tab stays inside the topmost dialog", () => {
  const harness = createHarness();
  const manager = createDialogLayerManager(() => harness.documentTarget);
  const root = harness.element("dialog");
  const first = harness.element("first");
  const last = harness.element("last");
  root.focusables = [first, last];
  root.preferred = first;
  const activeLayer = layer(root, () => {});
  manager.activate(activeLayer);

  harness.documentTarget.activeElement = last;
  assert.equal(manager.handleKeydown(keyEvent("Tab")), true);
  assert.equal(harness.documentTarget.activeElement, first);

  harness.documentTarget.activeElement = first;
  assert.equal(manager.handleKeydown(keyEvent("Tab", { shiftKey: true })), true);
  assert.equal(harness.documentTarget.activeElement, last);

  harness.documentTarget.activeElement = root;
  assert.equal(manager.handleKeydown(keyEvent("Tab", { shiftKey: true })), true);
  assert.equal(harness.documentTarget.activeElement, last);
});

test("a pointer-opened dialog restores focus without the keyboard focus ring", () => {
  const harness = createHarness();
  const manager = createDialogLayerManager(() => harness.documentTarget);
  const opener = harness.element("opener");
  const root = harness.element("dialog");
  harness.documentTarget.activeElement = opener;
  notePointerInteraction();
  try {
    manager.activate(layer(root, () => {}));
    noteKeyboardInteraction({ key: "Enter" });
    const focusState = manager.deactivate(manager.top());
    assert.equal(manager.restoreFocus(focusState), true);
    assert.equal(harness.documentTarget.activeElement, opener);
    assert.equal(opener.lastFocusOptions.focusVisible, false);
  } finally {
    noteKeyboardInteraction({ key: "Tab" });
  }
});

test("a keyboard-opened dialog still restores the focus ring", () => {
  const harness = createHarness();
  const manager = createDialogLayerManager(() => harness.documentTarget);
  const opener = harness.element("opener");
  harness.documentTarget.activeElement = opener;
  notePointerInteraction();
  noteKeyboardInteraction({ key: "Enter" });
  manager.activate(layer(harness.element("dialog"), () => {}));
  const focusState = manager.deactivate(manager.top());
  assert.equal(manager.restoreFocus(focusState), true);
  assert.equal(opener.lastFocusOptions.focusVisible, true);
});

test("closing a nested dialog restores focus to its opener", () => {
  const harness = createHarness();
  const manager = createDialogLayerManager(() => harness.documentTarget);
  const outerRoot = harness.element("outer");
  const opener = harness.element("opener");
  outerRoot.focusables = [opener];
  const outer = layer(outerRoot, () => {});
  const inner = layer(harness.element("inner"), () => {});

  manager.activate(outer);
  harness.documentTarget.activeElement = opener;
  manager.activate(inner);
  harness.documentTarget.activeElement = inner.dialogRef.value;

  const focusState = manager.deactivate(inner);
  assert.equal(manager.restoreFocus(focusState), true);
  assert.equal(harness.documentTarget.activeElement, opener);
});

test("active dialog roots stop shortcut-shaped events before background listeners", () => {
  const harness = createHarness();
  const manager = createDialogLayerManager(() => harness.documentTarget);
  const root = harness.element("dialog");
  const input = harness.element("input");
  root.focusables = [input];
  manager.activate(layer(root, () => {}));
  manager.focusLayer(manager.top());

  const appShortcut = keyEvent("p", { ctrlKey: true });
  root.listener("keydown")(appShortcut);
  assert.equal(appShortcut.propagationStopped, true);
  assert.equal(appShortcut.defaultPrevented, false);

  const plainTyping = keyEvent("a");
  assert.equal(root.listener("keydown")(plainTyping), false);
  assert.equal(plainTyping.propagationStopped, undefined);
});

test("nested teleported layers trap focus independently and restore their opener", () => {
  const harness = createHarness();
  const manager = createDialogLayerManager(() => harness.documentTarget);
  const parentRoot = harness.element("quick-open");
  const trigger = harness.element("filter-trigger");
  parentRoot.focusables = [trigger];
  manager.activate(layer(parentRoot, () => {}));
  manager.focusLayer(manager.top());
  harness.documentTarget.activeElement = trigger;

  const menuRoot = harness.element("teleported-menu");
  const first = harness.element("first-option");
  const last = harness.element("last-option");
  menuRoot.focusables = [first, last];
  menuRoot.preferred = first;
  const menuLayer = layer(menuRoot, () => {});
  manager.activate(menuLayer);
  manager.focusLayer(menuLayer);
  assert.equal(harness.documentTarget.activeElement, first);

  harness.documentTarget.activeElement = last;
  manager.handleKeydown(keyEvent("Tab"));
  assert.equal(harness.documentTarget.activeElement, first);

  const focusState = manager.deactivate(menuLayer);
  manager.restoreFocus(focusState);
  assert.equal(harness.documentTarget.activeElement, trigger);
});

test("the active layer can be focused again after queued dialog content changes", () => {
  const harness = createHarness();
  const manager = createDialogLayerManager(() => harness.documentTarget);
  const root = harness.element("confirm");
  const button = harness.element("confirm-button");
  root.focusables = [button];
  const activeLayer = layer(root, () => {});
  manager.activate(activeLayer);

  harness.documentTarget.activeElement = null;
  assert.equal(manager.focusCurrentLayer(), true);
  assert.equal(harness.documentTarget.activeElement, button);
});

test("non-modal utility layers close on Escape without trapping focus or blocking shortcuts", () => {
  const harness = createHarness();
  const manager = createDialogLayerManager(() => harness.documentTarget);
  const root = harness.element("find-replace");
  let closes = 0;
  const utilityLayer = { ...layer(root, () => { closes += 1; }), modal: false };
  manager.activate(utilityLayer);

  assert.equal(manager.hasActiveLayer(), true);
  assert.equal(manager.hasActiveModalLayer(), false);
  assert.equal(manager.focusLayer(utilityLayer), false);
  assert.equal(manager.handleKeydown(keyEvent("Tab")), false);
  assert.equal(manager.handleKeydown(keyEvent("p", { ctrlKey: true })), false);
  manager.handleKeydown(keyEvent("Escape"));
  assert.equal(closes, 1);
});
