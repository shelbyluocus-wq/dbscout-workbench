import { ref } from "vue";

export function normalizeSystemFontList(result) {
  const values = Array.isArray(result) ? result : result?.fonts;
  if (!Array.isArray(values)) return [];

  const unique = new Map();
  for (const value of values) {
    const rawName = typeof value === "string" ? value : value?.family;
    if (typeof rawName !== "string") continue;
    if (/[\u0000-\u001f\u007f]/.test(rawName)) continue;
    const family = rawName.trim().replace(/\s+/g, " ");
    if (!family || family.length > 160) continue;
    const weights = (typeof value === "string" ? [400] : value?.weights || [])
      .map(Number)
      .filter((weight) => Number.isInteger(weight) && weight >= 1 && weight <= 1000);
    const key = family.toLocaleLowerCase();
    if (!unique.has(key)) unique.set(key, { family, weights: new Set() });
    const entry = unique.get(key);
    for (const weight of weights.length ? weights : [400]) entry.weights.add(weight);
  }

  return [...unique.values()]
    .map(({ family, weights }) => ({ family, weights: [...weights].sort((a, b) => a - b) }))
    .sort((left, right) =>
      left.family.localeCompare(right.family, "zh-CN", { sensitivity: "base", numeric: true }),
    );
}

export function createSystemFontsController(invokeWorkbench) {
  const fonts = ref([]);
  const loading = ref(false);
  const error = ref("");
  let loaded = false;
  let inFlight = null;

  async function load({ force = false } = {}) {
    if (loaded && !force) return fonts.value;
    if (inFlight && !force) return inFlight;

    loading.value = true;
    error.value = "";
    inFlight = Promise.resolve()
      .then(() => invokeWorkbench("list_system_fonts"))
      .then((result) => {
        const nextFonts = normalizeSystemFontList(result);
        if (!nextFonts.length) throw new Error("未找到本机字体");
        fonts.value = nextFonts;
        loaded = true;
        return nextFonts;
      })
      .catch((reason) => {
        error.value = String(reason?.message || reason || "读取本机字体失败");
        throw reason;
      })
      .finally(() => {
        loading.value = false;
        inFlight = null;
      });

    return inFlight;
  }

  function refresh() {
    return load({ force: true });
  }

  return { fonts, loading, error, load, refresh };
}
