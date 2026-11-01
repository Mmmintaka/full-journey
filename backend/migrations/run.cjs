// 通过直连地址执行版本化迁移；DATABASE_URL 不被自动用作迁移地址。
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Pool } = require('pg');
for (const name of ['.env.local', '.env']) {
  try { process.loadEnvFile(name); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
(async () => {
  if (!process.env.DATABASE_URL_UNPOOLED) throw new Error('请为迁移提供 DATABASE_URL_UNPOOLED 直连地址。');
  const url = new URL(process.env.DATABASE_URL_UNPOOLED);
  if (url.hostname.includes('-pooler')) throw new Error('迁移需要直连地址，请不要使用连接池地址。');
  if (url.searchParams.get('sslmode') === 'require' && !url.searchParams.has('uselibpqcompat')) url.searchParams.set('sslmode', 'verify-full');
  const pool = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 10000 });
  try {
    const sql = readFileSync(join(__dirname, '001_add_task_priority.sql'), 'utf8');
    await pool.query(sql);
    console.log('迁移 001_add_task_priority 已执行。');
  } finally { await pool.end(); }
})().catch(() => { console.error('迁移失败，请检查直连地址和数据库状态。'); process.exitCode = 1; });
