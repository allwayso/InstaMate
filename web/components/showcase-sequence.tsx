'use client';

import { useEffect, useRef, useState } from 'react';
import ShowcaseAvatar from '@/components/showcase-avatar';
import { showcaseAssets } from '@/lib/showcase-assets';
import styles from '@/app/showcase/showcase.module.css';

const CHAT_MESSAGES = [
  { sender: 'oxygen', text: '牢弟 当时你没告诉我idea', tone: 'green' },
  { sender: 'oxygen', text: '所以我选的个人参赛哦', tone: 'green' },
  { sender: 'oxygen', text: '不知道能不能选上呢', tone: 'green' },
  { sender: '漫漫', text: '可以再报一遍嘛', tone: 'white' },
  { sender: '漫漫', text: '没事的应该可以的', tone: 'white' },
  { sender: '漫漫', text: '相信你少泓你这么强', tone: 'white' },
  { sender: 'oxygen', text: '好哦 我明天看能不能再报一次', tone: 'green' },
  { sender: '漫漫', text: 'okok', tone: 'white' },
] as const;

export default function ShowcaseSequence() {
  const sectionRef = useRef<HTMLElement>(null);
  const chatRef = useRef<HTMLElement>(null);
  const photoRef = useRef<HTMLImageElement>(null);
  const [entered, setEntered] = useState(false);
  const [photoFitted, setPhotoFitted] = useState(false);
  const [photoLoaded, setPhotoLoaded] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const [exploding, setExploding] = useState(false);
  const [chatEntered, setChatEntered] = useState(false);

  useEffect(() => {
    if (photoRef.current?.complete && photoRef.current.naturalWidth > 0) {
      setPhotoLoaded(true);
    }
  }, []);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.82) {
          setEntered(true);
          observer.disconnect();
        }
      },
      { root: section.closest('main'), threshold: [0.82] },
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const section = chatRef.current;
    if (!section) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && entry.intersectionRatio >= .7) {
          setChatEntered(true);
          observer.disconnect();
        }
      },
      { root: section.closest('main'), threshold: [.7] },
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (entered && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setPhotoFitted(true);
    }
  }, [entered]);

  useEffect(() => {
    if (!photoFitted || !photoLoaded || !modelReady) return;
    const timer = window.setTimeout(() => setExploding(true), 1_000);
    return () => window.clearTimeout(timer);
  }, [photoFitted, photoLoaded, modelReady]);

  return (
    <div className={styles.sequenceJourney}>
      <div className={styles.stickyAvatar}>
        <ShowcaseAvatar
          startAssembly={exploding}
          photoRef={photoRef}
          onReady={() => setModelReady(true)}
        />
      </div>
      <section
        id="avatar"
        ref={sectionRef}
        className={styles.modelSection}
        aria-label="照片生成 3D 影伴"
      >
        <div className={styles.sequenceStage}>
          <div className={`${styles.photoFrame} ${exploding ? styles.photoFrameExploding : ''}`}>
            <img
              ref={photoRef}
              src={showcaseAssets.photo}
              alt="用于生成影伴的上传照片"
              className={`${styles.sourcePhoto} ${entered ? styles.sourcePhotoEntered : ''}`}
              onLoad={() => setPhotoLoaded(true)}
              onTransitionEnd={(event) => {
                if (event.propertyName === 'transform') setPhotoFitted(true);
              }}
            />
          </div>
          <h2 className={styles.sequenceHeadline}>
            <span>仅需<em>一张照片</em></span>
            <span>重建<em>高度拟真</em>的</span>
            <span>3d形象</span>
          </h2>
        </div>
      </section>
      <section
        id="memories"
        ref={chatRef}
        className={styles.chatSection}
        aria-label="真实微信聊天记录"
      >
        <h2 className={`${styles.sequenceHeadline} ${styles.chatHeadline}`}>
          <span>只需要导入聊天记录</span>
          <span>影伴就可以</span>
          <span><em>像她一样说话</em></span>
        </h2>
        <ol className={styles.chatList}>
          {CHAT_MESSAGES.map((message, index) => (
            <li
              key={index}
              className={`${styles.chatEntry} ${chatEntered ? styles.chatEntryActive : ''} ${message.tone === 'green' ? styles.chatGreen : styles.chatWhite}`}
              style={{ '--reveal-delay': `${index * .28}s` } as React.CSSProperties}
            >
              <div className={styles.chatBubble}>
                <span className={styles.visuallyHidden}>{message.sender}：</span>
                {message.text}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
