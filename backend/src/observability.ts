import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, Request, RequestHandler, Response } from "express";

// 只记录已知路由模板，不记录原始 URL、查询参数或任务 ID。
function routeLabel(path: string): string {
  if (["/health", "/auth/register", "/auth/login", "/auth/logout", "/auth/me", "/tasks"].includes(path)) return path;
  if (/^\/tasks\/[^/]+$/.test(path)) return "/tasks/:id";
  return "其他路径";
}

export const requestContext: RequestHandler = (req, res, next) => {
  const requestId = randomUUID();
  const started = process.hrtime.bigint();
  res.locals.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  // Express 路由会暂时改写 URL；在入口处决定日志中使用的安全路径。
  const route = routeLabel(req.path);
  res.on("finish", () => {
    const durationMs = Math.round(Number(process.hrtime.bigint() - started) / 1_000_000);
    console.log(JSON.stringify({ event: "request", requestId, method: req.method, route, status: res.statusCode, durationMs }));
  });
  next();
};

export function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message, requestId: res.locals.requestId });
}

export class DatabaseUnavailableError extends Error {}

// Express 5 会把异步路由抛出的异常传给这个四参数中间件。
export const handleError: ErrorRequestHandler = (err: unknown, _req: Request, res: Response, next) => {
  if (res.headersSent) { next(err); return; }
  const type = typeof err === "object" && err !== null && "type" in err ? err.type : undefined;
  if (type === "entity.parse.failed") { sendError(res, 400, "请求的 JSON 格式不正确。"); return; }
  if (type === "entity.too.large") { sendError(res, 413, "请求内容过大。"); return; }
  if (type === "encoding.unsupported" || type === "charset.unsupported") { sendError(res, 415, "不支持的请求编码。"); return; }
  const unavailable = err instanceof DatabaseUnavailableError;
  // 不输出异常原文、堆栈、SQL 或连接字符串；编号关联同一条请求日志。
  console.error(JSON.stringify({ event: "request_error", requestId: res.locals.requestId, category: unavailable ? "database_unavailable" : "unexpected" }));
  sendError(res, unavailable ? 503 : 500, unavailable ? "数据库暂不可用，请稍后重试。" : "服务器出错，请稍后重试。");
};
