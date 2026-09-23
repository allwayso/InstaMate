'use client';

/**
 * 客户端 hook：拉取可选资产列表。
 *
 * 只 fetch /api/avatars（服务端用 fs 扫目录），不在客户端碰文件系统。
 * 失败静默降级为**空列表**（而不是报错）—— 资产选择器是辅助功能，
 * 拉不到列表时页面应当照常渲染默认角色。
 */
import { useEffect, useState } from 'react';

export interface AvatarEntry {
  url: string;
  file: string;
  bytes: number;
  name: string | null;
  boneCount: number | null;
  specVersion: string | null;
}

export function avatarLabel(a: AvatarEntry): string {
  const parts: string[] = [a.name ?? a.file];
  if (a.boneCount != null) parts.push(`${a.boneCount} 骨`);
  return parts.join(' · ');
}

export function useAvatars(include?: string) {
  const [assets, setAssets] = useState<AvatarEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const qs = include ? `?include=${encodeURIComponent(include)}` : '';
    fetch(`/api/avatars${qs}`)
      .then((r) => r.json())
      .then((d: { assets?: AvatarEntry[]; error?: string }) => {
        if (cancelled) return;
        setAssets(Array.isArray(d.assets) ? d.assets : []);
        if (d.error) setError(d.error);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [include]);

  return { assets, error };
}
