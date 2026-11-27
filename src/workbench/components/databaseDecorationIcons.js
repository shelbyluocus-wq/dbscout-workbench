import {
  Archive,
  Boxes,
  Cloud,
  FlaskConical,
  Rocket,
  ShieldCheck,
  Star,
  Table2,
} from "lucide-vue-next";
import { DefaultDatabaseIcon } from "./DefaultDatabaseIcon.js";

const ICON_COMPONENTS = Object.freeze({
  database: DefaultDatabaseIcon,
  boxes: Boxes,
  shield: ShieldCheck,
  flask: FlaskConical,
  rocket: Rocket,
  archive: Archive,
  star: Star,
  cloud: Cloud,
});

export function databaseDecorationIconComponent(icon) {
  return ICON_COMPONENTS[String(icon || "")] || DefaultDatabaseIcon;
}

export function databaseTableIconComponent(decoration) {
  return decoration
    ? databaseDecorationIconComponent(decoration.icon)
    : Table2;
}
