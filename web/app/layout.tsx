import type { Metadata } from 'next';
import './globals.css';
import './studio.css';
import { Suspense } from 'react';
import AppNav from '@/components/app-nav';

export const metadata: Metadata = {
  title: { default: 'InstaMate 影伴', template: '%s · InstaMate' },
  description: '创建你的 3D 影伴，通过文字、语音和动作分享日常。',
};

// 注意：不使用 next/font/google —— 它会在构建期联网拉字体，
// 与 §三.4「禁 CDN 直连」冲突，且现场断网时会导致构建失败。
export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="zh-CN">
      <body>
        <a href="#main-content" className="skip-link">跳到主要内容</a>
        <Suspense fallback={<div className="app-header app-header-placeholder" />}><AppNav /></Suspense>
        {children}
      </body>
    </html>
  );
}
