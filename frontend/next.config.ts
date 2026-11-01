import type { NextConfig } from "next";

// 浏览器只访问同源的 /api；Next.js 将请求转发给独立后端。
const configuredBackend = process.env.BACKEND_URL;
if (process.env.VERCEL && !configuredBackend) {
  throw new Error("请在 Vercel 中配置 BACKEND_URL，指向 Render 后端的 HTTPS 地址。");
}
const backendUrl = (configuredBackend ?? "http://localhost:4000").replace(/\/$/, "");
if (process.env.VERCEL) {
  let url: URL;
  try { url = new URL(backendUrl); } catch { throw new Error("BACKEND_URL 必须是有效的 HTTPS 源地址。"); }
  if (url.protocol !== "https:" || url.origin !== backendUrl) {
    throw new Error("Vercel 的 BACKEND_URL 必须是 HTTPS 源地址，不能包含路径。");
  }
}
const config: NextConfig = {
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backendUrl}/:path*` }];
  },
};
export default config;
