# PLAN — P0 / A 泳道：静态 VRM 示例渲染打通

> 本文件是**本轮计划**，也是 `docs/Collaborate.md` 第 5 行引用但一直缺失的 `PLAN.md`。
> 详细实测数据见附录：`docs/P0-A-第一步-方案与验收.md`

---

## Context

**为什么做这件事**

- 今天 9/22 是 Day 1，交付截止 9/23 晚间。`docs/Collaborate.md` 定的硬截止是 **G2（真实单侧抬手驱动两个角色）≤ 9/22 21:00**，而 G2 唯一的物理前置是"浏览器里能渲染出一个 VRM"。整条 G0→G2 链路上，**现在卡在零**。
- 仓库当前只有文档：`web/`、`assets/`、`tools/` **全部不存在**，没有任何可运行代码。
- 15:00 有接口冻结会，B/C/D 今晚要并行开工，他们需要的是**可执行的契约**，不是 Markdown。

**本轮目的（已按队长收敛）**

只要求**一个静态的 3D VRM 示例能被渲染出来** —— 即 `§十一` 的 **G0 静态资产**门槛。

**明确不做**（见文末 Out of scope）：注视 / lookAt / "它在看着我"，以及 G1 动态骨骼验收。这两项是下一步。

---

## Approach

三步串行，**每一步有独立验收，前一步不过不进入下一步**。理由：第 1 步没有资产，第 2 步无从渲染；第 2 步没有可运行页面，第 3 步的契约无法被 C 验证。

### 三步各自解决什么

| 步骤 | 解决 | 关键设计判断 |
|---|---|---|
| **一 · 拿到并校验示例 VRM** | "手里有资产，且资产的能力可被机器复核" | 资产**不进 git**（10.9 MB + 许可），改用脚本拉取 + manifest 记哈希；能力靠 CLI 探测而非人眼 |
| **二 · `web/` 骨架 + 版本冻结 + 静态渲染页** | "角色在屏幕上，且依赖版本被冻死" | 用 Next.js App Router（不是 Vite）——因为 `§二` 已把 `web/app/api/chat/` 划给 D，**只有 route handler 能把 LLM key 留在服务端** |
| **三 · 三份契约落成代码** | "B/C/D 不用猜字段名" | `contracts.ts` 作**唯一真相源**，`validate-clip.mjs` 从它 import 骨骼表，**不允许存在第二份清单** |

---

## 证据（已实测，不是文档抄录）

选型定为 vrm-c 官方样例 **`Seed-san.vrm`**（VirtualCast 提供，VRM 1.0）。我把它的 GLB JSON chunk 解出来实测：

| 项 | 实测值 | 服务哪个门槛 |
|---|---|---|
| `specVersion` | `1.0` | §八 验收 #1 |
| humanoid 骨骼 | **51 根**（含全部手指 / 脚趾 / shoulder） | §八 #1、G1 |
| expressions preset | **18 个全齐**：`aa/ih/ou/ee/oh`、`blink/blinkLeft/blinkRight`、`happy/angry/sad/relaxed/surprised/neutral`、`lookUp/Down/Left/Right` | §八 #4、G4 |
| spring bone | **9 组 + 8 碰撞体** | §八 #5、G4 |
| 材质 | 17 个，`VRMC_materials_mtoon` + `KHR_materials_unlit` | §八 #3 |
| 已知缺失骨骼 | `upperChest`、`jaw`、`leftEye`、`rightEye` | ⚠️ 见下 |
| `lookAt.type` | `"expression"` | ⚠️ 见下 |
| 许可 | VRM Public License 1.0，`creditNotation: required`，`VirtualCast, Inc.` | manifest 必填 |
| sha256 | `624d0d554bc205bbdc33e22a68a2c3c20edebb3e573011ead8878a65e5329b23` | 验收 1.2 |

> **自校验**：VRM 1.0 规范表共 55 根骨骼（已核对 `specification/VRMC_vrm-1.0/humanoid.md`；文中另有的 `leftFingers`/`rightFingers` 是分组标题不是骨骼名）。51 = 55 − 4，与实测缺失项完全吻合 → 解析结果可信。

**两条要写进契约、但本轮不做设计的事实**

1. 这份资产是 `expression` 型 lookAt 且无眼球骨骼 → `lookAtType` **必须由能力探测读取、禁止写死**，否则 B 后续用 VRoid 导出的 `bone` 型资产会静默失效。
2. 没有 `upperChest` → 脊柱链只有 5 段，相关代码路径必须判空。

---

## Files to modify

全部为**新建**，不改动任何现有文件（除两处追加/改写，已标注）：

| 路径 | 动作 | 归属 | 内容 |
|---|---|---|---|
| `.gitignore` | **追加** | A | `node_modules/`、`.next/`、`*.vrm` |
| `web/`（`package.json`/lockfile/`tsconfig.json`/`next.config.ts`） | 新建 | A | `create-next-app` 生成后按附录钉 8 项版本 |
| `web/app/page.tsx` | 新建 | A | 调试页骨架（§十一），本轮只放静态渲染 |
| `web/components/display-case.tsx` | 新建 | A | 加载 + 静态渲染 VRM（§二 已分配给 A） |
| `web/lib/vrm-character.ts` | 新建 | A | `GLTFLoader` + `VRMLoaderPlugin`；能力探测 → `VrmCapabilities` |
| `web/lib/contracts.ts` | 新建 | A | 三份契约 + 55 根骨骼冻结表（**唯一真相源**） |
| `tools/fetch-assets.sh` | 新建 | A | 可复现拉取 Seed-san |
| `tools/inspect-vrm.mjs` | 新建 | A | CLI 能力探测，输出须与 manifest 一致 |
| `tools/validate-clip.mjs` | 新建 | A（C 联验） | §九.2 十二条规则，退出码 0/1/2 |
| `tests/fixtures/*.json` | 新建 | A | 6 个故意做坏 + 1 个合法 |
| `assets/vrm/sample.manifest.json` | 新建 | A | 哈希 / 版本 / 能力 / 许可 / 已知缺失 |
| `docs/Collaborate.md` §三.4 | **改写** | A | 把 8 项版本写进"四份清单"的第 1 份 |
| `docs/P0-A-第一步-方案与验收.md` | **改写** | A | 降级为证据附录，消除与 PLAN.md 的重复 |

---

## Reuse

**诚实说明：这是一个空仓库，没有可复用的仓库内代码。** 可复用项全部来自已冻结的依赖与文档：

| 复用对象 | 出处 | 怎么用 |
|---|---|---|
| `GLTFLoader` + `VRMLoaderPlugin` | §十二 已论证的官方加载方式 | 直接照官方示例写加载路径，不自造 |
| `vrm.update(delta)` | §十二（VRM 1.0 规范明确 humanoid/lookAt/expression/springBone 的执行顺序影响结果） | 渲染循环里只调一次 |
| `@pixiv/three-vrm@3.5.5` 自带子包 | npm 实测依赖树 | `mtoon` / `springbone` / `node-constraint` **无需额外安装**，恰好覆盖 Seed-san 用到的扩展 |
| `§三` 的三段 TS / JSON 片段 | `docs/Collaborate.md` | 直接抄成 `contracts.ts`，不重新设计字段 |
| `.gitignore` 既有结构 | 仓库现状 | 追加即可，不重建 |

---

## Steps

### 步骤一 · 拿到并校验示例 VRM（预算 15 分钟）

- [ ] 1.1 写 `tools/fetch-assets.sh`，拉取 Seed-san 到 `web/public/avatars/sample.vrm`
- [ ] 1.2 `sha256sum` 与 `624d0d55…5329b23` 逐位一致
- [ ] 1.3 写 `tools/inspect-vrm.mjs`，输出骨骼数 `51` / 表情 `18` / 弹簧组 `9` / `lookAtType=expression`，与上表逐项一致
- [ ] 1.4 生成 `assets/vrm/sample.manifest.json`（含许可 `creditNotation: required`、`VirtualCast, Inc.`、已知缺失 4 根骨骼）
- [ ] 1.5 `.gitignore` 追加 `*.vrm`

> **降级触发：14:35 前 1.2 与 1.3 未同时通过** → 改用 VRoid Hub 的 VRM 0.x 示例 + 加载入口版本兼容（含 1.4 的拇指名映射：VRM0 是 `ThumbIntermediate`、VRM1 是 `ThumbMetacarpal`，**中段那根名字不同**），预算 +30 分钟，并同步给 C（影响重定向骨骼表）。**不要在找资产上继续耗时间。**

### 步骤二 · `web/` 骨架 + 版本冻结 + 静态渲染页（预算 25 分钟）

- [ ] 2.1 `create-next-app` 建 `web/`（TypeScript + App Router + 不用 Tailwind，减少变量）
- [ ] 2.2 按附录钉版本：`next@16.3.5`、`react@19.3.0`、`three@0.186.0`、`@pixiv/three-vrm@3.5.5`
- [ ] 2.3 `web/lib/vrm-character.ts`：加载器 + 能力探测
- [ ] 2.4 `web/components/display-case.tsx`：**静态**渲染（透视相机正视角色、三点光、模型居中、`vrm.update(delta)` 循环、加载失败有可见错误态）
- [ ] 2.5 `web/app/page.tsx` 挂载 `<DisplayCase />`
- [ ] 2.6 `npm run build` 与 `npx tsc --noEmit` **零错误**通过
- [ ] 2.7 删 `node_modules` → `npm ci` → 仍能渲染（验证 lockfile 真的是可复现的）

### 步骤三 · 三份契约落成代码（预算 30 分钟）

- [ ] 3.1 `web/lib/contracts.ts`：`CharacterController` / `DialogueEvent` / `ClipFile` / `RIG_PROFILE` / `HUMAN_BONES_VRM1`(55) / `VrmCapabilities`
- [ ] 3.2 `tools/validate-clip.mjs`：§九.2 十二条规则可执行化，退出码 `0/1/2`，支持 `--json`
- [ ] 3.3 `tests/fixtures/`：6 个故意做坏（`fps=0`、轨道短 1、非单位四元数、`mask` 不一致、非法骨骼名、`rootMotion` 非 locked）+ 1 个合法
- [ ] 3.4 `docs/Collaborate.md` §三.4 版本清单写实
- [ ] 3.5 `docs/P0-A-第一步-方案与验收.md` 改写为证据附录

---

## Verification

**端到端怎么验**

```bash
# 1. 资产可达
curl -sI localhost:3000/avatars/sample.vrm          # 期望 200
# 2. 能力探测与 manifest 一致
node tools/inspect-vrm.mjs web/public/avatars/sample.vrm
# 3. 复现性
rm -rf web/node_modules && npm --prefix web ci && npm --prefix web run build   # 期望 0 错误
# 4. 契约校验器
npm --prefix web run validate:fixtures              # 期望 6 坏全拒 + 1 好通过
# 5. 静态渲染
npm --prefix web run dev                            # 打开 localhost:3000，静态看到角色
```

**验收标准（逐条可判、可签字）**

| # | 判据 | 方式 |
|---|---|---|
| 1.1 | `sample.vrm` 落位且 dev 下 HTTP 200 | `curl` |
| 1.2 | sha256 逐位一致 | `sha256sum` |
| 1.3 | `inspect-vrm.mjs` 四项输出与证据表一致 | CLI |
| 1.4 | manifest 含许可与已知缺失骨骼 | 读文件 |
| 1.5 | `git status` 里没有 `.vrm` | `git status` |
| 2.1 | `npm run dev` 起得来，`localhost:3000` 返回 200 | curl |
| 2.2 | `build` + `tsc --noEmit` 零错误 | 两条命令 |
| 2.3 | lockfile 里 4 项版本与冻结表逐条一致 | `node -e` 断言 |
| 2.4 | 干净环境 `npm ci` 后仍能渲染 | 见上 |
| **2.5** | **G0 门槛（§十一）：材质完整、朝向/站姿正确、无阻断错误** | 人眼看动态首帧 |
| 3.1 | §三 三份 schema 的**每个字段**都能在类型里找到 | 逐条 diff |
| 3.2 | 6 个坏 fixture 全拒（退出码 1）、1 个好 fixture 通过（0） | `validate:fixtures` |
| 3.3 | 骨骼表全局唯一：`grep -rc "leftThumbMetacarpal" --include=*.ts --include=*.mjs .` 命中数为 1 | grep |
| **3.4** | **最强判据：C 在不看任何 Markdown 的前提下，只凭 `contracts.ts` + `validate-clip.mjs` 产出第一个通过的 clip** | C 实际生产 |

**朝向不靠猜**：VRM 1.0 规范为面向 +Z；2.5 时用调试页朝向辅助线**确认**，展示朝向修正只放模型外层容器（§七）。

---

## 风险与诚实的边界

1. **静态渲染通过 ≠ 资产可用。** `§八` 验收 #2 明说"骨骼映射正确不代表蒙皮正确，必须看动态结果"。G1（程序化抬手/屈肘/转头）**仍是必过门槛**，只是不在本轮 —— 本轮只证明"能加载、材质与朝向对"，**不证明**肩肘衣袖会不会塌陷穿模。
2. **three 0.186.0（9/08）比 three-vrm 3.5.5（7/09）新两个月**，peer 允许 ≠ 验证过。回退方案：G0 失败 → `three` 退 `0.180.x`，其余不动。
3. **15:00 冻结会需要额外拍板一项文档里没有的事**：窗口壳。提案说"透明桌面窗口"，但 Collaborate.md 全文只提浏览器渲染 —— 建议 G0–G2 全在浏览器验，**P3 再套 Electron 壳**，不上今晚关键路径。

---

## Out of scope（本方案明确不做，避免范围蔓延）

- ❌ 注视 / `lookAt` 追踪 / "它在看着我"（§四 的 Day 1 下午核心差异）→ 下一步
- ❌ 程序化抬手 / 屈肘 / 转头（G1 动态骨骼验收）→ 下一步
- ❌ 动捕链路（C）、形象产线（B）、对话语音（D）
- ❌ Electron 透明窗口壳 → P3
- ❌ 场景/光照美术、待机呼吸与眨眼生命层

---

## 15:00 冻结会需要拍板

| # | 决议 | 建议 |
|---|---|---|
| 1 | 窗口壳 | G0–G5 浏览器验，P3 套 Electron |
| 2 | `lookAtType` 写死还是探测 | **探测**，禁止写死 |
| 3 | 版本冻结 | 按附录表冻结；G0 通过即视为"实际验证过" |
| 4 | `sample.vrm` 归属 | 归 A 临时所有，B 不依赖；B 的 `companion-rough.vrm` 17:00 独立交付 |
| 5 | 朝向基准 | VRM 1.0 面向 +Z，G0 用辅助线确认 |
