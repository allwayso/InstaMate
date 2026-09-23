'use client';

/**
 * 调试页入口（A 泳道，§十一）。
 *
 * 为什么整页是客户端组件 + dynamic(ssr:false)：
 * three.js 需要 WebGL 上下文，SSR/预渲染会在服务端执行到 window/document。
 * Next 16 文档明确：`ssr: false` 只能在客户端组件里使用。
 *
 * `?avatar=<url>` 可覆盖默认资产 —— 用途是**不重新构建就能验收任意 VRM**
 * （例如 tools/gltf-to-vrm.mjs 从第三方 GLB 转出来的角色）。
 * 惰性初始化而不是 useEffect：ssr:false 下首次渲染就在客户端，直接读 query 即可，
 * 否则 undefined → url 会触发两次加载（display-case 的加载 effect 依赖 [src]）。
 */
import dynamic from 'next/dynamic';
import ChatPanel from '@/components/chat-panel';
import PageHeading from '@/components/page-heading';
import Link from 'next/link';
import { useEffect, useState } from 'react';

const DisplayCase = dynamic(() => import('@/components/display-case'), {
  ssr: false,
  loading: () => <div className="stage-loading">正在初始化渲染器…</div>,
});

function readAvatarParam(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const v = new URLSearchParams(window.location.search).get('avatar');
  return v && v.trim() ? v.trim() : undefined;
}

export default function Page() {
  const avatar = readAvatarParam();
  const [statesHref, setStatesHref] = useState('/states');
  useEffect(() => {
    setStatesHref(avatar ? '/states?avatar=' + encodeURIComponent(avatar) : '/states');
  }, [avatar]);

  return (
    <main id="main-content">
      <PageHeading eyebrow="属于你的陪伴" title="影伴空间" description="聊聊今天，让声音、记忆和动作连接你们。">
        <Link className="button-link" href={statesHref}>管理角色状态 <span aria-hidden="true">↗</span></Link>
      </PageHeading>
      <div className="companion-workspace">
        <DisplayCase src={avatar} />
        <ChatPanel />
      </div>
    </main>
  );
}
