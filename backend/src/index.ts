import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { requestContext, sendError, handleError, DatabaseUnavailableError } from "./observability";
import { rateLimit } from "express-rate-limit";
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { initializeDatabase, createSession, createUser, deleteSession, deleteTask, findSession, findTask, findUserByName, insertTask, listTasks, listTasksPage, updateTask, type Task, type TaskStatus, type TaskSort, type Priority } from "./database";

// Neon CLI 将连接配置放在项目根目录；显式环境变量优先，其次 .env.local，再是 .env。
if (process.env.NODE_ENV !== "test") {
  for (const name of [".env.local", ".env"]) {
    const path = resolve(__dirname, "../..", name);
    if (existsSync(path)) process.loadEnvFile(path);
  }
}

const app = express();
const port = Number(process.env.PORT ?? 4000);
const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";
const secureCookie = process.env.COOKIE_SECURE === "true";
const crossSiteCookie = process.env.COOKIE_SAME_SITE === "none";
if (crossSiteCookie && !secureCookie) throw new Error("COOKIE_SAME_SITE=none requires COOKIE_SECURE=true");
if (process.env.NODE_ENV === "production") {
  if (!process.env.FRONTEND_ORIGIN || !process.env.DATABASE_URL || !secureCookie) {
    throw new Error("生产环境必须配置 FRONTEND_ORIGIN、DATABASE_URL 和 COOKIE_SECURE=true");
  }
  let origin: URL;
  try { origin = new URL(frontendOrigin); } catch { throw new Error("FRONTEND_ORIGIN 必须是有效的 HTTPS 地址"); }
  if (origin.protocol !== "https:" || origin.origin !== frontendOrigin) {
    throw new Error("生产环境 FRONTEND_ORIGIN 必须是 HTTPS 源地址，且不含路径或末尾斜线");
  }
}
// 只在确认反向代理层数时启用；错误信任代理头会让 IP 限流失效。
const proxyHops = process.env.TRUST_PROXY_HOPS;
if (proxyHops !== undefined) {
  if (!/^[1-9]\d*$/.test(proxyHops) || Number(proxyHops) > 10) throw new Error("TRUST_PROXY_HOPS 必须是 1–10 的整数");
  app.set("trust proxy", Number(proxyHops));
}
const cookieOptions = { httpOnly: true, secure: secureCookie, sameSite: crossSiteCookie ? "none" as const : "lax" as const, path: "/" };
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
const scrypt = promisify(scryptCallback);
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

// 首次请求时共享一次数据库初始化；失败后允许下一次请求重试。
let databaseReady: Promise<void> | undefined;
function ensureDatabase(): Promise<void> {
  if (!databaseReady) {
    databaseReady = initializeDatabase().catch((error: unknown) => {
      databaseReady = undefined;
      throw error;
    });
  }
  return databaseReady;
}
app.use(requestContext);
app.use(cors({ origin: frontendOrigin, credentials: true }));
app.use(async (_req, _res, next) => {
  try { await ensureDatabase(); next(); }
  catch { next(new DatabaseUnavailableError()); }
});
// Cookie 自动携带，因此拒绝来自其他浏览器来源的写请求，防止跨站请求伪造。
app.use((req, res, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin && req.headers.origin !== frontendOrigin) {
    sendError(res, 403, "请求来源不被允许。"); return;
  }
  next();
});
app.use(express.json({ limit: "16kb" }));

function readToken(req: Request): string | undefined {
  return req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("session="))?.slice(8);
}
async function currentUser(req: Request) {
  const token = readToken(req);
  return token && /^[a-f0-9]{64}$/.test(token) ? findSession(tokenHash(token)) : undefined;
}
async function requireUser(req: Request, res: Response, next: NextFunction) {
  const user = await currentUser(req);
  if (!user) { sendError(res, 401, "请先登录。"); return; }
  res.locals.user = user;
  next();
}
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `${salt}:${hash.toString("hex")}`;
}
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hex] = stored.split(":");
  const expected = Buffer.from(hex, "hex");
  const actual = await scrypt(password, salt, 64) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
async function issueSession(res: Response, userId: string) {
  const token = randomBytes(32).toString("hex");
  await createSession(tokenHash(token), userId, Date.now() + sessionLifetime);
  res.cookie("session", token, { ...cookieOptions, maxAge: sessionLifetime });
}
function validCredentials(username: unknown, password: unknown): username is string {
  return typeof username === "string" && /^[a-zA-Z0-9_]{3,30}$/.test(username) &&
    typeof password === "string" && password.length >= 8 && Buffer.byteLength(password, "utf8") <= 128;
}

app.get("/health", (_req, res) => { res.json({ message: "后端服务运行正常。" }); });
// 限制每个 IP 的注册和登录请求；当前是进程内计数，适合单实例学习环境。
const authLimiter = (limit: number, windowMs: number) => rateLimit({
  windowMs, limit, standardHeaders: "draft-8", legacyHeaders: false,
  handler: (_req, res) => sendError(res, 429, "尝试次数过多，请稍后再试。"),
});
app.post("/auth/register", authLimiter(5, 60 * 60 * 1000), async (req, res) => {
  const { username, password } = req.body ?? {};
  if (!validCredentials(username, password)) { sendError(res, 400, "用户名需为 3–30 位字母、数字或下划线；密码需至少 8 个字符且不超过 128 字节。"); return; }
  if (await findUserByName(username)) { sendError(res, 409, "用户名已被使用。"); return; }
  const passwordHash = await hashPassword(password);
  // 哈希期间可能有并发注册，数据库唯一约束仍会阻止重复用户名。
  try { await createUser({ id: randomUUID(), username, passwordHash }); }
  catch (error) { if (await findUserByName(username)) { sendError(res, 409, "用户名已被使用。"); return; } throw error; }
  res.status(201).json({ message: "注册成功，请登录。" });
});
app.post("/auth/login", authLimiter(10, 15 * 60 * 1000), async (req, res) => {
  const { username, password } = req.body ?? {};
  if (!validCredentials(username, password)) { sendError(res, 401, "用户名或密码不正确。"); return; }
  const user = await findUserByName(username);
  if (!user || !(await verifyPassword(password, user.passwordHash))) { sendError(res, 401, "用户名或密码不正确。"); return; }
  await issueSession(res, user.id);
  res.json({ id: user.id, username: user.username });
});
app.get("/auth/me", requireUser, (_req, res) => { res.json(res.locals.user); });
app.post("/auth/logout", async (req, res) => {
  const token = readToken(req);
  if (token && /^[a-f0-9]{64}$/.test(token)) await deleteSession(tokenHash(token));
  res.clearCookie("session", cookieOptions);
  res.status(204).end();
});

app.use("/tasks", requireUser);
app.get("/tasks", async (req, res) => {
  // 旧版客户端无查询参数时仍返回数组，确保前后端分别发布时不中断。
  if (Object.keys(req.query).length === 0) { res.json(await listTasks(res.locals.user.id)); return; }
  const { status = "all", page = "1", pageSize = "10", search = "", sort = "oldest" } = req.query;
  if (typeof sort !== "string" || !["oldest", "newest"].includes(sort) ||
      typeof search !== "string" || search.length > 100 || search.includes("\0") ||
      typeof status !== "string" || !["all", "active", "completed"].includes(status) ||
      typeof page !== "string" || !/^[1-9]\d{0,5}$/.test(page) ||
      typeof pageSize !== "string" || !/^[1-9]\d?$/.test(pageSize) || Number(pageSize) > 50) {
    sendError(res, 400, "筛选或分页参数不合法。"); return;
  }
  const result = await listTasksPage(res.locals.user.id, status as TaskStatus, Number(page), Number(pageSize), search.trim(), sort as TaskSort);
  res.json({ ...result, capabilities: { priority: true } });
});
function validPriority(value: unknown): value is Priority {
  return value === "low" || value === "medium" || value === "high";
}
app.post("/tasks", async (req, res) => {
  const title: unknown = req.body?.title;
  if (typeof title !== "string" || !title.trim() || title.trim().length > 100) { sendError(res, 400, "任务标题须为 1 到 100 个字符。"); return; }
  const priority: unknown = req.body?.priority === undefined ? "medium" : req.body.priority;
  if (!validPriority(priority)) { sendError(res, 400, "请选择有效的任务优先级。"); return; }
  const task: Task = { id: randomUUID(), title: title.trim(), completed: false, priority };
  await insertTask(task, res.locals.user.id);
  res.status(201).json(task);
});
app.patch("/tasks/:id", async (req, res) => {
  const task = await findTask(req.params.id, res.locals.user.id);
  if (!task) { sendError(res, 404, "任务不存在。"); return; }
  const body: unknown = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) { sendError(res, 400, "请提供要修改的任务内容。"); return; }
  const { title, completed, priority } = body as Record<string, unknown>;
  if ((title === undefined && completed === undefined && priority === undefined) ||
    (title !== undefined && (typeof title !== "string" || !title.trim() || title.trim().length > 100)) ||
    (completed !== undefined && typeof completed !== "boolean") ||
    (priority !== undefined && !validPriority(priority))) {
    sendError(res, 400, "请提供有效的标题、完成状态或优先级。"); return;
  }
  if (typeof title === "string") task.title = title.trim();
  if (typeof completed === "boolean") task.completed = completed;
  if (validPriority(priority)) task.priority = priority;
  await updateTask(task, res.locals.user.id);
  res.json(task);
});
app.delete("/tasks/:id", async (req, res) => {
  if (!(await deleteTask(req.params.id, res.locals.user.id))) { sendError(res, 404, "任务不存在。"); return; }
  res.status(204).end();
});
app.use((_req, res) => { sendError(res, 404, "接口不存在。"); });
app.use(handleError);
// Vercel 负责监听端口；本地开发仍然作为独立 Node 服务启动。
if (!process.env.VERCEL) {
  ensureDatabase().then(() => {
    app.listen(port, () => { console.log(`Backend listening on http://localhost:${port}`); });
  }).catch(() => {
    console.error("数据库初始化失败，请检查连接配置。");
    process.exitCode = 1;
  });
}
module.exports = app;
