// 用于本地测试 PostgreSQL 适配器，不代替真实 PostgreSQL 集成验证。
const Module = require('node:module');
const original = Module._load;
const { newDb, DataType } = require('pg-mem');
const database = newDb();
// pg-mem 未实现 PostgreSQL 的 strpos；真实数据库验证仍独立执行。
database.public.registerFunction({ name: 'strpos', args: [DataType.text, DataType.text], returns: DataType.integer, implementation: (value, query) => value.indexOf(query) + 1 });
const mock = database.adapters.createPg();
Module._load = function(request, parent, isMain) {
  return request === 'pg' ? mock : original.apply(this, arguments);
};
