<script setup>
const props = defineProps({
  kind: { type: String, default: "tableName" },
  subtle: { type: Boolean, default: false },
  label: { type: String, default: "" },
});

const labels = {
  tableName: "表名",
  tableComment: "表备注",
  columnName: "字段",
  columnComment: "字段备注",
  value: "值",
};
</script>

<template>
  <span
    class="wb-search-hit-badge"
    :class="[`is-${props.kind}`, { 'is-subtle': props.subtle }]"
  >{{ props.label || labels[props.kind] || "结构" }}</span>
</template>
