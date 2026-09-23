import type { Metadata } from 'next';
import MotionLibraryPage from '@/components/motion-library/motion-library-page';

export const metadata: Metadata = {
  title: '动作录入与动作库 · InstaMate 影伴',
  description: '摄像头动作录入、裁剪、校验并写入项目动作库',
};

export default function Page() {
  return <MotionLibraryPage />;
}
