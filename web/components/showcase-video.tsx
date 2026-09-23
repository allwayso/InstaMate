'use client';

import { useEffect, useRef } from 'react';
import { showcaseAssets } from '@/lib/showcase-assets';
import styles from '@/app/showcase/showcase.module.css';

export default function ShowcaseVideo() {
  const sectionRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const section = sectionRef.current;
    const video = videoRef.current;
    if (!section || !video) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.55) {
          if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            void video.play().catch(() => {});
          }
        } else {
          video.pause();
        }
      },
      { root: section.closest('main'), threshold: [0, 0.55] },
    );

    observer.observe(section);
    return () => {
      observer.disconnect();
      video.pause();
    };
  }, []);

  return (
    <section
      id="motion"
      ref={sectionRef}
      className={styles.videoSection}
      aria-labelledby="motion-title"
    >
      <div className={styles.videoContent}>
        <h2 id="motion-title" className={styles.videoHeadline}>
          <span>录制一段视频</span>
          <span>定制<em>她的动作库</em></span>
        </h2>
        <div className={styles.videoFrame}>
          <video
            ref={videoRef}
            className={styles.motionVideo}
            controls
            loop
            muted
            playsInline
            preload="metadata"
            poster={showcaseAssets.videoPoster}
            aria-label="影伴动作库展示视频"
          >
            <source src={showcaseAssets.videoWebm} type="video/webm" />
            <source src={showcaseAssets.videoMp4} type="video/mp4" />
            您的浏览器暂不支持视频播放。
          </video>
        </div>
      </div>
    </section>
  );
}
