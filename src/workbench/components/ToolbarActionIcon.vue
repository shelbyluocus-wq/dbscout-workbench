<script setup>
import { computed } from "vue";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Ellipsis,
  PanelLeft,
  PanelTop,
  PanelTopClose,
  PanelsTopLeft,
  Replace,
  SquareTerminal,
} from "lucide-vue-next";

const props = defineProps({
  name: { type: String, required: true },
  size: { type: Number, default: 15 },
});

const iconComponents = {
  freeze: PanelsTopLeft,
  export: ArrowDownToLine,
  import: ArrowUpFromLine,
  replace: Replace,
  sql: SquareTerminal,
  more: Ellipsis,
  "split-right": PanelLeft,
  "split-down": PanelTop,
  "freeze-cell": PanelsTopLeft,
  "freeze-row": PanelTop,
  "freeze-column": PanelLeft,
  unfreeze: PanelTopClose,
};

const iconComponent = computed(() => iconComponents[props.name] || null);
</script>

<template>
  <span v-if="iconComponent" class="wb-toolbar-action-icon" aria-hidden="true">
    <component :is="iconComponent" :size="size" :stroke-width="1.45" />
  </span>
</template>
