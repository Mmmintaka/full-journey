const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');

const directory = mkdtempSync(join(tmpdir(), 'task-integration-'));
let server;
const start = (postgres, serverless = false) => new Promise((resolve, reject) => {
  const env = { ...process.env, NODE_ENV: 'test', PORT: '4139', DATABASE_PATH: join(directory, 'tasks.sqlite') };
  if (serverless) env.VERCEL = '1'; else delete env.VERCEL;
  if (postgres) { env.DATABASE_URL = 'postgres://mock/test'; env.NODE_OPTIONS = `--require=${join(__dirname, 'pg-mem-preload.cjs')}`; }
  else { delete env.DATABASE_URL; delete env.NODE_OPTIONS; }
  server = spawn(process.execPath, [join(__dirname, serverless ? 'vercel-local.cjs' : '../dist/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  server.stderr.on('data', (chunk) => { errors += chunk; });
  const timer = setTimeout(() => reject(new Error(`启动超时：${errors}`)), 8000);
  server.stdout.once('data', () => { clearTimeout(timer); resolve(); });
  server.once('exit', (code) => { clearTimeout(timer); if (code) reject(new Error(`服务退出：${errors}`)); });
});
const stop = () => new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
const call = (path, options) => fetch(`http://localhost:4139${path}`, options);
const request = (method, body, cookie) => ({ method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
async function run(postgres, serverless = false) {
  await start(postgres, serverless);
  let result = await call('/tasks'); assert.equal(result.status, 401);
  for (const username of ['alice', 'bobby']) {
    result = await call('/auth/register', request('POST', { username, password: 'password123' })); assert.equal(result.status, 201);
  }
  result = await call('/auth/login', request('POST', { username: 'alice', password: 'password123' })); assert.equal(result.status, 200); const alice = result.headers.get('set-cookie').split(';')[0];
  result = await call('/auth/login', request('POST', { username: 'bobby', password: 'password123' })); assert.equal(result.status, 200); const bobby = result.headers.get('set-cookie').split(';')[0];
  result = await call('/tasks', request('POST', { title: '测试任务' }, alice)); assert.equal(result.status, 201); const task = await result.json();
  result = await call('/tasks', request('GET', null, bobby)); assert.deepEqual(await result.json(), []);
  result = await call(`/tasks/${task.id}`, request('PATCH', { completed: true }, bobby)); assert.equal(result.status, 404);
  result = await call(`/tasks/${task.id}`, request('DELETE', null, bobby)); assert.equal(result.status, 404);
  result = await call(`/tasks/${task.id}`, request('PATCH', { completed: true }, alice)); assert.equal(result.status, 200); assert.equal((await result.json()).completed, true);
  result = await call('/tasks', request('GET', null, alice)); assert.equal((await result.json()).length, 1);
  for (let i = 0; i < 6; i++) {
    result = await call('/tasks', request('POST', { title: `分页任务 ${i}` }, alice)); assert.equal(result.status, 201);
  }
  result = await call('/tasks?status=active&page=1&pageSize=3', request('GET', null, alice)); assert.equal(result.status, 200);
  const first = await result.json(); assert.equal(first.total, 6); assert.equal(first.totalPages, 2); assert.equal(first.items.length, 3); assert.deepEqual(first.counts, { all: 7, active: 6, completed: 1 });
  result = await call('/tasks?status=active&page=2&pageSize=3', request('GET', null, alice)); const second = await result.json(); assert.equal(second.items.length, 3);
  assert.equal(new Set([...first.items, ...second.items].map(t => t.id)).size, 6);
  result = await call('/tasks?status=completed&page=1&pageSize=2', request('GET', null, alice)); const completed = await result.json(); assert.equal(completed.total, 1); assert.equal(completed.items[0].id, task.id);
  result = await call('/tasks?status=active&page=2&pageSize=2&search=' + encodeURIComponent('分页任务'), request('GET', null, alice));
  assert.equal(result.status, 200); const searched = await result.json(); assert.equal(searched.search, '分页任务'); assert.equal(searched.total, 6); assert.equal(searched.items.length, 2); assert.deepEqual(searched.counts, { all: 6, active: 6, completed: 0 });
  result = await call('/tasks?search=' + encodeURIComponent('分页任务'), request('GET', null, bobby)); assert.equal((await result.json()).total, 0);
  result = await call('/tasks?search=' + encodeURIComponent('%'), request('GET', null, alice)); assert.equal((await result.json()).total, 0);
  result = await call('/tasks?status=all&page=99&pageSize=3', request('GET', null, alice)); assert.equal((await result.json()).page, 3);
  result = await call('/tasks?status=active&page=1&pageSize=3', request('GET', null, bobby)); assert.deepEqual((await result.json()).counts, {all:0, active:0, completed:0});
  for (const query of ['status=wrong', 'page=0', 'pageSize=51', 'page=1&page=2', 'search=a&search=b', 'search=' + 'x'.repeat(101)]) {
    result = await call(`/tasks?${query}`, request('GET', null, alice)); assert.equal(result.status, 400);
  }
  for (const item of second.items) { result = await call(`/tasks/${item.id}`, request('DELETE', null, alice)); assert.equal(result.status, 204); }
  result = await call('/tasks?status=active&page=2&pageSize=3', request('GET', null, alice)); const clamped = await result.json(); assert.equal(clamped.page, 1); assert.equal(clamped.totalPages, 1);
  result = await call('/auth/logout', request('POST', null, alice)); assert.equal(result.status, 204);
  result = await call('/tasks', request('GET', null, alice)); assert.equal(result.status, 401);
  await stop();
  console.log(`${serverless ? 'Vercel handler + ' : ''}${postgres ? 'PostgreSQL 模拟器' : 'SQLite'}：认证、筛选、分页及权限隔离通过`);
}
(async () => {
  try { await run(false); await run(true); await run(true, true); }
  catch (error) { console.error(error); process.exitCode = 1; }
  finally { if (server && server.exitCode === null && !server.killed) await stop(); rmSync(directory, { recursive: true, force: true }); }
})();
