import test from "node:test";
import assert from "node:assert/strict";

import { createHomepageSelectionDismissal } from "./homepageSelectionDismissal.js";

function createTarget({ inside = false, tableName = false, insideMenu = false } = {}) {
  return {
    inside,
    insideMenu,
    closest(selector) {
      return tableName && selector === ".wb-dbhome-object-name" ? this : null;
    },
  };
}

test("homepage selection is preserved for its table names and cleared after other clicks", () => {
  const scheduled = [];
  let clearCount = 0;
  const ownTableName = createTarget({ inside: true, tableName: true });
  const outside = createTarget();
  const dismissal = createHomepageSelectionDismissal({
    getRoot: () => ({ contains: (target) => target.inside }),
    clearSelection: () => { clearCount += 1; },
    scheduleClear: (callback) => scheduled.push(callback),
    scheduleGuardReset: () => {},
  });

  dismissal.handleDocumentClick({ target: ownTableName });
  assert.equal(scheduled.length, 0);

  dismissal.handleDocumentClick({ target: outside });
  assert.equal(clearCount, 0);
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.equal(clearCount, 1);
});

test("homepage selection is preserved while using its teleported context menu", () => {
  const scheduled = [];
  const menuItem = createTarget({ insideMenu: true });
  const dismissal = createHomepageSelectionDismissal({
    getRoot: () => ({ contains: () => false }),
    getProtectedRoots: () => [{ contains: (target) => target.insideMenu }],
    clearSelection: () => {},
    scheduleClear: (callback) => scheduled.push(callback),
    scheduleGuardReset: () => {},
  });

  dismissal.handleDocumentClick({ target: menuItem });

  assert.equal(scheduled.length, 0);
});

test("a valid box selection suppresses only its immediate follow-up click", () => {
  const scheduledClears = [];
  const scheduledGuardResets = [];
  const outside = createTarget();
  const dismissal = createHomepageSelectionDismissal({
    getRoot: () => ({ contains: () => false }),
    clearSelection: () => {},
    scheduleClear: (callback) => scheduledClears.push(callback),
    scheduleGuardReset: (callback) => scheduledGuardResets.push(callback),
  });

  dismissal.markBoxSelectionComplete();
  dismissal.handleDocumentClick({ target: outside });
  assert.equal(scheduledClears.length, 0);

  dismissal.handleDocumentClick({ target: outside });
  assert.equal(scheduledClears.length, 1);

  dismissal.markBoxSelectionComplete();
  scheduledGuardResets.at(-1)();
  dismissal.handleDocumentClick({ target: outside });
  assert.equal(scheduledClears.length, 2);
});
