import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'InstaMate 影伴 · 角色调试页',
  description: 'P0 / A 泳道：静态 VRM 渲染（G0）',
};

// 注意：不使用 next/font/google —— 它会在构建期联网拉字体，
// 与 §三.4「禁 CDN 直连」冲突，且现场断网时会导致构建失败。
export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
