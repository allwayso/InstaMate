import Link from 'next/link';
import ProfileImporter from '@/components/profile-importer';

export default function ProfilesPage() {
  return (
    <main>
      <header className="page-head">
        <h1>InstaMate · 聊天记忆</h1>
        <p>从聊天 ZIP 生成可审核的人物档案。<Link href="/">返回主页</Link></p>
      </header>
      <ProfileImporter />
    </main>
  );
}
