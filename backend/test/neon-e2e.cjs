// 使用独立随机测试账号验证真实 Neon 数据库；结束时只清理本次创建的数据。
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createServer } = require('node:net');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { secureConnectionString } = require('../dist/postgres');

for (const name of ['.env.local', '.env']) {
  try { process.loadEnvFile(name); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (!process.env.DATABASE_URL) throw new Error('未找到 DATABASE_URL。');
const pool = new Pool({ connectionString: secureConnectionString(process.env.DATABASE_URL), connectionTimeoutMillis: 10000 });
const suffix = randomBytes(6).toString('hex');
const usernames = [`e2ea_${suffix}`, `e2eb_${suffix}`];
const password = randomBytes(24).toString('hex');
let server;
let backendErrors = '';
let users = [];
const findPort = () => new Promise((resolve, reject) => {
  const listener = createServer(); listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => { const { port } = listener.address(); listener.close(() => resolve(port)); });
});
(async () => {
  try {
    const port = await findPort();
    server = spawn(process.execPath, ['backend/dist/index.js'], { env: { ...process.env, NODE_ENV: 'development', PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', (chunk) => { backendErrors += String(chunk); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('后端启动超时')), 30000);
      server.stdout.once('data', () => { clearTimeout(timer); resolve(); });
      server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`后端提前退出，代码 ${code}`)); });
    });
    const call = (path, options) => fetch(`http://127.0.0.1:${port}${path}`, options);
    const options = (method, body, cookie) => ({ method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    let response = await call('/health'); assert.equal(response.status, 200);
    response = await call('/tasks'); assert.equal(response.status, 401);
    const cookies = [];
    for (const username of usernames) {
      response = await call('/auth/register', options('POST', { username, password })); assert.equal(response.status, 201);
      const created = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
      users.push(created.rows[0].id);
      response = await call('/auth/login', options('POST', { username, password })); assert.equal(response.status, 200);
      const user = await response.json(); assert.equal(user.id, users[users.length - 1]);
      cookies.push(response.headers.get('set-cookie').split(';')[0]);
    }
    response = await call('/tasks', options('POST', { title: 'Neon 临时验证任务' }, cookies[0])); assert.equal(response.status, 201); const task = await response.json();
    response = await call('/tasks', options('GET', null, cookies[1])); assert.deepEqual(await response.json(), []);
    response = await call(`/tasks/${task.id}`, options('PATCH', { completed: true }, cookies[1])); assert.equal(response.status, 404);
    response = await call(`/tasks/${task.id}`, options('PATCH', { completed: true }, cookies[0])); assert.equal(response.status, 200); assert.equal((await response.json()).completed, true);
    for (let i = 0; i < 5; i++) {
      response = await call('/tasks', options('POST', { title: `分页测试 ${i}` }, cookies[0])); assert.equal(response.status, 201);
    }
    response = await call('/tasks?status=active&page=2&pageSize=3', options('GET', null, cookies[0]));
    assert.equal(response.status, 200); const activePage = await response.json();
    assert.equal(activePage.page, 2); assert.equal(activePage.total, 5); assert.equal(activePage.items.length, 2);
    assert.deepEqual(activePage.counts, { all: 6, active: 5, completed: 1 });
    response = await call('/tasks?status=active&page=2&pageSize=2&search=' + encodeURIComponent('分页测试'), options('GET', null, cookies[0]));
    assert.equal(response.status, 200); const searched = await response.json(); assert.equal(searched.search, '分页测试'); assert.equal(searched.total, 5); assert.equal(searched.items.length, 2); assert.deepEqual(searched.counts, { all: 5, active: 5, completed: 0 });
    response = await call('/tasks?search=' + encodeURIComponent('分页测试'), options('GET', null, cookies[1])); assert.equal((await response.json()).total, 0);
    response = await call('/tasks?search=' + encodeURIComponent('%'), options('GET', null, cookies[0])); assert.equal((await response.json()).total, 0);
    response = await call('/tasks?status=completed&page=1&pageSize=3', options('GET', null, cookies[0]));
    const completedPage = await response.json(); assert.equal(completedPage.total, 1); assert.equal(completedPage.items[0].id, task.id);
    response = await call('/tasks?status=all&page=1&pageSize=3', options('GET', null, cookies[1]));
    assert.equal((await response.json()).total, 0);
    response = await call(`/tasks/${task.id}`, options('DELETE', null, cookies[0])); assert.equal(response.status, 204);
    response = await call('/auth/logout', options('POST', null, cookies[0])); assert.equal(response.status, 204);
    response = await call('/tasks', options('GET', null, cookies[0])); assert.equal(response.status, 401);
    console.log('真实 Neon PostgreSQL：注册、登录、筛选、分页、任务隔离及退出验证通过。');
  } catch (error) { console.error('端到端验证失败：', error.message); if (backendErrors) console.error(backendErrors.replace(/postgres(?:ql)?:\/\/[^\s'"`]+/g, '[连接地址已隐藏]')); process.exitCode = 1; }
  finally {
    if (server && server.exitCode === null && !server.killed) await new Promise(resolve => { server.once('exit', resolve); server.kill(); });
    try {
      // 仅清理注册成功并记录了 ID 的测试用户。
      if (users.length) {
        await pool.query('DELETE FROM tasks WHERE user_id = ANY($1)', [users]);
        await pool.query('DELETE FROM sessions WHERE user_id = ANY($1)', [users]);
        await pool.query('DELETE FROM users WHERE id = ANY($1) AND username = ANY($2)', [users, usernames]);
      }
    } catch (error) { console.error('测试数据清理失败，请检查临时测试账号。'); process.exitCode = 1; }
    await pool.end();
  }
})();
