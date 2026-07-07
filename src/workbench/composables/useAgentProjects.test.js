import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { nextTick } from "vue";
import { mockWorkbenchInvoke } from "../mock/mockBackend.js";
import { useAgentProjects } from "./useAgentProjects.js";

function installMemoryStorage(seed = {}) {
  const store = new Map(Object.entries(seed));
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  return store;
}

describe("useAgentProjects", () => {
  afterEach(() => {
    delete globalThis.localStorage;
  });

  it("adds a picked project, selects it, and persists it", async () => {
    const store = installMemoryStorage();
    const calls = [];
    const projects = useAgentProjects(async (command, payload) => {
      calls.push({ command, payload });
      if (command === "agent_pick_project_directory") {
        return {
          id: "e-project-dbscout-workbench",
          name: "dbscout-workbench",
          path: "E:/project/dbscout-workbench",
          shortPath: "E:/project/dbscout-workbench",
          available: true,
          readOnly: true,
        };
      }
      return null;
    });

    const added = await projects.addProjectFromDirectory();
    await nextTick();

    assert.equal(added?.name, "dbscout-workbench");
    assert.equal(projects.items.value.length, 1);
    assert.equal(projects.currentProject.value.name, "dbscout-workbench");
    assert.equal(projects.currentProjectForAgent.value.rootPath, "E:/project/dbscout-workbench");
    assert.equal(projects.currentProjectForAgent.value.readOnly, true);
    assert.equal(calls[0].command, "agent_pick_project_directory");

    const saved = JSON.parse(store.get("dbscout-agent-projects"));
    assert.equal(saved.currentProjectId, "e-project-dbscout-workbench");
    assert.equal(saved.items[0].path, "E:/project/dbscout-workbench");
  });

  it("keeps the existing list when the user cancels folder picking", async () => {
    installMemoryStorage({
      "dbscout-agent-projects": JSON.stringify({
        currentProjectId: "existing",
        items: [{
          id: "existing",
          name: "existing-app",
          path: "E:/existing-app",
          shortPath: "E:/existing-app",
          available: true,
          readOnly: true,
          lastSelectedAt: 1,
        }],
      }),
    });
    const projects = useAgentProjects(async () => null);

    const added = await projects.addProjectFromDirectory();

    assert.equal(added, null);
    assert.equal(projects.items.value.length, 1);
    assert.equal(projects.currentProject.value.name, "existing-app");
  });

  it("deduplicates by id and moves a re-picked project to current", async () => {
    installMemoryStorage({
      "dbscout-agent-projects": JSON.stringify({
        currentProjectId: "one",
        items: [{
          id: "one",
          name: "one",
          path: "E:/one",
          shortPath: "E:/one",
          available: true,
          readOnly: true,
          lastSelectedAt: 1,
        }],
      }),
    });
    const projects = useAgentProjects(async () => ({
      id: "one",
      name: "one-renamed",
      path: "E:/one",
      shortPath: "E:/one",
      available: true,
      readOnly: true,
    }));

    await projects.addProjectFromDirectory();

    assert.equal(projects.items.value.length, 1);
    assert.equal(projects.items.value[0].name, "one-renamed");
    assert.equal(projects.currentProject.value.id, "one");
  });

  it("keeps mock project IDs distinct for collision-prone validated paths", async () => {
    const unicodeOne = await mockWorkbenchInvoke("agent_validate_project_directory", { path: "D:/项目一" });
    const unicodeTwo = await mockWorkbenchInvoke("agent_validate_project_directory", { path: "D:/项目二" });
    const hyphen = await mockWorkbenchInvoke("agent_validate_project_directory", { path: "C:/foo-bar" });
    const nested = await mockWorkbenchInvoke("agent_validate_project_directory", { path: "C:/foo/bar" });

    assert.notEqual(unicodeOne.id, unicodeTwo.id);
    assert.notEqual(hyphen.id, nested.id);
    assert.match(unicodeOne.id, /^d-项目一-[0-9a-f]{16}$/);
    assert.match(hyphen.id, /^c-foo-bar-[0-9a-f]{16}$/);
    assert.match(nested.id, /^c-foo-bar-[0-9a-f]{16}$/);
  });

  it("selects the next project when removing the current project", () => {
    installMemoryStorage({
      "dbscout-agent-projects": JSON.stringify({
        currentProjectId: "two",
        items: [
          { id: "one", name: "one", path: "E:/one", shortPath: "E:/one", available: true, readOnly: true, lastSelectedAt: 1 },
          { id: "two", name: "two", path: "E:/two", shortPath: "E:/two", available: true, readOnly: true, lastSelectedAt: 2 },
        ],
      }),
    });
    const projects = useAgentProjects(async () => null);

    projects.removeProject("two");

    assert.equal(projects.items.value.length, 1);
    assert.equal(projects.currentProject.value.id, "one");
  });

  it("refreshes persisted projects with validation results", async () => {
    installMemoryStorage({
      "dbscout-agent-projects": JSON.stringify({
        currentProjectId: "gone",
        items: [{
          id: "gone",
          name: "gone",
          path: "E:/gone",
          shortPath: "E:/gone",
          available: true,
          readOnly: true,
          lastSelectedAt: 1,
        }],
      }),
    });
    const projects = useAgentProjects(async (command, payload) => {
      assert.equal(command, "agent_validate_project_directory");
      assert.equal(payload.path, "E:/gone");
      return {
        id: "gone",
        name: "gone",
        path: "E:/gone",
        shortPath: "E:/gone",
        available: false,
        readOnly: true,
        error: "项目文件夹不存在",
      };
    });

    await projects.refreshProjects();

    assert.equal(projects.currentProject.value.available, false);
    assert.equal(projects.currentProject.value.error, "项目文件夹不存在");
    assert.equal(projects.currentProjectForAgent.value.available, false);
  });
});
