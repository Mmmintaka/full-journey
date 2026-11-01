# 任务清单：全栈学习项目

这是一个 npm workspaces monorepo：`frontend` 是 Next.js 前端，`backend` 是独立的 Express 后端，两边都使用 TypeScript，通过 HTTP 和 JSON 通信。

## 本地启动

需要 Node.js 22 或更高版本（SQLite 驱动要求）。在项目根目录首次运行 `npm install`，再打开两个终端，分别执行：

```bash
npm run dev:backend
```

```bash
npm run dev:frontend
```

打开 http://localhost:3000。后端默认运行在 http://localhost:4000。

## 注册、登录与会话

注册用户名只能包含 3–30 位英文字母、数字或下划线；密码至少 8 个字符，UTF-8 编码不超过 128 字节。注册成功后再登录。

| 方法与路径 | 用途 |
| --- | --- |
| `POST /auth/register` | 创建用户；密码经随机盐和 scrypt 哈希后保存 |
| `POST /auth/login` | 验证密码并设置 HttpOnly 会话 Cookie |
| `GET /auth/me` | 根据会话读取当前用户 |
| `POST /auth/logout` | 删除当前会话并清除 Cookie |

浏览器请求使用 `credentials: "include"` 携带 Cookie；后端只保存会话令牌的 SHA-256 摘要，会话有效期为 7 天。带 Origin 的写请求只接受配置的前端来源。每个任务的数据库查询和修改都同时限定用户 ID。

旧版本已经存在的任务会保留在数据库，但由于它们没有用户归属，不会显示给任何账号；不会自动归属第一个注册用户。不要删除数据库文件，后续可按需设计明确的归属迁移。

## 任务接口

| 方法与路径 | 用途 | 请求体 | 成功响应 |
| --- | --- | --- | --- |
| `GET /tasks?status=active&page=1&pageSize=10` | 按状态分页查询当前用户任务 | 无 | 200，任务、页码、数量和状态统计 |
| `POST /tasks` | 创建任务（优先级可选，默认 medium） | `{"title":"学习 TypeScript","priority":"high"}` | 201，新任务 |
| `PATCH /tasks/:id` | 修改标题、完成状态或优先级 | `{"priority":"low"}`、`{"title":"新标题"}` 或 `{"completed":true}` | 200，修改后的任务 |
| `DELETE /tasks/:id` | 删除任务 | 无 | 204，无响应体 |

分页支持 `sort=oldest|newest`（按创建时间排序，默认 oldest）和 `search`（标题包含的文字，区分大小写，最长 100 字符）与 `status=all|active|completed`，`page` 从 1 开始，`pageSize` 为 1–50。响应格式为 `{"items":[],"page":1,"pageSize":10,"search":"","sort":"oldest","total":0,"totalPages":0,"counts":{"all":0,"active":0,"completed":0}}`；各状态数量随搜索关键词变化；页码超过最后一页时会返回最后一页（空列表时 page 为 1，totalPages 为 0）。无查询参数的 `GET /tasks` 暂时返回旧版数组，供发布期间旧客户端使用。分页使用 OFFSET，数据大量增长或频繁变动时可考虑游标分页；统计和列表是两次查询，并发写入时可能短暂不一致。

以上任务接口需要登录。本地默认使用 SQLite 文件 `backend/data/tasks.sqlite`；设置 `DATABASE_PATH` 可以修改位置。本地数据库未提交到 Git，保留现有数据。SQLite 使用 WAL，备份时应使用 SQLite 的备份机制。

Neon CLI 生成的根目录 `.env.local` 或 `.env` 会在后端启动时加载；已设置的系统环境变量优先。设置 `DATABASE_URL` 时后端使用 PostgreSQL：首次启动会在目标库创建应用表。生产环境必须使用 PostgreSQL；本地 SQLite 数据不会自动迁移到云端，原文件仍保留。数据库连接串应使用服务商提供的 TLS 配置，属于敏感凭据，不要提交到 Git 或粘贴到公开位置。

## 前后端通信和部署

浏览器请求同源 `/api/...`，Next.js 将其转发到 Express。开发时默认转发到 `http://localhost:4000`；`frontend/next.config.ts` 使用 `BACKEND_URL` 指定其他后端地址，生产构建前需要设置。Cookie 对浏览器来说来自前端域名，保持 `SameSite=Lax`，无需依赖第三方 Cookie。后端 `FRONTEND_ORIGIN` 要配置为实际前端 HTTPS 源（不含末尾斜线）。

目标方案是两个独立的 Vercel 项目：`frontend` 是 Next.js，`backend` 是 Express Function；Neon PostgreSQL 存储数据。后端首次请求时初始化数据库，并由平台管理请求与实例，本地仍使用 Node 服务。后端需要 `DATABASE_URL`、`FRONTEND_ORIGIN`（前端 HTTPS 地址）和 `COOKIE_SECURE=true`；前端构建需要 `BACKEND_URL`（后端 HTTPS 地址）。数据库密钥只填入平台环境变量，不能提交。两个项目实际部署后仍需验证转发、登录 Cookie 和持久化。

注册接口按 IP 限制为每小时 5 次，登录接口每 15 分钟 10 次，超过返回 429。计数在单个 Node.js 进程内，重启会重置，多实例不共享；Vercel 转发链下 IP 的归属也尚未确认，因此不能依赖它作为有效的全局防护。只在确认代理层数后设置 `TRUST_PROXY_HOPS`，不要随意信任转发头。正式开放注册前应使用可靠的共享限流与代理配置，并验证备份恢复。

运行 `npm run test:backend` 可验证 SQLite 及 PostgreSQL 模拟器下的认证和权限隔离；模拟器不能代替真实 PostgreSQL 联调。

## 数据库迁移：任务优先级

`priority` 允许 `low`、`medium`、`high`，非空且默认 `medium`。旧客户端不传该字段时仍使用默认值。PostgreSQL 的版本化变更见 `backend/migrations/001_add_task_priority.sql`；本地 SQLite 启动时检查并补充字段。`CREATE TABLE IF NOT EXISTS` 不会修改已有表，因此发布新版后端前要执行迁移。

先在 Neon 隔离分支用直连地址验证，然后在目标数据库提供 `DATABASE_URL_UNPOOLED` 执行 `npm run db:migrate`。不要将连接地址写入仓库；生产迁移必须先于新版本后端部署。此迁移可重复执行，但不会修复已经存在且定义不同的同名字段；将来新增变更应使用新的迁移文件。

## 错误处理与请求日志

请求进入 Express 时会生成新的 `X-Request-Id`。应用在响应结束后输出 JSON 日志，包含请求编号、方法、已知路由模板、状态码和耗时；不会输出请求体、Cookie、查询参数或任务 ID。未知路径统一显示为“其他路径”。

接口错误的 JSON 包含 `error` 和 `requestId`；旧前端仍可读取原来的 `error` 字段。格式错误的 JSON 返回 400，过大的请求体返回 413，不存在的接口返回 404；数据库初始化失败返回 503，未预期异常返回 500。5xx 的页面提示中会附带请求编号，可在 Vercel 后端项目的 Logs 页面按编号查找。网络未到达后端、代理自身报错或请求中断时，可能没有后端生成的编号。

错误日志只记录分类和编号，不记录异常原文、堆栈、SQL 或连接串；因此需要更细致的根因排查时，还需要另行配置受控的诊断方案。日志由运行平台收集，本项目没有单独配置日志持久存储或保留期限。
