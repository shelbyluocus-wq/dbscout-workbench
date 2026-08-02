import assert from "node:assert/strict";
import test from "node:test";
import { Cloud, Database, Table2 } from "lucide-vue-next";

import {
  databaseDecorationIconComponent,
  databaseTableIconComponent,
} from "./components/databaseDecorationIcons.js";

test("database decoration icons share one resolver across databases and child tables", () => {
  assert.equal(databaseDecorationIconComponent("cloud"), Cloud);
  assert.equal(databaseDecorationIconComponent("unknown"), Database);
  assert.equal(databaseTableIconComponent(null), Table2);
  assert.equal(databaseTableIconComponent({ icon: "cloud" }), Cloud);
});
