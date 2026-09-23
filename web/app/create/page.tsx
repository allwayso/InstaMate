import Link from 'next/link';
import AvatarCreator from '@/components/avatar-creator';

export default function CreatePage() {
  return (
    <main>
      <header className="page-head">
        <h1>InstaMate · 创建角色</h1>
        <p>照片动漫化、Tripo 建模和本地 VRM 转换。<Link href="/">返回主页</Link></p>
      </header>
      <AvatarCreator />
    </main>
  );
}
