import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "任务清单",
  description: "一个逐步建立起来的任务管理应用",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
