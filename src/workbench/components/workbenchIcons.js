import { h } from "vue";
import { Server, ServerOff } from "lucide-vue-next";
import { CONNECTION_KINDS, normalizeConnectionKind } from "../utils/connectionKinds.js";

// Keep two explicit non-defaulted parameters so Vue 3 sees `.length === 2`
// and always supplies the functional component context (`{ attrs }`).
function createWorkbenchIcon(iconClasses, defaultStrokeWidth, buildChildren) {
  function WorkbenchIcon(props, context) {
    const safeProps = props || {};
    const attrs = context?.attrs || {};
    const size = safeProps.size ?? attrs.size ?? 24;
    const color = safeProps.color ?? attrs.color ?? "currentColor";
    const rawStrokeWidth = Number(
      safeProps.strokeWidth ?? attrs.strokeWidth ?? attrs["stroke-width"] ?? defaultStrokeWidth,
    );
    const absoluteStrokeWidth = Boolean(
      safeProps.absoluteStrokeWidth ?? attrs.absoluteStrokeWidth ?? attrs["absolute-stroke-width"],
    );
    const strokeWidth = absoluteStrokeWidth && Number(size) > 0
      ? (rawStrokeWidth * 24) / Number(size)
      : rawStrokeWidth;
    const {
      size: _size,
      color: _color,
      strokeWidth: _strokeWidth,
      "stroke-width": _strokeWidthKebab,
      absoluteStrokeWidth: _absoluteStrokeWidth,
      "absolute-stroke-width": _absoluteStrokeWidthKebab,
      class: extraClass,
      ...restAttrs
    } = attrs;

    return h(
      "svg",
      {
        ...restAttrs,
        xmlns: "http://www.w3.org/2000/svg",
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: color,
        "stroke-width": strokeWidth,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        class: ["lucide", ...iconClasses, extraClass],
      },
      buildChildren(color),
    );
  }

  WorkbenchIcon.inheritAttrs = false;
  WorkbenchIcon.props = {
    size: { type: [Number, String], default: 24 },
    color: { type: String, default: "currentColor" },
    strokeWidth: { type: [Number, String], default: defaultStrokeWidth },
    absoluteStrokeWidth: { type: Boolean, default: false },
  };
  return WorkbenchIcon;
}

// M1: Minimal leaping dolphin silhouette for MySQL connections.
export const MysqlConnectionIcon = createWorkbenchIcon(
  ["lucide-mysql-icon", "wb-mysql-icon"],
  1.55,
  (color) => [
    h("path", {
      d: "M5.2 19.2c-.3-4.6 1.5-9.7 5.7-12.5 2.4-1.6 5.6-1.8 7.6-.3 1 .7 1.6 1.7 2 2.9-1.4-.3-2.5-.2-3.5.3-.5.3-.9.7-1.1 1.3-.3 1 .2 2.4 1.3 3.4-1.8 0-3.2-.6-4.2-1.8-1.5 1.1-2.8 2.8-3.5 5.2-.9-.1-2.5.4-4.3 1.5Z",
      fill: color,
      "fill-opacity": "0.24",
    }),
    h("path", {
      d: "M10.4 6.9c.1-1.6 1-2.8 2.6-3.2.2 1 .7 1.8 1.4 2.4",
      fill: color,
      "fill-opacity": "0.18",
    }),
    h("path", {
      d: "M5.2 19.2c-1.1-.4-1.9-1.1-2.4-2 1.1-.1 2 .1 2.7.6",
    }),
    h("circle", {
      cx: "16.2",
      cy: "8.1",
      r: "0.7",
      fill: color,
      stroke: "none",
    }),
  ],
);

// M1 (closed): Dimmed slashed dolphin when a MySQL connection is closed.
export const MysqlConnectionOffIcon = createWorkbenchIcon(
  ["lucide-mysql-off-icon", "wb-mysql-icon", "is-closed-glyph"],
  1.55,
  (color) => [
    h("path", {
      d: "M5.2 19.2c-.3-4.6 1.5-9.7 5.7-12.5 2.4-1.6 5.6-1.8 7.6-.3 1 .7 1.6 1.7 2 2.9-1.4-.3-2.5-.2-3.5.3-.5.3-.9.7-1.1 1.3-.3 1 .2 2.4 1.3 3.4-1.8 0-3.2-.6-4.2-1.8-1.5 1.1-2.8 2.8-3.5 5.2-.9-.1-2.5.4-4.3 1.5Z",
      fill: color,
      "fill-opacity": "0.06",
    }),
    h("path", { d: "M3.5 3.5 20.5 20.5" }),
  ],
);

// D3: Geometric isometric hex-prism database glyph with duotone top facet.
export const DefaultDatabaseIcon = createWorkbenchIcon(
  ["lucide-database-icon", "wb-database-icon"],
  1.65,
  (color) => [
    h("path", {
      d: "M12 3.2 19.2 6.8v10.4L12 20.8 4.8 17.2V6.8L12 3.2Z",
      fill: color,
      "fill-opacity": "0.12",
    }),
    h("path", {
      d: "M12 3.2 19.2 6.8 12 10.4 4.8 6.8 12 3.2Z",
      fill: color,
      "fill-opacity": "0.28",
    }),
    h("path", { d: "M4.8 12 12 15.6 19.2 12" }),
  ],
);

// T3: Config-table grid with soft-tinted header row and primary-key column strip.
export const DefaultTableIcon = createWorkbenchIcon(
  ["lucide-table-icon", "wb-table-icon"],
  1.6,
  (color) => [
    h("path", {
      d: "M4 7.2A3 3 0 0 1 7 4.2h10a3 3 0 0 1 3 3v2.1H4V7.2Z",
      fill: color,
      "fill-opacity": "0.28",
      stroke: "none",
    }),
    h("path", {
      d: "M4 9.3h5.5v10.5H7a3 3 0 0 1-3-3V9.3Z",
      fill: color,
      "fill-opacity": "0.14",
      stroke: "none",
    }),
    h("rect", { x: "4", y: "4.2", width: "16", height: "15.6", rx: "3" }),
    h("path", { d: "M4 9.3h16M9.5 9.3v10.5M9.5 14.5h10.5" }),
  ],
);

export function connectionIconComponent(connection) {
  const closed = Boolean(connection?.closed);
  if (normalizeConnectionKind(connection?.kind) === CONNECTION_KINDS.mysql.kind) {
    return closed ? MysqlConnectionOffIcon : MysqlConnectionIcon;
  }
  return closed ? ServerOff : Server;
}
