import PageHeading from '@/components/page-heading';
import AvatarCreator from '@/components/avatar-creator';

export default function CreatePage() {
  return (
    <main id="main-content" className="focused-page">
      <PageHeading eyebrow="从一张照片开始" title="创造你的影伴" description="选一张喜欢的照片，赋予它新的模样。" />
      <AvatarCreator />
    </main>
  );
}
