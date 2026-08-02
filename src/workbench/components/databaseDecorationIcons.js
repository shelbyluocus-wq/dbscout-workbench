import {
  Archive,
  Boxes,
  Cloud,
  Database,
  FlaskConical,
  Rocket,
  ShieldCheck,
  Star,
  Table2,
} from "lucide-vue-next";

const ICON_COMPONENTS = Object.freeze({
  database: Database,
  boxes: Boxes,
  shield: ShieldCheck,
  flask: FlaskConical,
  rocket: Rocket,
  archive: Archive,
  star: Star,
  cloud: Cloud,
});

export function databaseDecorationIconComponent(icon) {
  return ICON_COMPONENTS[String(icon || "")] || Database;
}

export function databaseTableIconComponent(decoration) {
  return decoration
    ? databaseDecorationIconComponent(decoration.icon)
    : Table2;
}
