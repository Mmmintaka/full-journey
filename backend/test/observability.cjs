// 对异常中间件注入故障，验证返回值、关联编号和日志脱敏。
const assert = require('node:assert/strict');
const express = require('express');
const { requestContext, handleError, DatabaseUnavailableError } = require('../dist/observability');
const originalLog = console.log, originalError = console.error;
const logs = [];
console.log = value => logs.push(String(value));
console.error = value => logs.push(String(value));
const app = express();
app.use(requestContext);
app.get('/tasks/:id', () => { throw new Error('secret-password postgres://sensitive.example'); });
app.get('/health', () => { throw new DatabaseUnavailableError(); });
app.use(handleError);
const server = app.listen(0, '127.0.0.1', async () => {
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/tasks/private-id?search=secret-search`, { headers: { cookie: 'session=secret-cookie' } });
    assert.equal(response.status, 500);
    const body = await response.json(); assert.equal(body.error, '服务器出错，请稍后重试。'); assert.equal(body.requestId, response.headers.get('x-request-id'));
    const unavailable = await fetch(`${base}/health`); assert.equal(unavailable.status, 503); assert.equal((await unavailable.json()).error, '数据库暂不可用，请稍后重试。');
    const events = logs.map(line => JSON.parse(line));
    const requestLog = events.find(event => event.event === 'request' && event.requestId === body.requestId);
    const errorLog = events.find(event => event.event === 'request_error' && event.requestId === body.requestId);
    assert.equal(requestLog.route, '/tasks/:id'); assert.equal(requestLog.status, 500); assert.equal(errorLog.category, 'unexpected');
    assert.ok(events.some(event => event.category === 'database_unavailable'));
    for (const secret of ['secret-password', 'sensitive.example', 'private-id', 'secret-search', 'secret-cookie']) assert.equal(logs.join('\n').includes(secret), false);
    originalLog('统一错误响应、请求编号及应用日志脱敏验证通过');
  } catch (error) { originalError(error); process.exitCode = 1; }
  finally { console.log = originalLog; console.error = originalError; server.close(); }
});
