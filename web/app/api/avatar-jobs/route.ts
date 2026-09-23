import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { NextResponse } from 'next/server';
import { avatarJobDir, deleteAllFinishedAvatarJobs, listAvatarJobs, type AvatarJob } from '@/lib/avatar-jobs';
import { localRequestOnly } from '@/lib/local-request';
import { getAliyunImageConfig } from '@/lib/aliyun-image-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  return NextResponse.json({ jobs: await listAvatarJobs() }, { headers: { 'cache-control': 'no-store' } });
}

export async function DELETE(request: Request) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  try {
    return NextResponse.json(await deleteAllFinishedAvatarJobs(), { headers: { 'cache-control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: '清理生成记录失败，请检查本地文件' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  const repo = resolve(process.cwd(), '..');
  let aliyun;
  try { aliyun = await getAliyunImageConfig(); }
  catch { return NextResponse.json({ error: '百炼图片设置不正确，请检查本页服务设置' }, { status: 503 }); }
  if (!aliyun.key) return NextResponse.json({ error: '请先填写阿里百炼 API Key' }, { status: 503 });
  if (Number(request.headers.get('content-length')) > 21_000_000) {
    return NextResponse.json({ error: '图片不能超过 20 MB' }, { status: 413 });
  }
  let created: { job: AvatarJob; dir: string } | null = null;
  try {
    const form = await request.formData();
    const image = form.get('image');
    const name = String(form.get('name') ?? '').trim();
    const style = String(form.get('style') ?? 'anime');
    if (!(image instanceof File) || image.size < 100 || image.size > 20_000_000) {
      return NextResponse.json({ error: '请上传不超过 20 MB 的 JPG 或 PNG 图片' }, { status: 400 });
    }
    if (!name || name.length > 80 || !['anime', 'soft', 'chibi'].includes(style)) {
      return NextResponse.json({ error: '名称或动漫风格不合法' }, { status: 400 });
    }
    const bytes = Buffer.from(await image.arrayBuffer());
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!png && !jpeg) return NextResponse.json({ error: '图片内容须为 JPG 或 PNG' }, { status: 400 });
    if (aliyun.provider === 'qwen' && bytes.length > 10 * 1024 * 1024) {
      return NextResponse.json({ error: '千问图像编辑的参考照片不能超过 10 MB' }, { status: 413 });
    }
    const id = randomUUID().replaceAll('-', '');
    const dir = avatarJobDir(id);
    const image_name = 'input.' + (png ? 'png' : 'jpg');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, image_name), bytes);
    const now = new Date().toISOString();
    const job: AvatarJob = {
      id, name, style: style as AvatarJob['style'], image_name,
      image_provider: aliyun.provider, image_model: aliyun.model,
      status: 'queued', stage: '等待启动', created_at: now, updated_at: now,
    };
    await writeFile(join(dir, 'job.json'), JSON.stringify(job, null, 2));
    created = { job, dir };
    const imageEnv = { ...process.env };
    delete imageEnv.TRIPO_API_KEY;
    delete imageEnv.TRIPO_BASE_URL;
    Object.assign(imageEnv, {
      DASHSCOPE_API_KEY: aliyun.key,
      DASHSCOPE_BASE_URL: aliyun.baseUrl,
      ALIYUN_IMAGE_PROVIDER: aliyun.provider,
      ALIYUN_IMAGE_MODEL: aliyun.model,
    });
    const child = spawn(process.execPath, [join(repo, 'tools', 'avatar-job.mjs'), id, 'image'], {
      cwd: repo, env: imageEnv,
      detached: true, stdio: 'ignore',
    });
    await new Promise<void>((done, failed) => {
      child.once('spawn', done);
      child.once('error', failed);
    });
    child.unref();
    return NextResponse.json(job, { status: 202 });
  } catch (error) {
    if (created) {
      const failed = { ...created.job, status: 'failed', stage: '任务启动失败',
        error: error instanceof Error ? error.message : '任务启动失败',
        updated_at: new Date().toISOString() };
      const path = join(created.dir, 'job.json');
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(failed, null, 2));
        await rename(temporary, path);
      } catch {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : '任务创建失败' }, { status: 500 });
  }
}
