import type { Metadata } from 'next';
import Link from 'next/link';
import ShowcaseAvatar from '@/components/showcase-avatar';
import styles from './showcase.module.css';

export const metadata: Metadata = {
  title: 'InstaMate | 重建独属于你的影伴',
  description: '从照片和聊天记录出发，组装独属于你的 3D 数字影伴。',
};

export default function ShowcasePage() {
  return (
    <main className={styles.page}>
      <section className={styles.hero} aria-labelledby="showcase-title">
        <div className={styles.heroBackdrop} aria-hidden="true" />
        <header className={styles.header}>
          <Link className={styles.wordmark} href="/showcase">instamate</Link>
        </header>

        <div className={styles.heroContent}>
          <h1 id="showcase-title">重建独属于<br />你的影伴</h1>
          <p>从照片生成三维形象，从聊天记录提炼性格与记忆，再接入骨骼、动作与对话，让影伴一步步成形。</p>
        </div>

        <a className={styles.scrollPrompt} href="#avatar">
          <span className={styles.downArrow} aria-hidden="true" />
          <span>定制属于我的影伴</span>
        </a>
      </section>

      <section id="avatar" className={styles.modelSection} aria-label="3D 数字人旋转展示">
        <ShowcaseAvatar />
      </section>
    </main>
  );
}
