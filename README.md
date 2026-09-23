# InstaMate 影伴

从一组照片、一段聊天记录还原出一个和你共享记忆的 3D 桌面伙伴

> 当前进度：P0/A 泳道已打通 **静态 VRM 渲染（G0）**、**程序化动作播放（G1）**，
> 以及 **摄像头动作录入与动作库（G2，实现完成；真人摄像头验收待执行）**。
> 实施规范见 `docs/Collaborate.md`（唯一真实参考）。
> 验收证据：`docs/G1-验收记录.md`、`docs/G2-验收记录.md`。

---

## 启动方式

**前置**：Node.js **≥ 20.9**（Next.js 16 的要求，推荐 24.x）与 npm。
拉资产用 Node 实现，**不需要 bash / curl**。

```bash
git clone https://github.com/allwayso/InstaMate.git
cd InstaMate

# 1) 拉示例 VRM 资产（两个角色，约 22 MB，不进 git，必须这一步）
node tools/fetch-assets.mjs

# 2) 同步 MediaPipe 本地资源（10 个文件 / 37.78 MB，不进 git，用动作录入必须这一步）
node tools/sync-mediapipe.mjs

# 3) 装依赖（用 ci 不用 install：保证版本与 lockfile 完全一致）
cd web && npm ci

# 4) 起开发服务器
npm run dev
```

- **http://localhost:3000** —— 角色调试台（G0/G1：静态渲染、环绕检视、动作播放）
- **http://localhost:3000/motion-library** —— 动作录入与动作库（G2）

**观察操作**：左键拖动旋转 · 右键拖动平移 · Shift + 左键平移 · Shift + 右键旋转 · 滚轮缩放 · 「归位视角」复位。

**G1 动作控件**（右侧面板）：动作选择 · 播放/暂停/继续/停止 · 循环 · 时间轴（拖动即逐帧定位并暂停）·
骨架辅助线 · 「恢复基础站姿」「参考姿态」· 导入本地 JSON。

**G2 动作录入**（`/motion-library`）：启动摄像头 → 校准 1.5 秒 → 3 秒倒计时 → 录制（最长 10 秒）→
裁剪 → 校验 → 保存进项目动作库 → 单/双角色回放。详见 `docs/G2-验收记录.md`。

### 启动成功的判据

| 检查 | 期望 |
|---|---|
| 页面 | 角色**双臂自然下垂**站立（基础站姿，**不是 T-pose**）、贴图正常，不是黑块也不是空白 |
| HUD「骨骼」 | `51 / 55，缺 upperChest, leftEye, rightEye, jaw` |
| HUD「表情 preset」 | `18` |
| HUD「弹簧骨」 | `9 组 / 19 关节 / 8 碰撞体` |
| HUD「lookAtType」 | `expression（实测，未写死）` |
| HUD「实测身高」 | `1.58 m` |

任一项不符，先看 HUD 有没有显示「加载失败」——最常见的原因是第 1 步没做（缺少 `web/public/avatars/sample.vrm`）。

---

## 换角色（含接入第三方模型）

角色**不再写死**。`public/avatars/*.vrm` 里的文件会自动出现在两个页面的下拉里：

- `http://localhost:3000/` —— 调试面板的「G0 · 静态资产」下拉
- `http://localhost:3000/motion-library` —— 「VRM 预览」的主角色 / 对照角色下拉

也可用查询参数指定：`http://localhost:3000/?avatar=/avatars/xxx.vrm`
（指向目录之外的路径也可以 —— 接口会把当前值补齐进选项）

### 从第三方 GLB 接入一个新角色

```bash
# 1) Tripo 生成（T-pose 是关键：clip 的轴语义依赖 rest pose）
cd tripo
python tpose_pipeline.py --image <照片> --upto ref     # 先出 T-pose 参考图：便宜且肉眼可判
python tpose_pipeline.py --run <run目录> --upto rig    # 几何 → 贴图 → 绑骨（out_format 默认 glb）

# 2) 转成 VRM（自动把朝向转到 +Z、缩放到米制，并自检）
cd ..
node tools/gltf-to-vrm.mjs <rigged.glb> -o web/public/avatars/hero.vrm --name "角色名" --height 1.75

# 3) 刷新页面，下拉里就有了
```

> **为什么必须是 T-pose**：clip 存的是 normalized-local 的**绝对**四元数，
> 而 normalized 骨骼的 rest rotation 恒为单位四元数、所有骨骼共享 rig 根坐标系 ——
> 于是"同一个四元数落在身体哪个方向"完全由 rest pose 决定。
> 本项目轴线约定是在 Seed-san（面朝 +Z、T-pose 手臂沿 ±X）上实测的。
>
> 转正必须**烘进模型数据**（顶点 + 骨架根 + inverseBindMatrices 三者配合），
> 给根节点加旋转是无效的 —— rig 会跟着一起转，轴与身体的相对关系不变。

---

## 常用命令

在 `web/` 下：

| 命令 | 作用 |
|---|---|
| `npm run dev` / `build` / `typecheck` | 开发服务器（:3000）／生产构建／类型检查 |
| `npm run inspect:vrm` | 打印示例 VRM 的能力探测结果 |
| `npm run gen:clips` | 重新生成全部程序化动作（产出即自检，不合格不写盘） |
| `npm run validate:all` | 校验 `public/clips/` 下全部动作 |
| `npm run validate:fixtures` | 跑校验器夹具：6 个坏的全被拒、合法的通过 |
| `npm test` | 全部 169 项（含 G1 回归、动捕纯逻辑、动作库 API 集成、资产目录） |
| `npm run verify:pipeline` | 25 项管线验证（假摄像头驱动整条动捕管线，含 10 条验收的可自动化部分） |
| `npm run test:clip` | 15 项播放与插值逻辑测试（G1 回归） |
| `npm run test:mocap` | 85 项动捕纯逻辑测试（重定向 61 + clip 烘焙 24，全离线） |
| `npm run sync:mediapipe` | 同步 MediaPipe 本地资源 |

在仓库根目录：

| 命令 | 作用 |
|---|---|
| `node tools/fetch-assets.mjs [--force]` | 拉取两个示例 VRM（固定 commit + sha256 校验） |
| `node tools/sync-mediapipe.mjs [--check]` | 同步 MediaPipe 本地资源；`--check` 只查不复制，缺文件时退出码 1 |
| `node tools/inspect-vrm.mjs <file.vrm> [--json\|--manifest]` | 能力探测 |
| `node tools/validate-clip.mjs <clip.json> [--target <manifest>]` | 校验动作文件，退出码 0/1/2 |
| `node tools/inspect-fbx.mjs <file.fbx> [--json]` | FBX 检查器（Node 直跑，不开浏览器）：骨骼层次 / **rest pose** / 尺度 / 朝向 |
| `node tools/gltf-to-vrm.mjs <in.glb> -o <out.vrm> [--name X] [--height 1.75] [--rotate auto\|<deg>] [--dry-run]` | **GLB → VRM 1.0 转换器**（接入第三方模型；产出即自检） |
| `bash tools/dev-browser.sh status\|up\|down` | 无头浏览器进程管家（仅 Windows） |

---

## 项目目录

```
.
├─ docs/                     文档与规范
│  ├─ Collaborate.md         ★ 实施主文档：角色划分 / 接口契约 / 时间线 / 验收门槛 G0–G5
│  ├─ 动作库接入说明.md       ★ clip v1 格式、轴向约定、三种接入方式、动捕接入流程
│  ├─ G1-验收记录.md          G1 自动化与人工验收证据
│  ├─ G2-验收记录.md          G2 实现状态、已自动验证项与待执行的摄像头验收
│  ├─ P0-A-第一步-方案与验收.md  实测数据与踩坑记录
│  └─ 赛道一_…_组队提案书.md/.pdf  比赛提交材料（不作为实施依据）
├─ web/                      Next.js 16 应用（App Router + TypeScript）
│  ├─ app/                   页面与 API 路由
│  ├─ components/display-case.tsx  3D 展示台：加载 VRM + 三点光 + 环绕检视 + 动作控件
│  ├─ lib/
│  │  ├─ contracts.ts        ★ 三份接口契约（唯一真相源）
│  │  ├─ clip-spec.ts        ★ clip v1 规格与校验规则（浏览器与 CLI 共用）
│  │  ├─ pose.ts             姿态数学与实测轴向约定、基础站姿
│  │  ├─ clip-player.ts      动作播放器（采样/混合/淡入淡出，不持有 VRM）
│  │  ├─ character-runtime.ts 唯一写身体骨骼的地方
│  │  ├─ clip-catalog.ts     动作目录、加载与导入
│  │  ├─ human-bones-vrm1.json  VRM 1.0 规范 55 根骨骼冻结表
│  │  └─ vrm-character.ts    VRM 加载器 + 运行时能力探测
│  ├─ lib/mocap/             动捕管线（类型/重定向/校准/平滑/裁剪/摄像头会话）
│  ├─ components/motion-library/  动作录入页的组件
│  ├─ public/avatars/        VRM 资产（不进 git，用 tools/fetch-assets.mjs 拉取）
│  ├─ public/clips/          动作库（clip v1 JSON + index.json 目录）
│  └─ public/vendor/         MediaPipe 本地资源（不进 git，用 tools/sync-mediapipe.mjs 生成）
├─ tools/                    命令行工具（拉资产 / 能力探测 / 动作生成 / 动作校验 / 进程管家）
├─ tests/                    校验器夹具 + 播放/插值/动捕/动作库 API 测试
├─ assets/vrm/               VRM 的 manifest（资产本身不进 git）
└─ PLAN.md                   本轮实施计划
```

---

## 已知坑（别的机器上最容易踩到的两条）

1. **直接跑 `npx tsc --noEmit` 会报 `Cannot find name 'LayoutProps'`**。
   `LayoutProps<'/'>` 是 Next 16 生成的全局类型，由 `next typegen` 产出。请用 `npm run typecheck`（已内置这一步），或先跑一次 `npm run build`。
2. **`AGENTS.md` / `CLAUDE.md` 不要删**（在 `web/` 下）。它们是 `next dev` 自动写入的 Next 16 破坏性变更提示，删掉会被重新生成，反而让工作区变脏。
