import { computed, ref } from "vue";

export const AGENT_PROJECTS_KEY = "dbscout-agent-projects";

function now() {
  return Date.now();
}

function readProjectsState() {
  try {
    const raw = globalThis.localStorage?.getItem?.(AGENT_PROJECTS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveProjectsState(state) {
  try {
    globalThis.localStorage?.setItem?.(AGENT_PROJECTS_KEY, JSON.stringify(state));
  } catch {
    // Browser storage can be unavailable in private mode; project selection is optional.
  }
}

function deriveId(path) {
  const id = String(path || "")
    .trim()
    .replace(/^[\\/]+/, "")
    .replace(/[:\\/]+/g, "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return id || `project-${now()}`;
}

function basename(path) {
  const parts = String(path || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || "项目文件夹";
}

export function normalizeAgentProject(raw) {
  if (!raw || typeof raw !== "object") return null;
  const path = String(raw.path || raw.rootPath || "").trim();
  if (!path) return null;
  const id = String(raw.id || deriveId(path));
  const name = String(raw.name || basename(path));
  return {
    id,
    name,
    path,
    shortPath: String(raw.shortPath || path),
    available: raw.available !== false,
    readOnly: true,
    error: raw.error ? String(raw.error) : "",
    lastSelectedAt: Number(raw.lastSelectedAt || now()),
  };
}

function loadInitialItems() {
  const saved = readProjectsState();
  const items = Array.isArray(saved?.items)
    ? saved.items.map(normalizeAgentProject).filter(Boolean)
    : [];
  const savedCurrentId = String(saved?.currentProjectId || "");
  return {
    items,
    currentProjectId: items.some((item) => item.id === savedCurrentId)
      ? savedCurrentId
      : String(items[0]?.id || ""),
  };
}

export function useAgentProjects(invokeWorkbench) {
  const initial = loadInitialItems();
  const items = ref(initial.items);
  const currentProjectId = ref(initial.currentProjectId);
  const isPicking = ref(false);
  const error = ref("");

  function persist() {
    saveProjectsState({
      currentProjectId: currentProjectId.value,
      items: items.value,
    });
  }

  const currentProject = computed(() => (
    items.value.find((item) => item.id === currentProjectId.value) || null
  ));

  const currentProjectForAgent = computed(() => {
    const project = currentProject.value;
    if (!project) return null;
    return {
      id: project.id,
      name: project.name,
      rootPath: project.path,
      shortPath: project.shortPath,
      readOnly: true,
      available: project.available !== false,
    };
  });

  function upsertProject(project) {
    const normalized = normalizeAgentProject(project);
    if (!normalized) return null;
    normalized.lastSelectedAt = now();
    const index = items.value.findIndex((item) => item.id === normalized.id);
    if (index >= 0) {
      items.value.splice(index, 1, { ...items.value[index], ...normalized });
    } else {
      items.value.push(normalized);
    }
    currentProjectId.value = normalized.id;
    error.value = "";
    persist();
    return normalized;
  }

  async function addProjectFromDirectory() {
    if (isPicking.value) return null;
    isPicking.value = true;
    error.value = "";
    try {
      const picked = await invokeWorkbench?.("agent_pick_project_directory", {});
      if (!picked) return null;
      return upsertProject(picked);
    } catch (err) {
      error.value = String(err?.message || err || "无法选择项目文件夹");
      return null;
    } finally {
      isPicking.value = false;
    }
  }

  function selectProject(id) {
    const next = items.value.find((item) => item.id === id);
    if (!next) return false;
    currentProjectId.value = next.id;
    next.lastSelectedAt = now();
    error.value = "";
    persist();
    return true;
  }

  function removeProject(id) {
    const index = items.value.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const wasCurrent = items.value[index].id === currentProjectId.value;
    items.value.splice(index, 1);
    if (wasCurrent) {
      currentProjectId.value = items.value[Math.min(index, items.value.length - 1)]?.id || "";
    }
    error.value = "";
    persist();
    return true;
  }

  async function refreshProjects() {
    const nextItems = [];
    for (const project of items.value) {
      try {
        const validated = await invokeWorkbench?.("agent_validate_project_directory", { path: project.path });
        const normalized = normalizeAgentProject(validated);
        nextItems.push(normalized
          ? { ...project, ...normalized, lastSelectedAt: project.lastSelectedAt }
          : project);
      } catch (err) {
        nextItems.push({
          ...project,
          available: false,
          error: String(err?.message || err || "无法访问项目文件夹"),
        });
      }
    }
    items.value = nextItems;
    if (currentProjectId.value && !items.value.some((item) => item.id === currentProjectId.value)) {
      currentProjectId.value = items.value[0]?.id || "";
    }
    persist();
  }

  return {
    items,
    currentProjectId,
    currentProject,
    currentProjectForAgent,
    isPicking,
    error,
    addProjectFromDirectory,
    upsertProject,
    selectProject,
    removeProject,
    refreshProjects,
  };
}
