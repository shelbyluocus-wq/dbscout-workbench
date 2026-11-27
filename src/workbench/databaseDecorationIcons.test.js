import assert from "node:assert/strict";
import test from "node:test";
import { Cloud, Server, ServerOff } from "lucide-vue-next";

import { DefaultDatabaseIcon } from "./components/DefaultDatabaseIcon.js";
import {
  DefaultTableIcon,
  MysqlConnectionIcon,
  MysqlConnectionOffIcon,
  connectionIconComponent,
} from "./components/workbenchIcons.js";
import {
  databaseDecorationIconComponent,
  databaseTableIconComponent,
} from "./components/databaseDecorationIcons.js";

test("database decoration icons share one resolver across databases and child tables", () => {
  assert.equal(databaseDecorationIconComponent("database"), DefaultDatabaseIcon);
  assert.equal(databaseDecorationIconComponent("cloud"), Cloud);
  assert.equal(databaseDecorationIconComponent("unknown"), DefaultDatabaseIcon);
  assert.equal(databaseTableIconComponent(null), DefaultTableIcon);
  assert.equal(databaseTableIconComponent({ icon: "cloud" }), Cloud);
});

test("default database icon renders the geometric duotone hex-prism SVG with Lucide-compatible props", () => {
  assert.equal(DefaultDatabaseIcon.length, 2);
  assert.equal(DefaultDatabaseIcon.inheritAttrs, false);
  const vnode = DefaultDatabaseIcon({ size: 15, strokeWidth: 1.65 }, { attrs: { class: "wb-tree-kind-icon" } });
  assert.equal(vnode.type, "svg");
  assert.equal(vnode.props.width, 15);
  assert.equal(vnode.props.height, 15);
  assert.equal(vnode.props["stroke-width"], 1.65);
  assert.ok(Array.isArray(vnode.children) && vnode.children.length === 3);
  assert.equal(vnode.children[0].type, "path");
  assert.ok(Number(vnode.children[0].props["fill-opacity"]) > 0);
  assert.ok(Number(vnode.children[1].props["fill-opacity"]) > 0);
  assert.equal(DefaultDatabaseIcon({ size: 18 }, null).props.width, 18);
});

test("default table icon renders the config-table SVG with tinted header and key column", () => {
  assert.equal(DefaultTableIcon.length, 2);
  assert.equal(DefaultTableIcon.inheritAttrs, false);
  const vnode = DefaultTableIcon({ size: 14 }, { attrs: { class: "wb-tree-kind-icon" } });
  assert.equal(vnode.type, "svg");
  assert.equal(vnode.props.width, 14);
  assert.equal(vnode.props.height, 14);
  assert.ok(Array.isArray(vnode.children) && vnode.children.length === 4);
  assert.ok(Number(vnode.children[0].props["fill-opacity"]) > 0);
  assert.ok(Number(vnode.children[1].props["fill-opacity"]) > 0);
  assert.equal(vnode.children[2].type, "rect");
  assert.equal(DefaultTableIcon({ size: 16 }, null).props.width, 16);
});

test("connectionIconComponent picks MySQL dolphin glyphs for MySQL and server glyphs for other engines", () => {
  assert.equal(MysqlConnectionIcon.length, 2);
  assert.equal(MysqlConnectionOffIcon.length, 2);
  assert.equal(connectionIconComponent({ kind: "mysql", closed: false }), MysqlConnectionIcon);
  assert.equal(connectionIconComponent({}), MysqlConnectionIcon);
  assert.equal(connectionIconComponent({ kind: "mysql", closed: true }), MysqlConnectionOffIcon);
  assert.equal(connectionIconComponent({ kind: "clickhouse", closed: false }), Server);
  assert.equal(connectionIconComponent({ kind: "clickhouse", closed: true }), ServerOff);
  assert.equal(connectionIconComponent({ kind: "mongodb", closed: false }), Server);
  assert.equal(connectionIconComponent({ kind: "mongodb", closed: true }), ServerOff);

  const openVnode = MysqlConnectionIcon({ size: 15 }, { attrs: { class: "wb-tree-kind-icon" } });
  assert.equal(openVnode.type, "svg");
  assert.ok(openVnode.props.class.includes("wb-mysql-icon"));
  const closedVnode = MysqlConnectionOffIcon({ size: 15 }, null);
  assert.ok(closedVnode.props.class.includes("is-closed-glyph"));
});
