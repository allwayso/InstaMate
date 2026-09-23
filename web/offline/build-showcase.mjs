import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(webRoot, 'public');
const cssPath = path.join(webRoot, 'app', 'showcase', 'showcase.module.css');
const outputPath = path.join(webRoot, 'exports', 'instamate-showcase.html');

const media = {
  avatar: ['avatars/companion-trail2.vrm', 'model/gltf-binary'],
  photo: ['images/companion-source.jpg', 'image/jpeg'],
  hero: ['images/showcase-memory.png', 'image/png'],
  videoWebm: ['videos/companion-motion.webm', 'video/webm'],
  videoMp4: ['videos/companion-motion.mp4', 'video/mp4'],
  videoPoster: ['videos/companion-motion-poster.jpg', 'image/jpeg'],
};

async function dataUrl(relativePath, mimeType) {
  const bytes = await readFile(path.join(publicRoot, relativePath));
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

const assetUrls = Object.fromEntries(
  await Promise.all(
    Object.entries(media).map(async ([key, [relativePath, mimeType]]) => [
      key,
      await dataUrl(relativePath, mimeType),
    ]),
  ),
);

const css = await readFile(cssPath, 'utf8');
const classNames = [...new Set([...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((match) => match[1]))];
const styleMap = Object.fromEntries(classNames.map((name) => [name, name]));

const result = await build({
  entryPoints: [path.join(webRoot, 'offline', 'showcase-entry.tsx')],
  absWorkingDir: webRoot,
  bundle: true,
  write: false,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  define: { 'process.env.NODE_ENV': '"production"' },
  alias: { '@': webRoot.replaceAll('\\', '/') },
  plugins: [{
    name: 'inline-showcase-assets',
    setup(plugin) {
      plugin.onResolve({ filter: /^@\/lib\/showcase-assets$/ }, () => ({
        path: 'showcase-assets',
        namespace: 'showcase-offline',
      }));
      plugin.onLoad({ filter: /^showcase-assets$/, namespace: 'showcase-offline' }, () => ({
        contents: `export const showcaseAssets = ${JSON.stringify({
          avatar: assetUrls.avatar,
          photo: assetUrls.photo,
          videoWebm: assetUrls.videoWebm,
          videoMp4: assetUrls.videoMp4,
          videoPoster: assetUrls.videoPoster,
        })};`,
        loader: 'js',
      }));
      plugin.onResolve({ filter: /showcase\.module\.css$/ }, () => ({
        path: 'showcase-styles',
        namespace: 'showcase-offline',
      }));
      plugin.onLoad({ filter: /^showcase-styles$/, namespace: 'showcase-offline' }, () => ({
        contents: `export default ${JSON.stringify(styleMap)};`,
        loader: 'js',
      }));
    },
  }],
});

const javascript = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const styles = css.replace(
  "url('/images/showcase-memory.png')",
  `url("${assetUrls.hero}")`,
);
const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>InstaMate | 重建独属于你的影伴</title>
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; }
    body { background: #101b20; color: #fff; font-family: "Microsoft YaHei", "微软雅黑", "PingFang SC", "Segoe UI", system-ui, sans-serif; }
    ${styles}
  </style>
</head>
<body>
  <div id="app"></div>
  <script>${javascript}</script>
</body>
</html>`;

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, html);
console.log(`${outputPath} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MiB)`);
