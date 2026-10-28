const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { environment } = require('./helpers.cjs');
test('corrected delivery Seed declares every source/test/document deliverable and all artifacts exist', async () => {
  const root = path.resolve(__dirname, '../..');
  const seed = JSON.parse(await fs.readFile(path.join(root, 'buzz-bridge/delivery.seed.json'), 'utf8'));
  assert.notEqual(seed.id, 'seed_d209e78e5d5f');
  for (const name of ['report-workflow', 'context-answer-workflow', 'notification-workflow', 'compatibility', 'rollout-kit', 'source-delivery']) assert.ok(seed.expected_artifacts.includes(`buzz-bridge/test/${name}.test.cjs`));
  const walk = async (dir) => {
    const result = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git'].includes(entry.name) || entry.name === 'local.json' || entry.name.endsWith('.local.json')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) result.push(...await walk(full)); else result.push(path.relative(root, full).replaceAll('\\', '/'));
    }
    return result;
  };
  const actual = await walk(path.join(root, 'buzz-bridge'));
  assert.deepEqual([...seed.expected_artifacts].sort(), actual.sort());
  for (const file of seed.expected_artifacts) assert.ok((await fs.stat(path.join(root, file))).isFile(), file);
});
test('source archive contains declared artifacts, excludes keys/dependencies/state, and has valid SHA256', async (t) => {
  const dir = await environment(t);
  const { packSource } = await import('../scripts/pack-source.mjs');
  const output = path.join(dir, 'delivery.zip');
  const result = await packSource(output);
  assert.equal(result.sha256.length, 64);
  const { execFileSync } = require('node:child_process');
  const listing = execFileSync('tar.exe', ['-tf', output], { encoding: 'utf8', windowsHide: true }).replaceAll('\\', '/');
  assert.match(listing, /buzz-bridge\/test\/report-workflow.test.cjs/);
  assert.match(listing, /buzz-bridge\/README.ko.md/);
  assert.doesNotMatch(listing, /node_modules|\.identity\.json|stdout\.log|runner\.json/);
  const crypto = require('node:crypto');
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(output)).digest('hex'), result.sha256);
});
