import { NextResponse } from 'next/server';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  avatarJobDir, readAvatarJob, resetAvatarJobState, spawnAvatarJob, writeJobFields,
} from '@/lib/avatar-jobs';
import { localRequestOnly } from '@/lib/local-request';
import { getTripoConfig } from '@/lib/tripo-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 换一张输入照片，并**只重跑背景清洗那一步**（5 积分）。
 *
 * 为什么不"删掉任务重新建一个"：那样用户给角色起的名字、选的风格就丢了，
 * 而它们和照片没有关系。这里换的只是图。
 *
 * 关键动作是 `resetAvatarJobState` —— 管线的续跑以 state.json 为判据，
 * 不清掉的话它会以为背景清洗已经做过了，直接拿旧图去建模。
 */
export async function PUT(request: Request, context: RouteContext<'/api/avatar-jobs/[id]/image'>) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  const { id } = await context.params;
  const job = await readAvatarJob(id);
  if (!job) return NextResponse.json({ error: '任务不存在' }, { status: 404 });
  if (job.generation_mode !== 'tripo') {
    return NextResponse.json({ error: '此任务使用阿里百炼图片流程' }, { status: 409 });
  }
  if (job.status === 'complete') {
    return NextResponse.json({ error: '任务已完成，不能再换图' }, { status: 409 });
  }
  if (Number(request.headers.get('content-length')) > 21_000_000) {
    return NextResponse.json({ error: '图片不能超过 20 MB' }, { status: 413 });
  }

  let tripo;
  try { tripo = await getTripoConfig(); }
  catch { return NextResponse.json({ error: 'Tripo API 地址不正确' }, { status: 503 }); }
  if (!tripo.key) return NextResponse.json({ error: '缺少 Tripo API Key' }, { status: 503 });

  try {
    const form = await request.formData();
    const image = form.get('image');
    if (!(image instanceof File) || image.size < 100 || image.size > 20_000_000) {
      return NextResponse.json({ error: '请上传不超过 20 MB 的 JPG 或 PNG 图片' }, { status: 400 });
    }
    const bytes = Buffer.from(await image.arrayBuffer());
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!png && !jpeg) return NextResponse.json({ error: '图片内容须为 JPG 或 PNG' }, { status: 400 });

    // 先停掉可能在跑的旧进程，避免两条管线写同一个目录
    if (typeof job.pid === 'number') {
      const { killAvatarJobTree } = await import('@/lib/avatar-jobs');
      await killAvatarJobTree(job.pid);
    }

    const dir = avatarJobDir(id);
    const image_name = 'input.' + (png ? 'png' : 'jpg');
    await writeFile(join(dir, image_name), bytes);
    await resetAvatarJobState(id);

    const pid = await spawnAvatarJob(id, 'ref', {
      TRIPO_API_KEY: tripo.key, TRIPO_BASE_URL: tripo.baseUrl,
    });
    await writeJobFields(id, {
      image_name, status: 'running', stage: '清洗背景并生成 T-pose 平面图',
      pid: pid ?? null, error: null,
      // 旧结果必须清掉：否则界面上还挂着上一张图的预览和"打开角色"的按钮
      preview_url: undefined, avatar_url: undefined,
    });
    return NextResponse.json(await readAvatarJob(id), { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '换图失败' }, { status: 500 });
  }
}
