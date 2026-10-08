import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Context Atlas — 上下文策略图谱",
  description: "探索 DeepSeek Harness 与 8 个编码 Agent 的上下文管理策略。交互式压缩演示、源码对照与可复核的真实模型评测。",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
