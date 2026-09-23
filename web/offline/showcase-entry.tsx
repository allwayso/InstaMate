import React from 'react';
import { createRoot } from 'react-dom/client';
import ShowcaseSequence from '@/components/showcase-sequence';
import ShowcaseVideo from '@/components/showcase-video';
import styles from '@/app/showcase/showcase.module.css';

function OfflineShowcase() {
  return (
    <main className={styles.page}>
      <section id="top" className={styles.hero} aria-labelledby="showcase-title">
        <div className={styles.heroBackdrop} aria-hidden="true" />
        <header className={styles.header}>
          <a className={styles.wordmark} href="#top">instamate</a>
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

      <ShowcaseSequence />
      <ShowcaseVideo />
    </main>
  );
}

createRoot(document.getElementById('app')!).render(<OfflineShowcase />);
