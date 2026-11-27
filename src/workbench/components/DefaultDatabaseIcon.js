import { h } from "vue";

// Modern duotone stacked-platter database glyph: a soft-tinted top cap over
// two floating curved tiers, matching Lucide's prop contract while reading
// lighter and cleaner than a closed wireframe cylinder at small tree sizes.
// Keep 2 explicit non-defaulted parameters so Vue 3 sees `.length === 2` and
// always supplies the functional component context (`{ attrs }`).
export function DefaultDatabaseIcon(props, context) {
  const safeProps = props || {};
  const attrs = context?.attrs || {};
  const size = safeProps.size ?? attrs.size ?? 24;
  const color = safeProps.color ?? attrs.color ?? "currentColor";
  const rawStrokeWidth = Number(safeProps.strokeWidth ?? attrs.strokeWidth ?? attrs["stroke-width"] ?? 1.65);
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
      class: ["lucide", "lucide-database-icon", "wb-database-icon", extraClass],
    },
    [
      h("ellipse", {
        cx: "12",
        cy: "6",
        rx: "7.5",
        ry: "2.75",
        fill: color,
        "fill-opacity": "0.28",
      }),
      h("path", {
        d: "M4.5 6v3.6c0 1.52 3.36 2.75 7.5 2.75s7.5-1.23 7.5-2.75V6",
        fill: color,
        "fill-opacity": "0.11",
      }),
      h("path", {
        d: "M4.5 13.6c0 1.52 3.36 2.75 7.5 2.75s7.5-1.23 7.5-2.75",
      }),
      h("path", {
        d: "M4.5 17.6c0 1.52 3.36 2.75 7.5 2.75s7.5-1.23 7.5-2.75",
      }),
    ],
  );
}

DefaultDatabaseIcon.inheritAttrs = false;

DefaultDatabaseIcon.props = {
  size: { type: [Number, String], default: 24 },
  color: { type: String, default: "currentColor" },
  strokeWidth: { type: [Number, String], default: 1.65 },
  absoluteStrokeWidth: { type: Boolean, default: false },
};

export default DefaultDatabaseIcon;
