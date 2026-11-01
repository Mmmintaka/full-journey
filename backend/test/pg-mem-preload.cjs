// 用于本地测试 PostgreSQL 适配器，不代替真实 PostgreSQL 集成验证。
const Module = require('node:module');
const original = Module._load;
const { newDb } = require('pg-mem');
const mock = newDb().adapters.createPg();
Module._load = function(request, parent, isMain) {
  return request === 'pg' ? mock : original.apply(this, arguments);
};
