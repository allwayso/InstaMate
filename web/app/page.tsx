'use client';

/**
 * 调试页入口（A 泳道，§十一）。
 *
 * 为什么整页是客户端组件 + dynamic(ssr:false)：
 * three.js 需要 WebGL 上下文，SSR/预渲染会在服务端执行到 window/document。
 * Next 16 文档明确：`ssr: false` 只能在客户端组件里使用。
 */
import dynamic from 'next/dynamic';

const DisplayCase = dynamic(() => import('@/components/display-case'), {
  ssr: false,
  loading: () => <div className="stage-loading">正在初始化渲染器…</div>,
});

export default function Page() {
  return (
    <main>
      <header className="page-head">
        <h1>InstaMate 影伴 · 角色调试页</h1>
        <p>
          P0 / A 泳道 —— 本轮范围：<strong>静态 VRM 渲染</strong>（G0）。
          注视、程序化抬手、动作库为下一步。
        </p>
      </header>
      <DisplayCase />
    </main>
  );
}
