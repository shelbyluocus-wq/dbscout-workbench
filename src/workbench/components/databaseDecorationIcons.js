import {
  Archive,
  Boxes,
  Cloud,
  FlaskConical,
  Rocket,
  ShieldCheck,
  Star,
} from "lucide-vue-next";
import {
  DefaultDatabaseIcon,
  DefaultTableIcon,
  connectionIconComponent,
} from "./workbenchIcons.js";

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

export { connectionIconComponent };

export function databaseDecorationIconComponent(icon) {
  return ICON_COMPONENTS[String(icon || "")] || DefaultDatabaseIcon;
}

export function databaseTableIconComponent(decoration) {
  return decoration
    ? databaseDecorationIconComponent(decoration.icon)
    : DefaultTableIcon;
}
