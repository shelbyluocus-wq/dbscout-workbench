import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile as defaultCopyFile, rename, stat } from "node:fs/promises";

export async function ensureNativeBinaryResource(source, dest, options = {}) {
  if (await sameFileContents(source, dest)) {
    const { size } = await stat(dest);
    return { action: "skipped", path: dest, size };
  }

  const copyFile = options.copyFile || defaultCopyFile;
  const tempDest = `${dest}.${process.pid}.${randomUUID()}.tmp`;
  await copyFile(source, tempDest);
  await rename(tempDest, dest);
  const { size } = await stat(dest);
  return { action: "copied", path: dest, size };
}

async function sameFileContents(left, right) {
  let leftStat;
  let rightStat;
  try {
    [leftStat, rightStat] = await Promise.all([stat(left), stat(right)]);
  } catch {
    return false;
  }

  if (leftStat.size !== rightStat.size) {
    return false;
  }

  const [leftHash, rightHash] = await Promise.all([fileHash(left), fileHash(right)]);
  return leftHash === rightHash;
}

function fileHash(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
