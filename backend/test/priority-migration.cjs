// 在 Neon 隔离分支上验证：旧数据不变、重复执行安全、数据库约束生效。
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { secureConnectionString } = require('../dist/postgres');
(async () => {
  const url = process.env.DATABASE_URL_UNPOOLED;
  if (!url || new URL(url).hostname.includes('-pooler')) throw new Error('测试必须使用直连地址');
  const pool = new Pool({ connectionString: secureConnectionString(url), connectionTimeoutMillis: 10000 });
  const client = await pool.connect();
  try {
    const before = (await client.query('SELECT id, title, completed, user_id FROM tasks ORDER BY id')).rows;
    const sql = readFileSync(join(__dirname, '../migrations/001_add_task_priority.sql'), 'utf8');
    await client.query(sql); await client.query(sql);
    const after = (await client.query('SELECT id, title, completed, user_id, priority FROM tasks ORDER BY id')).rows;
    assert.equal(after.length, before.length);
    assert.deepEqual(after.map(({ priority, ...row }) => row), before);
    assert.ok(after.every(row => row.priority === 'medium'));
    await client.query('BEGIN');
    const userId = randomUUID(), taskId = randomUUID();
    await client.query('INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3)', [userId, `migration_${userId}`, 'test']);
    await client.query('INSERT INTO tasks (id, title, completed, user_id) VALUES ($1, $2, false, $3)', [taskId, 'legacy insert', userId]);
    assert.equal((await client.query('SELECT priority FROM tasks WHERE id = $1', [taskId])).rows[0].priority, 'medium');
    await assert.rejects(client.query('UPDATE tasks SET priority = $1 WHERE id = $2', ['urgent', taskId]), error => error.code === '23514');
    await client.query('ROLLBACK');
    console.log(`迁移验证通过：${before.length} 条旧任务保留并默认为 medium；重复执行和约束验证通过。`);
  } finally { client.release(); await pool.end(); }
})().catch(error => { console.error('迁移测试失败：', error.message.replace(/postgres(?:ql)?:\/\/[^\s'"`]+/g, '[连接地址已隐藏]')); process.exitCode = 1; });
