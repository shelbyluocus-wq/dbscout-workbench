import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { verifyOutput } from './verify-output.mjs';

test('rejects incomplete or inconsistent packages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-check-'));
  try {
    for (const dir of ['src/props', 'props/props', 'props/propsH5']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    assert.throws(() => verifyOutput(root));
    for (const file of ['propKeyFile.ts', 'propLstFile.ts', 'propDataDefine.ts']) fs.writeFileSync(path.join(root, 'src/props', file), 'export const sample = {};');
    fs.writeFileSync(path.join(root, 'props/propsH5/props.bin'), deflateSync(JSON.stringify({ heroprop: [{ id: 1 }] })));
    assert.throws(() => verifyOutput(root));
    fs.writeFileSync(path.join(root, 'props/props/heroprop.json'), '[{"id":2}]');
    assert.throws(() => verifyOutput(root), /Inconsistent/);
    fs.writeFileSync(path.join(root, 'props/props/heroprop.json'), '[{"id":1}]');
    assert.equal(verifyOutput(root), 1);
    fs.writeFileSync(path.join(root, 'props/propsH5/props.bin'), deflateSync('{}'));
    assert.throws(() => verifyOutput(root), /Empty/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('launcher rejects a zero exit without completion and refuses stale output', async () => {
  const { spawnSync } = await import('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-'));
  try {
    const cwd = path.join(root, 'tools', 'launch', 'client');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(root, 'tools/node_modules/ts-node'), { recursive: true });
    for (const file of ['genPropCli.ts', 'propcfg.json', 'node_modules/ts-node/esm.mjs']) fs.writeFileSync(path.join(root, 'tools', file), '');
    fs.copyFileSync(new URL('./juesheng2-macos.command', import.meta.url), path.join(cwd, 'convert.command'));
    fs.writeFileSync(path.join(cwd, 'verify-output.mjs'), '');
    const node = path.join(bin, 'node');
    const run = () => spawnSync('/bin/bash', [path.join(cwd, 'convert.command')], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } });
    fs.writeFileSync(node, '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    let result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /did not complete/);
    fs.mkdirSync(path.join(cwd, 'newsg_4cfg/2026-10-21 01-02-03'), { recursive: true });
    fs.writeFileSync(node, '#!/bin/bash\nif [[ "$1" == "--loader" ]]; then echo "genBinProp end"; fi\nexit 0\n');
    result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /older package/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
