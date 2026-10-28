const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fixture } = require('./project-fixtures.cjs');

test('new project requires only repo/relay/channels plus a name; npm caller directory is the default workspace', async (t) => {
  const f = await fixture(t);
  const checkout = path.join(f.dir,'gamma external checkout');await fs.mkdir(checkout);
  const { windowsPowerShellEnv }=await import('../windows-env.mjs');
  const output=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    '& npm.cmd --prefix $env:BUZZ_TEST_INSTALL run project -- add gamma --repo https://github.com/team/gamma.git --relay wss://gamma.example/ --channels gamma-reports; exit $LASTEXITCODE'],
    {cwd:checkout,env:{...windowsPowerShellEnv(f.env),BUZZ_TEST_INSTALL:f.cwd},encoding:'utf8',windowsHide:true,timeout:30000});
  assert.match(output,/Added gamma/);
  const registry=JSON.parse(await fs.readFile(path.join(f.dir,'BuzzBridge/projects.json'),'utf8'));
  assert.equal(await fs.realpath(registry.projects.gamma.workspace),await fs.realpath(checkout));
  assert.equal(registry.projects.gamma.repository,'team/gamma');
  assert.equal(registry.projects.gamma.report_channel,'gamma-reports');
  assert.equal(registry.projects.gamma.origin,'https://gamma.example');
  assert.deepEqual(JSON.parse(f.cli('list')).projects,['legacy','alpha','beta','gamma']);
  await assert.rejects(fs.stat(path.join(checkout,'node_modules')),/ENOENT/);
});

test('Korean guide documents one install, two projects, explicit routing and external membership approval', async () => {
  const readme=await fs.readFile(path.resolve(__dirname,'../README.ko.md'),'utf8');
  for(const word of ['alpha','beta','--project','--repo','--relay','--channels','connect','legacy','멤버','한 번','INIT_CWD']) assert.ok(readme.includes(word),word);
});
