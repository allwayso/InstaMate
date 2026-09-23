'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import ChatPanel from '@/components/chat-panel';
import StateManager from '@/components/state-manager';

const DisplayCase = dynamic(() => import('@/components/display-case'), {
  ssr: false,
  loading: () => <div className="stage-loading">正在初始化渲染器…</div>,
});

export default function StatesPage() {
  const avatar = typeof window === 'undefined'
    ? undefined : new URLSearchParams(window.location.search).get('avatar') || undefined;
  const [homeHref, setHomeHref] = useState('/');
  useEffect(() => {
    setHomeHref(avatar ? '/?avatar=' + encodeURIComponent(avatar) : '/');
  }, [avatar]);
  return (
    <main>
      <header className="page-head">
        <h1>InstaMate · 状态库</h1>
        <p>管理动作状态，并用文字或语音测试角色表演。
          <Link href={homeHref}>返回主页</Link></p>
      </header>
      <DisplayCase src={avatar} />
      <StateManager />
      <ChatPanel />
    </main>
  );
}
