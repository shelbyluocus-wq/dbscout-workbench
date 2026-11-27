export function normalizeSelectOptions(options = []) {
  return (Array.isArray(options) ? options : []).map((option) => {
    if (option && typeof option === "object") {
      const value = String(option.value ?? "");
      return {
        value,
        label: String(option.label ?? value),
        detail: String(option.detail ?? ""),
        disabled: Boolean(option.disabled),
      };
    }
    const text = String(option ?? "");
    return {
      value: text,
      label: text,
      detail: "",
      disabled: false,
    };
  });
}

export function filterSelectOptions(options = [], query = "") {
  const normalized = normalizeSelectOptions(options);
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return normalized;
  return normalized.filter((item) =>
    item.label.toLowerCase().includes(needle)
    || item.value.toLowerCase().includes(needle)
    || item.detail.toLowerCase().includes(needle)
  );
}

export function computeSelectPopoverPosition(rect, viewport = {}) {
  const vw = Math.max(240, Number(viewport.width) || 1280);
  const vh = Math.max(200, Number(viewport.height) || 800);
  const margin = 12;
  const gap = 4;
  const width = Math.min(Math.max(Number(rect?.width) || 0, 180), vw - margin * 2);
  const left = Math.max(margin, Math.min(Number(rect?.left) || margin, vw - width - margin));
  const topEdge = Number(rect?.top) || 0;
  const bottomEdge = Number(rect?.bottom) || topEdge;
  const spaceBelow = Math.max(0, vh - bottomEdge - margin - gap);
  const spaceAbove = Math.max(0, topEdge - margin - gap);
  const openBelow = spaceBelow >= 180 || spaceBelow >= spaceAbove;
  const available = openBelow ? spaceBelow : spaceAbove;
  const maxHeight = Math.max(120, Math.min(280, available));
  return {
    placement: openBelow ? "bottom" : "top",
    left,
    width,
    maxHeight,
    top: openBelow ? bottomEdge + gap : undefined,
    bottom: openBelow ? undefined : vh - topEdge + gap,
  };
}
