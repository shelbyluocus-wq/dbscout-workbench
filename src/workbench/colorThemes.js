// 主题注册表：每套主题在基座 token（workbench.css）之上覆盖一组 --wb-* 变量。
// 覆盖由 colorThemeController 以 <style> 形式注入，选择器与基座定义相同
// （:root 与 .mysql-workbench[data-theme="dark"], .wb-floating-themed[data-theme="dark"]），
// 因此 Teleport 浮层无需任何改动即可继承主题。
// 新增主题 = 在此追加一条记录，无需改动其他任何文件。

export const COLOR_THEMES = [
  {
    id: "slate",
    label: "石板灰",
    description: "默认 · 克制中性的工作台",
    swatch: ["#4a5568", "#e5e8eb", "#121214"],
    // 基座即石板灰：空覆盖，注入时移除 style 标签。
    light: {},
    dark: {},
  },
  {
    id: "teal",
    label: "猫眼青",
    description: "黑猫绿眼 · 冷静专注",
    swatch: ["#0f766e", "#e4e9e8", "#111415"],
    light: {
      "--wb-accent": "#0f766e",
      "--wb-accent-strong": "#115e59",
      "--wb-accent-soft": "rgba(15, 118, 110, 0.08)",
      "--wb-accent-control": "#0d9488",
      "--wb-accent-control-hover": "#0f766e",
      "--wb-accent-control-text": "#ffffff",
      "--wb-cell-highlight": "var(--wb-cell-highlight-custom, #14b8a6)",
      "--wb-window": "#e4e9e8",
      "--wb-chrome-surface": "#e7edec",
      "--wb-tree-surface": "rgba(224, 232, 230, 0.72)",
      "--wb-pane-header": "rgba(230, 236, 234, 0.8)",
      "--wb-workspace-mist": "oklch(99.6% 0.002 195)",
      "--wb-workspace-mist-raised": "oklch(99.6% 0.002 195)",
      "--wb-workspace-mist-canvas": "oklch(99.6% 0.002 195)",
      "--wb-grid-header": "oklch(95.8% 0.006 195)",
      "--wb-grid-row": "oklch(99.6% 0.002 195)",
      "--wb-grid-row-alt": "oklch(97.2% 0.003 195)",
      "--wb-index-surface": "oklch(96.2% 0.005 195)",
      "--wb-toolbar-surface": "rgba(246, 249, 248, 0.85)",
      "--wb-table-surface": "rgba(255, 255, 255, 0.95)",
      "--wb-grid-canvas": "rgba(252, 254, 253, 0.95)",
    },
    dark: {
      "--wb-accent": "#2dd4bf",
      "--wb-accent-strong": "#5eead4",
      "--wb-accent-soft": "rgba(45, 212, 191, 0.12)",
      "--wb-accent-control": "#0f766e",
      "--wb-accent-control-hover": "#0d9488",
      "--wb-accent-control-text": "#ffffff",
      "--wb-cell-highlight": "var(--wb-cell-highlight-custom, #2dd4bf)",
      "--wb-window": "#111415",
      "--wb-chrome-surface": "#1a1f1e",
      "--wb-tree-surface": "rgba(12, 16, 15, 0.65)",
      "--wb-pane-header": "rgba(28, 33, 32, 0.85)",
      "--wb-workspace-mist": "oklch(15% 0.004 195)",
      "--wb-workspace-mist-raised": "oklch(15% 0.004 195)",
      "--wb-workspace-mist-canvas": "oklch(15% 0.004 195)",
      "--wb-grid-header": "oklch(21.5% 0.006 195)",
      "--wb-grid-row": "oklch(15% 0.004 195)",
      "--wb-grid-row-alt": "oklch(17.5% 0.004 195)",
      "--wb-index-surface": "oklch(20.5% 0.005 195)",
    },
  },
  {
    id: "azure",
    label: "矿石蓝",
    description: "经典工具蓝 · 亲和稳妥",
    swatch: ["#2563eb", "#e5e8ee", "#121318"],
    light: {
      "--wb-accent": "#2563eb",
      "--wb-accent-strong": "#1d4ed8",
      "--wb-accent-soft": "rgba(37, 99, 235, 0.08)",
      "--wb-accent-control": "#2563eb",
      "--wb-accent-control-hover": "#1d4ed8",
      "--wb-accent-control-text": "#ffffff",
      "--wb-cell-highlight": "var(--wb-cell-highlight-custom, #3b82f6)",
      "--wb-window": "#e5e8ee",
      "--wb-chrome-surface": "#e8ecf3",
      "--wb-tree-surface": "rgba(225, 231, 240, 0.72)",
      "--wb-pane-header": "rgba(230, 235, 243, 0.8)",
      "--wb-workspace-mist": "oklch(99.6% 0.002 255)",
      "--wb-workspace-mist-raised": "oklch(99.6% 0.002 255)",
      "--wb-workspace-mist-canvas": "oklch(99.6% 0.002 255)",
      "--wb-grid-header": "oklch(95.8% 0.007 255)",
      "--wb-grid-row": "oklch(99.6% 0.002 255)",
      "--wb-grid-row-alt": "oklch(97.2% 0.004 255)",
      "--wb-index-surface": "oklch(96.2% 0.006 255)",
      "--wb-toolbar-surface": "rgba(246, 248, 252, 0.85)",
      "--wb-table-surface": "rgba(255, 255, 255, 0.95)",
      "--wb-grid-canvas": "rgba(252, 253, 255, 0.95)",
    },
    dark: {
      "--wb-accent": "#60a5fa",
      "--wb-accent-strong": "#93c5fd",
      "--wb-accent-soft": "rgba(96, 165, 250, 0.12)",
      "--wb-accent-control": "#2563eb",
      "--wb-accent-control-hover": "#3b82f6",
      "--wb-accent-control-text": "#ffffff",
      "--wb-cell-highlight": "var(--wb-cell-highlight-custom, #60a5fa)",
      "--wb-window": "#121318",
      "--wb-chrome-surface": "#1b1c23",
      "--wb-tree-surface": "rgba(13, 14, 19, 0.65)",
      "--wb-pane-header": "rgba(28, 29, 36, 0.85)",
      "--wb-workspace-mist": "oklch(15% 0.005 255)",
      "--wb-workspace-mist-raised": "oklch(15% 0.005 255)",
      "--wb-workspace-mist-canvas": "oklch(15% 0.005 255)",
      "--wb-grid-header": "oklch(21.5% 0.007 255)",
      "--wb-grid-row": "oklch(15% 0.005 255)",
      "--wb-grid-row-alt": "oklch(17.5% 0.005 255)",
      "--wb-index-surface": "oklch(20.5% 0.006 255)",
    },
  },
];

export const DEFAULT_COLOR_THEME = "slate";

export function getColorTheme(id) {
  return COLOR_THEMES.find((theme) => theme.id === id) || null;
}

export function isColorThemeId(id) {
  return Boolean(getColorTheme(id));
}
