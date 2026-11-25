import { invokeWorkbench, isTauriRuntime } from "./tauriBridge.js";
import { t } from "../i18n/index.js";

const DEDUP_WINDOW_MS = 5000;
const RATE_WINDOW_MS = 60_000;
const MAX_REPORTS_PER_WINDOW = 30;
const MAX_MESSAGE_CHARS = 1800;
const MAX_STACK_CHARS = 10_000;
const MAX_META_CHARS = 240;

const URL_CREDENTIALS_RE = /\b((?:mysql|mariadb|postgres|postgresql|mongodb(?:\+srv)?|clickhouse|https?):\/\/)[^\s/@"'()]+@/gi;
const BEARER_TOKEN_RE = /\b(Bearer\s+)[^\s"',;)\]]+/gi;

const recentFingerprints = new Map();
let windowTimestamps = [];
let rootOverlayShown = false;

function clipText(value, limit) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}...[truncated]` : text;
}

export function redactFrontendErrorText(value) {
  return String(value ?? "")
    .replace(URL_CREDENTIALS_RE, "$1***@")
    .replace(BEARER_TOKEN_RE, "$1***");
}

export function extractComponentName(instance) {
  if (!instance) return "";
  const type = instance.$options || instance.type || instance;
  const raw = type?.name || type?.__name || type?.__file || "";
  const text = String(raw || "").trim();
  if (!text) return "";
  const base = text.split(/[\\/]/).pop() || text;
  return base.replace(/\.vue$/i, "");
}

export function normalizeFrontendError(error) {
  if (error instanceof Error) {
    return {
      message: error.message || error.name || "Error",
      stack: error.stack || "",
    };
  }
  if (error && typeof error === "object") {
    const message = String(error.message || error.reason || error.name || "");
    const stack = String(error.stack || "");
    if (message) return { message, stack };
    try {
      return { message: JSON.stringify(error), stack };
    } catch {
      return { message: String(error), stack };
    }
  }
  return { message: String(error ?? "Unknown error"), stack: "" };
}

export function buildFrontendErrorPayload(error, meta = {}) {
  const normalized = normalizeFrontendError(error);
  const kind = clipText(meta.kind || "frontend-error", MAX_META_CHARS) || "frontend-error";
  const message = clipText(redactFrontendErrorText(normalized.message), MAX_MESSAGE_CHARS) || "(empty error)";
  const stack = clipText(redactFrontendErrorText(meta.stack || normalized.stack), MAX_STACK_CHARS);
  const component = clipText(meta.component || "", MAX_META_CHARS);
  const info = clipText(meta.info || "", MAX_META_CHARS);
  const area = clipText(meta.area || "", MAX_META_CHARS);

  const entry = { kind, message };
  if (stack) entry.stack = stack;
  if (component) entry.component = component;
  if (info) entry.info = info;
  if (area) entry.area = area;
  return entry;
}

export function isRenderOrPatchError(error, info = "") {
  const infoText = String(info || "").toLowerCase();
  if (
    infoText.includes("render")
    || infoText.includes("scheduler")
    || infoText.includes("patch")
    || infoText.includes("update")
    || infoText.includes("#runtime-0")
    || infoText.includes("#runtime-15")
    || infoText.includes("#runtime-2")
    || infoText.includes("#runtime-3")
  ) {
    return true;
  }
  const msg = String(error?.message || error || "").toLowerCase();
  return (
    msg.includes("insertbefore")
    || msg.includes("removechild")
    || msg.includes("parentnode")
    || msg.includes("nextsibling")
  );
}

function shouldSendReport(entry, now = Date.now()) {
  const fp = `${entry.kind}|${entry.area || ""}|${entry.component || ""}|${entry.message}`;
  const lastAt = recentFingerprints.get(fp);
  if (lastAt != null && now - lastAt < DEDUP_WINDOW_MS) return false;
  recentFingerprints.set(fp, now);
  if (recentFingerprints.size > 100) {
    for (const [key, ts] of recentFingerprints) {
      if (now - ts >= DEDUP_WINDOW_MS) recentFingerprints.delete(key);
    }
  }
  windowTimestamps = windowTimestamps.filter((ts) => now - ts < RATE_WINDOW_MS);
  if (windowTimestamps.length >= MAX_REPORTS_PER_WINDOW) return false;
  windowTimestamps.push(now);
  return true;
}

export function resetFrontendErrorThrottleForTests() {
  recentFingerprints.clear();
  windowTimestamps = [];
  rootOverlayShown = false;
}

export function reportFrontendError(error, meta = {}, { transport = null, now = Date.now } = {}) {
  try {
    const entry = buildFrontendErrorPayload(error, meta);
    if (!shouldSendReport(entry, now())) return false;
    if (typeof transport === "function") {
      void Promise.resolve(transport(entry)).catch(() => {});
      return true;
    }
    if (!isTauriRuntime()) return false;
    void invokeWorkbench("log_frontend_error", { entry }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure-DOM fallback recovery bar mounted outside `#app`.
 * Only shown if an unhandled Vue render/patch/scheduler exception escapes all
 * component boundaries (so even a corrupted root VNode tree cannot leave the
 * user stranded on a silent blank window).
 */
export function showRootRecoveryBanner(message = "", { doc = globalThis.document, win = globalThis.window } = {}) {
  if (rootOverlayShown || !doc?.body) return false;
  rootOverlayShown = true;
  try {
    const existing = doc.getElementById("wb-root-crash-banner");
    if (existing) existing.remove();

    const bar = doc.createElement("aside");
    bar.id = "wb-root-crash-banner";
    bar.setAttribute("role", "alert");
    bar.style.cssText = [
      "position:fixed",
      "left:50%",
      "bottom:20px",
      "transform:translateX(-50%)",
      "z-index:2147483647",
      "display:flex",
      "align-items:center",
      "gap:12px",
      "max-width:min(560px, calc(100vw - 32px))",
      "padding:10px 14px",
      "border-radius:10px",
      "border:1px solid rgba(185, 28, 28, 0.35)",
      "background:rgba(24, 24, 27, 0.94)",
      "color:#f4f4f5",
      "box-shadow:0 12px 32px rgba(0, 0, 0, 0.35)",
      "font-family:-apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif",
      "font-size:var(--wb-fs-body, 13px)",
      "line-height:1.45",
    ].join(";");

    const copy = doc.createElement("div");
    copy.style.cssText = "flex:1 1 auto; min-width:0;";
    const title = doc.createElement("div");
    title.style.cssText = "font-weight:600;";
    title.textContent = t("errorBoundary.rootTitle");
    const sub = doc.createElement("div");
    sub.style.cssText = "color:#a1a1aa; font-size:var(--wb-fs-caption, 12px); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
    sub.textContent = message || t("errorBoundary.rootHint");
    copy.appendChild(title);
    copy.appendChild(sub);

    const reloadBtn = doc.createElement("button");
    reloadBtn.type = "button";
    reloadBtn.textContent = t("errorBoundary.reloadWindow");
    reloadBtn.style.cssText = [
      "flex:0 0 auto",
      "padding:5px 12px",
      "border-radius:6px",
      "border:none",
      "background:#2563eb",
      "color:#ffffff",
      "font-size:var(--wb-fs-caption, 12px)",
      "font-weight:500",
      "cursor:pointer",
    ].join(";");
    reloadBtn.addEventListener("click", () => {
      try { win?.location?.reload?.(); } catch {}
    });

    const closeBtn = doc.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = t("errorBoundary.dismiss");
    closeBtn.style.cssText = [
      "flex:0 0 auto",
      "padding:5px 8px",
      "border-radius:6px",
      "border:1px solid rgba(255,255,255,0.18)",
      "background:transparent",
      "color:#e4e4e7",
      "font-size:var(--wb-fs-caption, 12px)",
      "cursor:pointer",
    ].join(";");
    closeBtn.addEventListener("click", () => {
      bar.remove();
      rootOverlayShown = false;
    });

    bar.appendChild(copy);
    bar.appendChild(reloadBtn);
    bar.appendChild(closeBtn);
    doc.body.appendChild(bar);
    return true;
  } catch {
    rootOverlayShown = false;
    return false;
  }
}

export function installGlobalErrorHandlers(app, { win = globalThis.window, transport = null } = {}) {
  if (app?.config) {
    app.config.errorHandler = (err, instance, info) => {
      const component = extractComponentName(instance);
      reportFrontendError(
        err,
        { kind: "vue-error", component, info: String(info || ""), area: "app" },
        { transport },
      );
      if (isRenderOrPatchError(err, info)) {
        showRootRecoveryBanner(normalizeFrontendError(err).message);
      }
      console.error("[blackcat:vue-error]", component || "unknown", info, err);
    };
  }

  if (win && typeof win.addEventListener === "function") {
    win.addEventListener("error", (event) => {
      const msg = String(event?.message || "");
      // Benign browser layout observer warning; not an application error.
      if (msg.includes("ResizeObserver loop")) return;
      const err = event?.error || new Error(msg || "Window error");
      const info = event?.filename ? `${event.filename}:${event.lineno || 0}:${event.colno || 0}` : "";
      reportFrontendError(err, { kind: "window-error", info, area: "window" }, { transport });
    });

    win.addEventListener("unhandledrejection", (event) => {
      const reason = event?.reason ?? "Unhandled promise rejection";
      reportFrontendError(reason, { kind: "unhandled-rejection", area: "window" }, { transport });
    });
  }
}
