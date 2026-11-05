// Sequential batch runner for `run_ui_actions`: sends each step as a
// `ui_action` control request, stops at the first failure, and returns the
// per-step results. Permission checks apply per step at the control endpoint.
export const ALLOWED_UI_ACTIONS = Object.freeze([
  "open_table", "focus_column", "focus_row", "focus_cell", "refresh_table",
  "reveal_window", "select_database", "open_sql", "select_range", "scroll_table",
]);

export async function runUiActionBatch(control, steps, options = {}) {
  const list = Array.isArray(steps) ? steps : [];
  if (list.length < 1 || list.length > 20) {
    throw new Error("steps 必须是 1-20 个动作");
  }
  for (const step of list) {
    if (!ALLOWED_UI_ACTIONS.includes(String(step?.action || ""))) {
      throw new Error(`不支持的界面动作：${step?.action}`);
    }
  }
  const mode = options.mode || "fast";
  const detail = options.detail || "compact";
  const pauseMs = options.pauseMs ?? 600;
  if (!["fast", "demo"].includes(mode) || !["compact", "full"].includes(detail)
    || !Number.isInteger(pauseMs) || pauseMs < 100 || pauseMs > 3000) {
    throw new Error("无效批量选项：mode=fast/demo，detail=compact/full，pauseMs=100-3000");
  }
  const startedAt = performance.now();
  const results = [];
  let context;
  for (const [index, step] of list.entries()) {
    const stepStartedAt = performance.now();
    try {
      const data = await control.request("ui_action", {
        action: step.action,
        args: { ...step.args, ...(mode === "demo" ? { demoStep: `${index + 1}/${list.length}` } : {}) },
      });
      if (data?.context) context = data.context;
      results.push({
        index, action: step.action, ok: true, durationMs: Math.round(performance.now() - stepStartedAt),
        ...(detail === "full" ? { data } : { message: data?.message, requestId: data?.requestId, status: data?.status }),
      });
      if (mode === "demo" && index < list.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
      }
    } catch (error) {
      results.push({ index, action: step.action, ok: false, durationMs: Math.round(performance.now() - stepStartedAt), error: String(error?.message || error) });
      return { completed: results.length - 1, stoppedAt: step.action, stoppedIndex: index, results, context, durationMs: Math.round(performance.now() - startedAt) };
    }
  }
  return { completed: results.length, results, context, durationMs: Math.round(performance.now() - startedAt) };
}
