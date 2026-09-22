# InstaMate 影伴

从一组照片、一段聊天记录还原出一个和你共享记忆的 3D 桌面伙伴

> 当前进度：P0 / A 泳道已打通 **静态 VRM 渲染（门槛 G0）**。
> 实施规范见 `docs/Collaborate.md`（唯一真实参考），本轮计划见 `PLAN.md`。

---

## 项目目录

```
.
├─ docs/                     文档与规范
│  ├─ Collaborate.md         ★ 实施主文档：角色划分 / 接口契约 / 时间线 / 验收门槛 G0–G5
│  ├─ P0-A-第一步-方案与验收.md  实测数据与踩坑记录（资产能力、G0 证据、环境纪律）
│  └─ 赛道一_…_组队提案书.md/.pdf  比赛提交材料（不作为实施依据）
├─ web/                      Next.js 16 应用（App Router + TypeScript）
│  ├─ app/                   页面与 API 路由
│  │  ├─ layout.tsx          根布局（刻意不用 next/font/google，避免构建期联网）
│  │  └─ page.tsx            调试页入口
│  ├─ components/
│  │  └─ display-case.tsx    3D 展示台：加载 VRM + 三点光 + 环绕检视
│  ├─ lib/
│  │  ├─ contracts.ts        ★ 三份接口契约（唯一真相源）
│  │  ├─ human-bones-vrm1.json  VRM 1.0 规范 55 根骨骼冻结表
│  │  └─ vrm-character.ts    VRM 加载器 + 运行时能力探测
│  └─ public/avatars/        VRM 资产（不进 git，用 tools/fetch-assets.sh 拉取）
├─ tools/                    命令行工具
│  ├─ fetch-assets.sh        拉取示例 VRM 并校验 sha256
│  ├─ inspect-vrm.mjs        读取 .vrm 的骨骼/表情/弹簧骨/lookAt 能力
│  ├─ validate-clip.mjs      动作文件（clip v1）校验器
│  └─ dev-browser.sh         无头浏览器进程管家（仅 Windows）
├─ tests/fixtures/           validate-clip 的测试夹具（6 个故意做坏的 + 1 个合法）
├─ assets/vrm/               VRM 的 manifest（资产本身不进 git）
└─ PLAN.md                   本轮实施计划
```

---

## 启动方式

**前置**：Node.js **≥ 20.9**（Next.js 16 的要求；推荐 24.x）、npm、bash 或 Git Bash。

```bash
# HTTPS（推荐，队友机器不需要配 SSH key）
git clone -b feat/p0-static-vrm-render https://github.com/allwayso/InstaMate.git
# 或 SSH
git clone -b feat/p0-static-vrm-render git@github.com:allwayso/InstaMate.git
cd InstaMate

# 1) 拉示例 VRM 资产（约 11 MB，不进 git，必须这一步）
bash tools/fetch-assets.sh

# 2) 装依赖（用 ci 而不是 install：保证版本与 lockfile 完全一致）
cd web && npm ci

# 3) 起开发服务器
npm run dev
```

> 当前 P0/A 的成果在分支 `feat/p0-static-vrm-render` 上，`main` 还没有这些代码。

打开 **http://localhost:3000** —— 应看到 Seed-san 角色 + 右侧「G0 · 静态资产」面板。

**操作**：左键拖动旋转 · 右键拖动平移 · Shift + 左键平移 · Shift + 右键旋转 · 滚轮缩放 · 「归位视角」复位。

### 启动成功的判据

| 检查 | 期望 |
|---|---|
| 页面 | 角色静止站立、面色与服装贴图正常，不是黑块也不是空白 |
| HUD「骨骼」 | `51 / 55，缺 upperChest, leftEye, rightEye, jaw` |
| HUD「表情 preset」 | `18` |
| HUD「弹簧骨」 | `9 组 / 19 关节 / 8 碰撞体` |
| HUD「lookAtType」 | `expression（实测，未写死）` |
| HUD「实测身高」 | `1.58 m` |

任一项不符，先看 HUD 有没有显示「加载失败」——最常见的原因是第 1 步没做（缺少 `web/public/avatars/sample.vrm`）。

---

## 常用命令

需在 `web/` 目录下执行：

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发服务器（:3000） |
| `npm run build` | 生产构建 |
| `npm run typecheck` | `next typegen && tsc --noEmit`（**首次克隆必须先跑这个或 build**，见下方坑） |
| `npm run inspect:vrm` | 打印示例 VRM 的能力探测结果 |
| `npm run validate:fixtures` | 跑 clip 校验器夹具：6 个坏的全被拒、合法的通过 |

仓库根目录、不需要 `web/` 依赖的工具：

| 命令 | 作用 |
|---|---|
| `bash tools/fetch-assets.sh [--force]` | 拉取示例 VRM 并按 sha256 校验 |
| `node tools/inspect-vrm.mjs <file.vrm> [--json\|--manifest]` | 能力探测 |
| `node tools/validate-clip.mjs <clip.json> [--target <manifest>]` | 校验动作文件，退出码 0/1/2 |
| `bash tools/dev-browser.sh status\|up\|down` | 无头浏览器进程管家（仅 Windows） |

---

## 已知坑（别的机器上最容易踩到的两条）

1. **直接跑 `npx tsc --noEmit` 会报 `Cannot find name 'LayoutProps'`**。
   `LayoutProps<'/'>` 是 Next 16 生成的全局类型，由 `next typegen` 产出。请用 `npm run typecheck`（已经内置这一步），或先跑一次 `npm run build`。
2. **`AGENTS.md` / `CLAUDE.md` 不要删**（在 `web/` 下）。它们是 `next dev` 自动写入的 Next 16 破坏性变更提示，删掉会被重新生成，反而让工作区变脏。
