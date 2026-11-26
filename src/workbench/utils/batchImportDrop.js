const SPREADSHEET_EXTENSION = /\.(xlsx|xls)$/i;
const EXCEL_LOCK_PREFIX = /^~\$/;
const IGNORABLE_SYSTEM_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const MAX_DIRECTORY_ENTRIES = 500;

function baseFileName(name) {
  const normalized = String(name || "").trim();
  if (!normalized) return "";
  const parts = normalized.split(/[/\\]/);
  return parts[parts.length - 1] || "";
}

export function isExcelLockFileName(name) {
  return EXCEL_LOCK_PREFIX.test(baseFileName(name));
}

export function isIgnorableDroppedFileName(name) {
  const base = baseFileName(name);
  if (!base) return true;
  return isExcelLockFileName(base) || IGNORABLE_SYSTEM_NAMES.has(base.toLowerCase());
}

export function isBatchImportSpreadsheetName(name) {
  const base = baseFileName(name);
  return Boolean(base) && !isExcelLockFileName(base) && SPREADSHEET_EXTENSION.test(base);
}

export function dataTransferHasFiles(dataTransfer) {
  if (!dataTransfer) return false;
  const types = Array.from(dataTransfer.types || []);
  if (types.includes("Files")) return true;
  if ((dataTransfer.files?.length || 0) > 0) return true;
  return Array.from(dataTransfer.items || []).some((item) => item?.kind === "file");
}

function readFileEntry(entry) {
  return new Promise((resolve) => {
    try {
      entry.file(
        (file) => resolve(file || null),
        () => resolve(null),
      );
    } catch {
      resolve(null);
    }
  });
}

async function readDirectoryDirectFiles(directoryEntry) {
  const reader = directoryEntry?.createReader?.();
  if (!reader) return [];
  const entries = [];
  while (entries.length < MAX_DIRECTORY_ENTRIES) {
    const batch = await new Promise((resolve) => {
      try {
        reader.readEntries(
          (list) => resolve(Array.isArray(list) ? list : []),
          () => resolve([]),
        );
      } catch {
        resolve([]);
      }
    });
    if (!batch.length) break;
    entries.push(...batch.slice(0, MAX_DIRECTORY_ENTRIES - entries.length));
  }
  const files = [];
  for (const child of entries) {
    if (!child?.isFile) continue;
    const file = await readFileEntry(child);
    if (file) files.push(file);
  }
  files.sort((left, right) =>
    String(left?.name || "").localeCompare(String(right?.name || ""), undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
  return files;
}

export async function extractDroppedBatchImportFiles(dataTransfer) {
  if (!dataTransfer) return [];
  const items = Array.from(dataTransfer.items || []);
  const snapshots = items.map((item) => ({
    entry: typeof item?.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null,
    file: item?.kind === "file" && typeof item.getAsFile === "function" ? item.getAsFile() : null,
  }));
  const hasDirectory = snapshots.some((snapshot) => snapshot.entry?.isDirectory);
  if (!hasDirectory) {
    return Array.from(dataTransfer.files || []).filter(Boolean);
  }
  const collected = [];
  for (const snapshot of snapshots) {
    if (snapshot.entry?.isDirectory) {
      const children = await readDirectoryDirectFiles(snapshot.entry);
      collected.push(...children);
    } else if (snapshot.entry?.isFile) {
      const file = await readFileEntry(snapshot.entry);
      if (file) collected.push(file);
    } else if (snapshot.file) {
      collected.push(snapshot.file);
    }
  }
  return collected;
}

export function planBatchImportDrop(files, currentMode = "workbook") {
  const normalizedMode = currentMode === "separate" ? "separate" : "workbook";
  const list = Array.from(files || []).filter(Boolean);
  const validFiles = [];
  let skippedCount = 0;

  for (const file of list) {
    const name = file?.name || "";
    if (isBatchImportSpreadsheetName(name)) {
      validFiles.push(file);
    } else if (!isIgnorableDroppedFileName(name)) {
      skippedCount += 1;
    }
  }

  if (!validFiles.length) {
    return {
      accepted: false,
      reason: "no-spreadsheet",
      files: [],
      mode: normalizedMode,
      switchedToSeparate: false,
      skippedCount,
    };
  }

  const switchedToSeparate = normalizedMode === "workbook" && validFiles.length > 1;
  const nextMode = switchedToSeparate ? "separate" : normalizedMode;
  return {
    accepted: true,
    reason: "",
    files: nextMode === "separate" ? validFiles : validFiles.slice(0, 1),
    mode: nextMode,
    switchedToSeparate,
    skippedCount,
  };
}
