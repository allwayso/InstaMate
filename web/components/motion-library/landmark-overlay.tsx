'use client';

/**
 * 关键点覆盖层。
 *
 * 设计要点：
 *   · **视频镜像、覆盖层不镜像**。视频元素用 CSS `scaleX(-1)` 呈现（符合自拍习惯），
 *     而 Canvas 用同一套视觉变换来画点（`toDisplayX(..., mirrored=true)`）以保证对齐。
 *     Canvas 本身**不做** CSS 镜像 —— 这样将来在画面上写调试文字不会被写反。
 *   · 连接拓扑来自官方常量（session 动态 import 时取出来的），**不手写索引表**：
 *     手写的表错一个数字，画面上就是一条乱线，很难发现。
 *   · 面部只画轮廓/眉眼/嘴唇，**不画 468 点三角网**：遮挡且浪费性能。
 *   · 置信度配色：<0.5 黄色、严重丢失红色；左右手用不同本色以便区分。
 */
import { useEffect, useRef } from 'react';
import type { Landmark } from '@/lib/mocap/mocap-types';
import {
  confidenceColor,
  isDrawable,
  toCanvasPoint,
  PREVIEW_MIRRORED,
} from '@/lib/mocap/display-mapping';
import type { HolisticConnections } from '@/lib/mocap/holistic-session';

export interface OverlayLayers {
  pose: boolean;
  hands: boolean;
  face: boolean;
}

interface Props {
  /** 当前帧的关键点。用 ref 传递：覆盖层每帧重画，走 React state 会拖垮帧率 */
  getFrame: () => {
    pose: Landmark[] | null;
    leftHand: Landmark[] | null;
    rightHand: Landmark[] | null;
    face: Landmark[] | null;
  };
  connections: HolisticConnections | null;
  layers: OverlayLayers;
  /** 显示尺寸（应与 <video> 的 CSS 尺寸一致） */
  width: number;
  height: number;
  mirrored?: boolean;
  /** 帧序号，用于触发重画 */
  frameTick: number;
}

const POSE_COLOR = '#4dabf7';
const LEFT_HAND_COLOR = '#51cf66';
const RIGHT_HAND_COLOR = '#ff922b';
const FACE_COLOR = '#9775fa';

export default function LandmarkOverlay({
  getFrame,
  connections,
  layers,
  width,
  height,
  mirrored = PREVIEW_MIRRORED,
  frameTick,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !width || !height) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const { pose, leftHand, rightHand, face } = getFrame();

    const pt = (lm: Landmark) => {
      const p = toCanvasPoint(lm.x as number, lm.y as number, width, height, mirrored);
      return p;
    };

    /** 画一组「点 + 连线」 */
    const drawGroup = (
      lms: Landmark[] | null,
      pairs: ReadonlyArray<readonly [number, number]> | null,
      baseColor: string,
      radius: number,
    ) => {
      if (!lms || !lms.length) return;
      if (pairs && pairs.length) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = baseColor;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        for (const [a, b] of pairs) {
          const pa = lms[a];
          const pb = lms[b];
          if (!isDrawable(pa) || !isDrawable(pb)) continue;
          const p1 = pt(pa);
          const p2 = pt(pb);
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      for (const lm of lms) {
        if (!isDrawable(lm)) continue;
        const p = pt(lm);
        const { color, level } = confidenceColor(lm.visibility, baseColor);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, level === 'ok' ? radius : radius + 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    // 面部：只画轮廓/眉眼/嘴唇，不画三角网
    if (layers.face && connections && face) {
      drawGroup(face, null, FACE_COLOR, 0.8);
      for (const pairs of [
        connections.faceOval,
        connections.faceLips,
        connections.faceLeftEye,
        connections.faceRightEye,
        connections.faceLeftEyebrow,
        connections.faceRightEyebrow,
      ]) {
        if (!pairs.length) continue;
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = FACE_COLOR;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        for (const [a, b] of pairs) {
          const pa = face[a];
          const pb = face[b];
          if (!isDrawable(pa) || !isDrawable(pb)) continue;
          const p1 = pt(pa);
          const p2 = pt(pb);
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    if (layers.pose) {
      drawGroup(pose, connections?.pose ?? null, POSE_COLOR, 3);
    }

    if (layers.hands) {
      // 左右手不同颜色，方便一眼看出模型有没有把两只手搞反
      drawGroup(leftHand, connections?.hand ?? null, LEFT_HAND_COLOR, 2.2);
      drawGroup(rightHand, connections?.hand ?? null, RIGHT_HAND_COLOR, 2.2);
    }
  }, [getFrame, connections, layers, width, height, mirrored, frameTick]);

  return (
    <canvas
      ref={canvasRef}
      className="mocap-overlay"
      style={{ width, height }}
      width={width}
      height={height}
    />
  );
}
