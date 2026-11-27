import test from "node:test";
import assert from "node:assert/strict";
import {
  computeSelectPopoverPosition,
  filterSelectOptions,
  normalizeSelectOptions,
} from "./utils/selectPopover.js";

test("normalizeSelectOptions handles primitives and objects uniformly", () => {
  assert.deepEqual(
    normalizeSelectOptions(["utf8mb4", { value: "", label: "跟随默认", detail: "auto" }]),
    [
      { value: "utf8mb4", label: "utf8mb4", detail: "", disabled: false },
      { value: "", label: "跟随默认", detail: "auto", disabled: false },
    ],
  );
});

test("filterSelectOptions matches label, value, and detail case-insensitively", () => {
  const options = [
    { value: "utf8mb4_general_ci", label: "utf8mb4_general_ci" },
    { value: "utf8mb4_unicode_ci", label: "utf8mb4_unicode_ci" },
    { value: "latin1_swedish_ci", label: "latin1_swedish_ci", detail: "legacy" },
  ];
  assert.equal(filterSelectOptions(options, "").length, 3);
  assert.deepEqual(
    filterSelectOptions(options, "UNICODE").map((item) => item.value),
    ["utf8mb4_unicode_ci"],
  );
  assert.deepEqual(
    filterSelectOptions(options, "LEGACY").map((item) => item.value),
    ["latin1_swedish_ci"],
  );
});

test("computeSelectPopoverPosition opens below trigger when room permits and flips above near bottom edge", () => {
  const below = computeSelectPopoverPosition(
    { left: 320, top: 210, bottom: 238, width: 260 },
    { width: 1280, height: 800 },
  );
  assert.equal(below.placement, "bottom");
  assert.equal(below.left, 320);
  assert.equal(below.width, 260);
  assert.equal(below.top, 242);
  assert.equal(below.bottom, undefined);
  assert.equal(below.maxHeight, 280);

  const above = computeSelectPopoverPosition(
    { left: 1180, top: 720, bottom: 748, width: 140 },
    { width: 1280, height: 800 },
  );
  assert.equal(above.placement, "top");
  assert.equal(above.width, 180);
  assert.equal(above.left, 1280 - 180 - 12);
  assert.equal(above.bottom, 800 - 720 + 4);
  assert.equal(above.top, undefined);
});
