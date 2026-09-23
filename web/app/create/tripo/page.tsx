import PageHeading from '@/components/page-heading';
import TripoAvatarCreator from '@/components/tripo-avatar-creator';

export default function TripoCreatePage() {
  return (
    <main id="main-content" className="focused-page">
      <PageHeading eyebrow="另一种生成方式" title="Tripo 平面图创建" description="先预览 T-pose 平面图，再决定是否继续生成 3D 角色。" />
      <TripoAvatarCreator />
    </main>
  );
}
