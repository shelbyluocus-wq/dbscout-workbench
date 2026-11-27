import assert from "node:assert/strict";
import test from "node:test";
import { Cloud, Table2 } from "lucide-vue-next";

import { DefaultDatabaseIcon } from "./components/DefaultDatabaseIcon.js";
import {
  databaseDecorationIconComponent,
  databaseTableIconComponent,
} from "./components/databaseDecorationIcons.js";

test("database decoration icons share one resolver across databases and child tables", () => {
  assert.equal(databaseDecorationIconComponent("database"), DefaultDatabaseIcon);
  assert.equal(databaseDecorationIconComponent("cloud"), Cloud);
  assert.equal(databaseDecorationIconComponent("unknown"), DefaultDatabaseIcon);
  assert.equal(databaseTableIconComponent(null), Table2);
  assert.equal(databaseTableIconComponent({ icon: "cloud" }), Cloud);
});

test("default database icon renders a modern duotone stacked-platter SVG with Lucide-compatible props", () => {
  assert.equal(DefaultDatabaseIcon.length, 2);
  const vnode = DefaultDatabaseIcon({ size: 15, strokeWidth: 1.65 }, { attrs: { class: "wb-tree-kind-icon" } });
  assert.equal(vnode.type, "svg");
  assert.equal(vnode.props.width, 15);
  assert.equal(vnode.props.height, 15);
  assert.equal(vnode.props["stroke-width"], 1.65);
  assert.ok(Array.isArray(vnode.children) && vnode.children.length === 4);
  assert.equal(vnode.children[0].type, "ellipse");
  assert.ok(Number(vnode.children[0].props["fill-opacity"]) > 0);
  assert.equal(DefaultDatabaseIcon({ size: 18 }, null).props.width, 18);
});
