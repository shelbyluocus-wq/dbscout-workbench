import fs from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

export function verifyOutput(directory) {
  for (const name of ['propKeyFile.ts', 'propLstFile.ts', 'propDataDefine.ts']) {
    if (!fs.readFileSync(path.join(directory, 'src/props', name), 'utf8').trim()) {
      throw new Error(`Missing or empty generated file: ${name}`);
    }
  }
  const all = JSON.parse(inflateSync(fs.readFileSync(path.join(directory, 'props/propsH5/props.bin'))));
  const names = Object.keys(all);
  if (!names.length) throw new Error('Empty configuration package');
  for (const name of names) {
    if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error("Invalid table name in package");
    const rows = JSON.parse(fs.readFileSync(path.join(directory, 'props/props', `${name}.json`), 'utf8'));
    if (JSON.stringify(rows) !== JSON.stringify(all[name])) throw new Error(`Inconsistent data: ${name}`);
  }
  return names.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    const count = verifyOutput(process.argv[2]);
    console.log(`Verified ${count} configuration tables (JSON and compressed package match).`);
  } catch (error) {
    console.error(`Output validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
