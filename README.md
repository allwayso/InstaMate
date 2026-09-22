# InstaMate 影伴

从一组照片、一段聊天记录还原出一个和你共享记忆的 3D 桌面伙伴

> 当前进度：P0/A 泳道已打通 **静态 VRM 渲染（门槛 G0）** 与 **程序化动作播放（门槛 G1）**。
> 实施规范见 `docs/Collaborate.md`（唯一真实参考），本轮计划见 `PLAN.md`。

---

## 启动方式

**前置**：Node.js **≥ 20.9**（Next.js 16 的要求，推荐 24.x）与 npm。
拉资产用 Node 实现，**不需要 bash / curl**。

```bash
git clone https://github.com/allwayso/InstaMate.git
cd InstaMate

# 1) 拉示例 VRM 资产（约 11 MB，不进 git，必须这一步）
node tools/fetch-assets.mjs

# 2) 装依赖（用 ci 不用 install：保证版本与 lockfile 完全一致）
cd web && npm ci

# 3) 起开发服务器
npm run dev
```

打开 **http://localhost:3000**。

**观察操作**：左键拖动旋转 · 右键拖动平移 · Shift + 左键平移 · Shift + 右键旋转 · 滚轮缩放 · 「归位视角」复位。

**G1 动作控件**（右侧面板）：动作选择 · 播放/暂停/继续/停止 · 循环 · 时间轴（拖动即逐帧定位并暂停）·
骨架辅助线 · 「恢复基础站姿」「参考姿态」· 导入本地 JSON。

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

## 常用命令

在 `web/` 下：

| 命令 | 作用 |
|---|---|
| `npm run dev` / `build` / `typecheck` | 开发服务器（:3000）／生产构建／类型检查 |
| `npm run inspect:vrm` | 打印示例 VRM 的能力探测结果 |
| `npm run gen:clips` | 重新生成全部程序化动作（产出即自检，不合格不写盘） |
| `npm run validate:all` | 校验 `public/clips/` 下全部动作 |
| `npm run validate:fixtures` | 跑校验器夹具：6 个坏的全被拒、合法的通过 |
| `npm run test:clip` | 15 项播放与插值逻辑测试 |

在仓库根目录：

| 命令 | 作用 |
|---|---|
| `node tools/fetch-assets.mjs [--force]` | 拉取示例 VRM（多镜像回退 + sha256 校验） |
| `node tools/inspect-vrm.mjs <file.vrm> [--json\|--manifest]` | 能力探测 |
| `node tools/validate-clip.mjs <clip.json> [--target <manifest>]` | 校验动作文件，退出码 0/1/2 |
| `bash tools/dev-browser.sh status\|up\|down` | 无头浏览器进程管家（仅 Windows） |

---

## 项目目录

```
.
├─ docs/                     文档与规范
│  ├─ Collaborate.md         ★ 实施主文档：角色划分 / 接口契约 / 时间线 / 验收门槛 G0–G5
│  ├─ 动作库接入说明.md       ★ clip v1 格式、轴向约定、三种接入方式、动捕接入流程
│  ├─ G1-验收记录.md          G1 自动化与人工验收证据
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
│  ├─ public/avatars/        VRM 资产（不进 git，用 tools/fetch-assets.mjs 拉取）
│  └─ public/clips/          动作库（clip v1 JSON + index.json 目录）
├─ tools/                    命令行工具（拉资产 / 能力探测 / 动作生成 / 动作校验 / 进程管家）
├─ tests/                    校验器夹具 + 播放与插值测试
├─ assets/vrm/               VRM 的 manifest（资产本身不进 git）
└─ PLAN.md                   本轮实施计划
```

---

## 已知坑（别的机器上最容易踩到的两条）

1. **直接跑 `npx tsc --noEmit` 会报 `Cannot find name 'LayoutProps'`**。
   `LayoutProps<'/'>` 是 Next 16 生成的全局类型，由 `next typegen` 产出。请用 `npm run typecheck`（已内置这一步），或先跑一次 `npm run build`。
2. **`AGENTS.md` / `CLAUDE.md` 不要删**（在 `web/` 下）。它们是 `next dev` 自动写入的 Next 16 破坏性变更提示，删掉会被重新生成，反而让工作区变脏。
