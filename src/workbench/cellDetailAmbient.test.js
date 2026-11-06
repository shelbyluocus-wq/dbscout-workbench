import test from "node:test";
import assert from "node:assert/strict";
import {
  AMBIENT_KEYFRAMES,
  ambientStyleVars,
  formatMinutes,
  minutesOfDay,
  normalizeMinutes,
  resolveAmbient,
} from "./utils/cellDetailAmbient.js";

test("ambient keyframes are ordered within one day", () => {
  for (let index = 1; index < AMBIENT_KEYFRAMES.length; index += 1) {
    assert.ok(AMBIENT_KEYFRAMES[index][0] > AMBIENT_KEYFRAMES[index - 1][0]);
  }
  assert.ok(AMBIENT_KEYFRAMES.at(-1)[0] < 1440);
});

test("ambient colors hit each keyframe exactly", () => {
  for (const [minute, primary, secondary] of AMBIENT_KEYFRAMES) {
    const ambient = resolveAmbient(minute);
    assert.equal(ambient.primary, primary);
    assert.equal(ambient.secondary, secondary);
  }
});

test("the primary haze follows the sun across the panel", () => {
  assert.ok(Math.abs(resolveAmbient(360).primaryX - 5) < 0.01);
  assert.ok(Math.abs(resolveAmbient(720).primaryX - 50) < 0.01);
  assert.ok(Math.abs(resolveAmbient(1080).primaryX - 95) < 0.01);
  assert.ok(Math.abs(resolveAmbient(720).primaryY) < 0.01);
  assert.ok(Math.abs(resolveAmbient(0).primaryY - 100) < 0.01);
  const noon = resolveAmbient(720);
  assert.equal(noon.secondaryX, 100 - noon.primaryX);
});

test("the gradient changes continuously, including across midnight", () => {
  const channels = (hex) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  for (let minute = 0; minute < 1440; minute += 1) {
    const a = resolveAmbient(minute);
    const b = resolveAmbient(minute + 1);
    const step = Math.max(...channels(a.primary).map((value, index) => Math.abs(value - channels(b.primary)[index])));
    assert.ok(step <= 6, `primary jumps ${step} at ${formatMinutes(minute)}`);
    assert.ok(Math.abs(a.primaryX - b.primaryX) < 0.5);
    assert.ok(Math.abs(a.primaryY - b.primaryY) < 0.5);
  }
});

test("minutes normalize, format and come from the local clock", () => {
  assert.equal(normalizeMinutes(1440 + 30), 30);
  assert.equal(normalizeMinutes(-30), 1410);
  assert.equal(normalizeMinutes(Number.NaN), 0);
  assert.equal(formatMinutes(0), "00:00");
  assert.equal(formatMinutes(1439.9), "23:59");
  assert.equal(formatMinutes(605), "10:05");
  assert.equal(minutesOfDay(new Date(2026, 10, 6, 18, 30, 0)), 1110);
});

test("ambient style exposes the panel's custom properties", () => {
  const style = ambientStyleVars(720);
  assert.deepEqual(Object.keys(style).sort(), [
    "--wb-ambient-a", "--wb-ambient-ax", "--wb-ambient-ay",
    "--wb-ambient-b", "--wb-ambient-bx", "--wb-ambient-by",
  ]);
  assert.match(style["--wb-ambient-a"], /^#[0-9a-f]{6}$/);
  assert.match(style["--wb-ambient-ax"], /^\d+(\.\d)?%$/);
});
