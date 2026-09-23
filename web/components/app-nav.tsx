'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import ThemeToggle from './theme-toggle';

const pages = [
  ['/', '影伴空间'],
  ['/motion-library', '动作工作室'],
  ['/states', '状态库'],
  ['/profiles', '人物记忆'],
  ['/create', '创建角色'],
] as const;

export default function AppNav() {
  const pathname = usePathname();
  const avatar = useSearchParams().get('avatar');
  return (
    <header className="app-header">
      <div className="app-header-inner">
        <Link className="brand" href="/" aria-label="InstaMate 影伴首页">
          <img className="brand-logo" src="/logo.png" alt="" width="34" height="34" />
          <span>InstaMate<span className="brand-caption">影伴</span></span>
        </Link>
        <nav className="app-nav" aria-label="主导航">
          {pages.map(([path, label]) => (
            <Link key={path}
              href={avatar && (path === '/' || path === '/states') ? `${path}?avatar=${encodeURIComponent(avatar)}` : path}
              aria-current={pathname === path ? 'page' : undefined}>
              {label}
            </Link>
          ))}
        </nav>
        <ThemeToggle />
      </div>
    </header>
  );
}
