<script setup>
import { computed, onBeforeUnmount, ref, watch } from "vue";

const props = defineProps({
  projects: { type: Object, default: null },
  disabled: { type: Boolean, default: false },
});

const open = ref(false);
const pickerRef = ref(null);
const menuRef = ref(null);
const menuStyle = ref({});

const items = computed(() => props.projects?.items?.value || []);
const currentProject = computed(() => props.projects?.currentProject?.value || null);
const hasProjects = computed(() => items.value.length > 0);
const unavailable = computed(() => currentProject.value?.available === false);
const isPicking = computed(() => Boolean(props.projects?.isPicking?.value));

const statusText = computed(() => {
  const current = currentProject.value;
  if (!current) return "未接入项目文件夹";
  if (current.available === false) return "项目不可用";
  return `项目：${current.name}`;
});

const detailText = computed(() => {
  const current = currentProject.value;
  if (props.disabled) return "Agent 完成后可切换项目";
  if (current?.error) return current.error;
  if (current?.shortPath) return current.shortPath;
  return "添加项目后，Agent 可只读查看项目文件";
});

function toggleOpen() {
  if (props.disabled) return;
  open.value = !open.value;
}

async function addProject() {
  if (props.disabled || isPicking.value) return;
  await props.projects?.addProjectFromDirectory?.();
  open.value = true;
}

function selectProject(id) {
  if (props.disabled) return;
  props.projects?.selectProject?.(id);
  open.value = false;
}

function removeProject(id, event) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
  if (props.disabled) return;
  props.projects?.removeProject?.(id);
}

function onRemoveKeydown(projectId, event) {
  if (event.key !== "Enter" && event.key !== " ") return;
  removeProject(projectId, event);
}

function updateMenuPosition() {
  const rect = pickerRef.value?.getBoundingClientRect?.();
  if (!rect) return;
  menuStyle.value = {
    top: `${Math.round(rect.bottom + 8)}px`,
    left: `${Math.round(rect.left)}px`,
    width: `${Math.round(rect.width)}px`,
  };
}

function onDocumentPointerDown(event) {
  if (pickerRef.value?.contains?.(event.target)) return;
  if (menuRef.value?.contains?.(event.target)) return;
  open.value = false;
}

function onDocumentKeydown(event) {
  if (event.key !== "Escape") return;
  open.value = false;
}

watch(open, (isOpen) => {
  if (isOpen) {
    updateMenuPosition();
    document.addEventListener("pointerdown", onDocumentPointerDown);
    document.addEventListener("keydown", onDocumentKeydown);
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
  } else {
    document.removeEventListener("pointerdown", onDocumentPointerDown);
    document.removeEventListener("keydown", onDocumentKeydown);
    window.removeEventListener("resize", updateMenuPosition);
    window.removeEventListener("scroll", updateMenuPosition, true);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocumentPointerDown);
  document.removeEventListener("keydown", onDocumentKeydown);
  window.removeEventListener("resize", updateMenuPosition);
  window.removeEventListener("scroll", updateMenuPosition, true);
});
</script>

<template>
  <div
    ref="pickerRef"
    class="wb-ai-project-picker"
    :class="{ 'is-open': open, 'is-disabled': disabled, 'is-unavailable': unavailable }"
  >
    <button
      type="button"
      class="wb-ai-project-trigger"
      :disabled="disabled"
      :aria-expanded="open"
      aria-label="选择 Agent 项目文件夹"
      @click="toggleOpen"
    >
      <svg
        class="wb-ai-project-folder"
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M3 7.5a2 2 0 0 1 2-2h4.2l2 2H19a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
        <path v-if="!hasProjects" d="M12 11v5M9.5 13.5h5" />
      </svg>
      <span class="wb-ai-project-copy">
        <strong>{{ statusText }}</strong>
        <small>{{ detailText }}</small>
      </span>
      <span v-if="currentProject" class="wb-ai-project-readonly">只读</span>
      <svg
        class="wb-ai-project-chevron"
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>

    <Teleport defer to=".mysql-workbench">
      <section
        v-if="open"
        ref="menuRef"
        class="wb-ai-project-menu"
        :style="menuStyle"
        aria-label="项目文件夹列表"
      >
        <p v-if="disabled" class="wb-ai-project-disabled-note">Agent 完成后可切换项目</p>
        <button
          type="button"
          class="wb-ai-project-add"
          :disabled="disabled || projects?.isPicking?.value"
          @click="addProject"
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          {{ isPicking ? "正在选择…" : "添加项目文件夹" }}
        </button>

        <div v-if="items.length" class="wb-ai-project-list">
          <button
            v-for="project in items"
            :key="project.id"
            type="button"
            class="wb-ai-project-item"
            :class="{ 'is-current': project.id === currentProject?.id, 'is-unavailable': project.available === false }"
            :disabled="disabled"
            @click="selectProject(project.id)"
          >
            <span class="wb-ai-project-current-dot" aria-hidden="true"></span>
            <span class="wb-ai-project-item-copy">
              <strong>{{ project.available === false ? "项目不可用" : project.name }}</strong>
              <small>{{ project.error || project.shortPath || project.path }}</small>
            </span>
            <span class="wb-ai-project-readonly">只读</span>
            <span
              class="wb-ai-project-remove"
              role="button"
              tabindex="0"
              aria-label="移除项目文件夹"
              @click="removeProject(project.id, $event)"
              @keydown="onRemoveKeydown(project.id, $event)"
            >移除</span>
          </button>
        </div>
        <p v-else class="wb-ai-project-empty">添加项目后，Agent 可以读取项目内文件并辅助理解代码。</p>
      </section>
    </Teleport>
  </div>
</template>
