import { readdir } from "node:fs/promises";
import path from "node:path";

const TEST_FILE_PATTERN = /\.test\.(?:js|mjs)$/;

function compareNames(left, right) {
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}

export async function collectTestFiles(
  rootDirectory,
  { ignoredDirectories = new Set() } = {},
) {
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort(compareNames);

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await visit(entryPath);
        }
      } else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
        files.push(entryPath);
      }
    }
  }

  await visit(path.resolve(rootDirectory));
  return files.sort();
}
