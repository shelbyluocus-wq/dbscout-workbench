export function clampBackupNumber(value, { min = null, max = null } = {}) {
  if (!Number.isFinite(value)) return value;
  let next = value;
  if (min != null) next = Math.max(min, next);
  if (max != null) next = Math.min(max, next);
  return next;
}

export function parseBackupNumberInput(value, currentValue, bounds = {}) {
  if (value === "") return null;
  const next = Number(value);
  return Number.isFinite(next) ? clampBackupNumber(next, bounds) : currentValue;
}

export function stepBackupNumberValue(currentValue, direction, options = {}) {
  const { min = null, step = 1 } = options;
  const start = Number.isFinite(currentValue) ? currentValue : min ?? 0;
  const amount = Number.isFinite(step) && step > 0 ? step : 1;
  return clampBackupNumber(start + direction * amount, options);
}
