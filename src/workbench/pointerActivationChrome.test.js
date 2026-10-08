import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isPointerButtonActivation,
  pointerStillOverElement,
  retainPointerActivationChrome,
} from "./pointerActivationChrome.js";

function buttonBox() {
  return { left: 0, top: 10, right: 30, bottom: 40 };
}

function fakeButton() {
  const calls = { blurred: 0 };
  return {
    calls,
    blur() { calls.blurred += 1; },
    getBoundingClientRect: buttonBox,
  };
}

function fakeView() {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, listener, capture) {
      listeners.push({ type, listener, capture });
    },
    removeEventListener(type, listener) {
      const index = listeners.findIndex((item) => item.type === type && item.listener === listener);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
}

test("only a pointer click counts as a pointer button activation", () => {
  const button = fakeButton();
  assert.equal(isPointerButtonActivation({ detail: 1, currentTarget: button }), true);
  assert.equal(isPointerButtonActivation({ detail: 0, currentTarget: button }), false);
  assert.equal(isPointerButtonActivation(null), false);
});

test("a pointer click blurs the button and keeps the idle look until the pointer leaves", () => {
  const button = fakeButton();
  const view = fakeView();
  let released = 0;
  const retained = retainPointerActivationChrome(
    { detail: 1, currentTarget: button, view },
    () => { released += 1; },
  );

  assert.equal(retained, true);
  assert.equal(button.calls.blurred, 1);
  assert.equal(view.listeners.length, 1);
  assert.equal(pointerStillOverElement(button, { clientX: 10, clientY: 20 }), true);

  view.listeners[0].listener({ clientX: 10, clientY: 20 });
  assert.equal(released, 0);
  assert.equal(view.listeners.length, 1);

  view.listeners[0].listener({ clientX: 80, clientY: 20 });
  assert.equal(released, 1);
  assert.equal(view.listeners.length, 0);
});

test("keyboard activation does not blur the button", () => {
  const button = fakeButton();
  const retained = retainPointerActivationChrome(
    { detail: 0, currentTarget: button, view: fakeView() },
    () => {},
  );
  assert.equal(retained, false);
  assert.equal(button.calls.blurred, 0);
});
