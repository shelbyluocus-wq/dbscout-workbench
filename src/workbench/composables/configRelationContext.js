import { inject } from "vue";

// Provided by the workbench root so deeply nested grids can clear a relation
// filter without a prop chain through the split layout.
export const CONFIG_RELATION_CONTEXT = Symbol("config-relation-context");

export function useConfigRelationContext() {
  return inject(CONFIG_RELATION_CONTEXT, null);
}
