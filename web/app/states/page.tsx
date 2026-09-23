'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import ChatPanel from '@/components/chat-panel';
import StateManager from '@/components/state-manager';
import PageHeading from '@/components/page-heading';

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
    <main id="main-content" className="states-page">
      <PageHeading eyebrow="让回应更生动" title="角色状态库" description="将话语、情绪与动作关联，在对话中感受角色的回应。">
        <Link className="button-link" href={homeHref}>返回影伴空间 <span aria-hidden="true">↗</span></Link>
      </PageHeading>
      <div className="companion-workspace">
        <DisplayCase src={avatar} />
        <ChatPanel />
      </div>
      <StateManager />
    </main>
  );
}
