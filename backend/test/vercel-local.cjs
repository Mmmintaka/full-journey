// 模拟平台导入 Express handler，然后启动本地测试服务。
const app = require('../dist/index.js');
app.listen(Number(process.env.PORT), () => console.log('serverless handler ready'));
