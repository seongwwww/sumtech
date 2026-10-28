const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./project-fixtures.cjs');

test('explicit project mismatch fails before any report state is written; frozen launch selection cannot redirect', async (t) => {
  const f = await fixture(t);
  for (const name of ['alpha', 'beta']) {
    assert.match(f.run(name, `import assert from 'node:assert/strict';
      import {project,selectProject,stateDirectory} from './projects.mjs';
      import {validateTask} from './receive-mentions.mjs';
      import {validateWatchConfig} from './notifications.mjs';
      const other=project.name==='alpha'?'beta':'alpha';
      const task={project:project.name,task_id:'P001',repository:project.repository,title:'task',status:'in_progress',summary:'summary',changed_files:[],tests:{status:'not_run'}};
      assert.equal(validateTask(task).channel,project.report_channel);
      assert.throws(()=>validateTask({...task,project:other}),/project must match/);
      assert.throws(()=>validateTask({...task,repository:'team/'+other}),/Task needs/);
      assert.throws(()=>validateWatchConfig({repository:'team/'+other,channel:project.report_channel,tasks:[{task_id:'P001'}]}),/Invalid/);
      const snapshot=JSON.stringify(project);process.env.BUZZ_PROJECT=other;
      assert.equal(selectProject({...process.env,BUZZ_PROJECT_SNAPSHOT:snapshot},['node','--project',other]).name,project.name);
      assert.ok(stateDirectory().endsWith(project.name));console.log('ISOLATION_REJECTION_PASS');`), /ISOLATION_REJECTION_PASS/);
    await assert.rejects(fs.stat(path.join(f.dir, 'BuzzBridge/projects', name, 'tasks')), /ENOENT/);
  }
});
