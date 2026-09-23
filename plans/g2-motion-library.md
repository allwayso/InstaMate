# G2：摄像头动作录入与动作库管理页面

> 分支基线：**`main`**（PR #1、PR #2 均已合入，G0/G1 代码已在 main 上）
> 拟用分支名：`feat/g2-motion-library`
> 门槛：`docs/Collaborate.md` §十一 G2 —— 同一真实动作驱动两个角色
>
> 基线核对（已 fetch 确认）：`origin/main` = `9b087b4`（Merge PR #2），
> `web/lib/{clip-spec,pose,clip-player,character-runtime,clip-catalog}.ts`、`tools/gen-clips.mjs`、`.gitattributes` 均在 main 上。

---

## 一、Context

G1 已经把「程序化动作 → clip v1 → 播放器 → normalized 骨骼」这条链路打通并验收通过。
G2 要把**动作的来源**从「手写关键帧」换成「真人摄像头」，并且**证明同一份 clip 能驱动两个不同的 VRM**。

产出物同时是一个给团队用的**动作库管理页面**：录制 → 裁剪 → 校验 → 保存 → 回放，全在浏览器里完成，
保存后写进仓库的 `web/public/clips/`，成为团队共享资产。

**不新增动作格式**：继续用 ClipFile v1，G1/G2/未来导入动作共用同一个播放器。

---

## 二、★ 已实测验证的关键发现（不是推理，源码/实验实锺）

我在动手前把风险最高的几处都验了一遍。**其中 3 条直接修正或推翻了原计划的假设。**

### F1 ✅ Kalidokit 的调用签名与原计划一致

来自 `kalidokit@1.1.5/dist/PoseSolver/index.d.ts`：

```ts
static solve(lm3d: TFVectorPose, lm2d: Omit<TFVectorPose,"z">,
             { runtime, video, imageSize, enableLegs }?: Partial<IPoseSolveOptions>): TPose | undefined
```

`Face.solve(lm, { runtime, video, imageSize, smoothBlink, blinkSettings })` 也一致。原计划写法正确。

### F2 ⚠️ **`lm3d` 必须是 `poseWorldLandmarks`（单位米），否则整条手臂被丢弃**

`PoseSolver.solve` 内部有一个离屏守卫：

```js
const rightHandOffscreen = lm3d[15].y > 0.1 || (lm3d[15].visibility ?? 0) < 0.23 || 0.995 < lm2d[15].y;
Arms.UpperArm.r = Arms.UpperArm.r.multiply(rightHandOffscreen ? 0 : 1);
Arms.UpperArm.r.z = rightHandOffscreen ? RestingDefault.Pose.RightUpperArm.z : Arms.UpperArm.r.z;
```

`lm3d.y > 0.1` 是**米**语义的阈值。我第一版探针把归一化 [0,1] 的点同时塞进 `lm3d`，
于是 `0.76 > 0.1` 恒真 → 手臂被乘 0 并写成 `RestingDefault`，输出恒为
`RightUpperArm.z = -1.25 / LeftUpperArm.z = +1.25`，**看起来像"对输入毫无反应"**。

> 这正是计划要「同时传 world + 普通 landmarks」的原因，但必须**显式断言**：
> 单元测试里加一条 —— 传归一化点进 `lm3d` 会得到 RestingDefault，传米制点才会变。

### F3 ⚠️ **Kalidokit 的左右与 MediaPipe 的命名是反的**

```js
const UpperArm = {
  r: Vector.findRotation(lm[11], lm[13]),   // MediaPipe: left_shoulder,  left_elbow
  l: Vector.findRotation(lm[12], lm[14]),   // MediaPipe: right_shoulder, right_elbow
};
```

守卫里 `rightHand` 用 `lm[15]`（MediaPipe 的 `left_wrist`）、`leftHand` 用 `lm[16]`（`right_wrist`）。
即 **Kalidokit 的 `Right*` = MediaPipe 的 `left_*` 命名**。

这与 MediaPipe 自己文档里那条著名前提吻合（Hands/Holistic 的 handedness **假设输入图像是镜像的**，
非镜像场景需要自行交换）。而原计划写的是 `selfieMode: false` + 「模型输入不镜像」。

**结论：这一条不能靠读文档定案，必须实测。** 计划里做成 `retarget-profile.ts` 里的**一个开关**，
并用一条明确的判据拍板：

> 真人抬**右手** → 看 `Pose.solve` 输出里 `RightUpperArm` 还是 `LeftUpperArm` 变了。
> 变的是 `Left*` → 需要交换。反过来看 VRM：抬右手时 `rightUpperArm` 必须动，
> 且按 G1 实测「角色自身右侧 = 世界 −X」用 `rightHand.x < 0` 数值断言验证。

### F4 ⚠️ Kalidokit 输出的是「Kalidokit rig 空间」，不能当作标准 Euler XYZ

`rigArm()` 原文（注释自称 "Returns Values in Radians for direct 3D usage"）：

```js
const invert = side === RIGHT ? 1 : -1;
UpperArm.z *= -2.3 * invert;
UpperArm.y *= PI * invert;
UpperArm.y -= Math.max(LowerArm.x);
UpperArm.y -= -invert * Math.max(LowerArm.z, 0);
UpperArm.x -= 0.3 * invert;
UpperArm.x = clamp(UpperArm.x, -0.5, PI);
LowerArm.z *= -2.14 * invert;  LowerArm.y *= 2.14 * invert;  LowerArm.x *= 2.14 * invert;
```

里面混了**非线性修正项、左右反向、clamp**，还有 `findRotation` 默认 `normalize: true`
（角度被除以 2π 再乘回来）。**这不是可以推导的标准 Euler 序列。**
→ 印证了「所有轴交换与符号修正集中在 `retarget-profile.ts`，靠实测定标」这一设计。

### F5 ⚠️ `kalidokit` 无法在 Node 里直接 import

`package.json` 里 `main: "dist/index.js"`，而该文件是 **ESM 且使用无扩展名的目录导入**
（`import ... from "./PoseSolver"`）—— Node 报 `Directory import ... is not supported`；
打包器能解析。

两层影响：
- 浏览器侧正常（打包器解析）；但 **`next dev`(Turbopack) 与 `next build` 都要各验一次**。
- **Node 侧的纯逻辑单测不能直接 import kalidokit**。所以 `kalidokit-solver.ts` 必须做成
  **可注入**（默认用真实现，测试注入假 solver），测试只喂「Kalidokit 形状的数据」。

### F6 MediaPipe 实际请求的文件清单（vendor 同步脚本的依据）

从 `holistic.js` 里反查出的直接请求：

```
holistic.binarypb
holistic_solution_packed_assets_loader.js   → 附带 .data (16.9 MB)
holistic_solution_simd_wasm_bin.js          → 附带 .wasm (6.5 MB)
holistic_solution_wasm_bin.js               → 附带 .wasm (6.4 MB)
pose_landmark_lite.tflite   (2.8 MB)
pose_landmark_full.tflite   (6.4 MB)   ← modelComplexity:1 用这个
pose_landmark_heavy.tflite  (27.7 MB)  ← 可省
```

→ 同步脚本复制约 **48 MB**（跳过 heavy），比整包 76 MB 省 37%。
`web/public/vendor/` **必须加进 `.gitignore`**（它们由 npm 包派生，体积太大，和 `*.vrm` 同理）。

### F7 ✅ 第二个 VRM 已实测，而且比预期更合适

原计划选 `pixiv/three-vrm` 的 `VRM1_Constraint_Twist_Sample.vrm`。我把它下载并用仓库自带
`tools/inspect-vrm.mjs` 跑了一遍：

| | Seed-san（现有） | VRM1_Constraint_Twist_Sample（第二角色） |
|---|---|---|
| humanoid 骨骼 | 51/55（缺 upperChest, jaw, leftEye, rightEye） | **54/55（只缺 jaw）** |
| **有 upperChest** | ✗ | **✓** |
| **lookAt.type** | `expression` | **`bone`** |
| 弹簧骨 | 9 组 / 19 关节 / 8 碰撞体 | 22 组 / 13 碰撞体 |
| body 比例 | hipsY 0.7956 / headY 1.332 | hipsY 0.9081 / headY 1.3863 |
| 作者 / 署名 | VirtualCast, Inc.（**署名必需**） | pixiv Inc.（`creditNotation: unnecessary`） |

**它正好压到两个能力分支**（`upperChest` 有无、`lookAt` 走骨骼还是表情），
且**身体比例不同** —— 这恰好验证了 G1「clip 只存旋转、不存骨长/位移」这个设计决定。

固定信息（可写进 manifest，不会漂移）：

```
url   https://raw.githubusercontent.com/pixiv/three-vrm/5a3242b66124386c32b085c6693d9059040e72e5/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm
commit 5a3242b66124386c32b085c6693d9059040e72e5   (2023-03-03，已 3 年未变)
bytes  10776032
sha256 12c2b97e95e700783a6a550dc0eee2d7880aeedccef9ae67bc4c5a2f0f2631a2
meta   authors=pixiv Inc. / licenseUrl=vrm.dev/licenses/1.0 / creditNotation=unnecessary
```

### F8 ⚠️ `index.json` 归属冲突（原计划没提，会真的丢数据）

`tools/gen-clips.mjs` 现在**整体重写** `web/public/clips/index.json`（只含它生成的 6 条）。
而 G2 的保存 API 要**追加** mocap 条目到同一个文件。
→ 谁后跑谁把对方抹掉：录完动作再跑一次 `npm run gen:clips`，录的动作就从目录里消失了。

**修法（建议）**：把 `gen-clips.mjs` 改成 **read-modify-write** —— 只替换 `source === 'generated'`
的条目，保留其它来源，`index.json` 的其余字段不动。并加一条测试锁住这个行为。

### F9 ⚠️ 原始关键点体积可能逼近请求上限

10 秒 × 30 fps = 300 帧，每帧 pose 33 + world 33 + 双手 42 + 面部 468 = 576 点 × 4 字段 ≈ 2300 个数
→ 单段约 **5–10 MB**（`web/public/clips/<id>.json` 只有约 100 KB）。
原计划定的 25 MiB 上限**偏紧**。建议：数值保留 4 位小数、`visibility` 缺省不写（省约 40%），
上限提到 32 MiB，并把实测体积写进验收记录。

---

## 三、Approach

按**关键路径**排阶段，让「离开摄像头也能做」的部分先做，把最大的未知（F3/F4 的轴向标定）
尽量往前挤，并且每个阶段结束时都有可验证的产物。

```
P0 基建（分支/依赖/vendor 同步/启动自检）        ← 先证 F5、F6，不然后面全白做
P1 纯逻辑：类型 + 重定向骨架 + 校准 + 平滑 + clip 生成 + 单测   ← 不需要摄像头，可离线做
P2 摄像头会话 + 关键点覆盖层 + 状态机
P3 ★ Kalidokit 接线 + 轴向实测标定（关键路径最大未知）
P4 裁剪时间轴 + 实时回放
P5 双角色 + 动作库页面
P6 保存 API（原子写入 + 校验 + 锁）
P7 验收与证据
```

### 关键设计决定

| 项 | 决定 | 理由 |
|---|---|---|
| 动作格式 | 继续 ClipFile v1，不加字段 | G1/G2/导入共用同一播放器；G2 专属信息放独立元数据 |
| 骨骼写入 | 仍只由 `CharacterRuntime` 写，只写 normalized | §七 禁双写；组件**不得**自己算骨骼旋转 |
| 左右修正 | 只放 `retarget-profile.ts` 一个开关 | F3 未定案，散落进组件就没法一处改对 |
| 校准公式 | `Qcorrection = Qbase × inverse(Qneutral)`，`Qtarget = Qcorrection × Qcanonical` | 原计划公式；必须用测试证明中立输入回到 `BASE_STANDING_POSE` |
| 采样时钟 | 按秒重采样到固定 30 fps，最短路径 slerp | 与 G1 播放器语义一致 |
| 推理串行 | `holistic.send()` 同一时刻只允许一个 | 避免视频帧积压 |
| 面部绘制 | 只画轮廓 + 主要方向点，不画 468 点三角网 | 遮挡 + 性能 |
| 双角色 | 两个 `CharacterRuntime`，共用一份采样结果，各 `commit()` 一次 | 满足「不复制、不重算、不针对角色改 clip」 |
| 原始 landmarks | 放 `data/mocap/`（**gitignore**，体积大），只经本地 API 下载 | F9 |
| clip JSON | 放 `web/public/clips/`（入库，约 100 KB/条） | 它是团队共享资产 |
| 保存写入 | 同目录临时文件 → 校验 → 依次 rename，`index.json` 最后 | 原计划；失败回滚只删本请求产生的文件 |
| `index.json` | `gen-clips` 改 read-modify-write，保留非 generated 条目 | F8 |

---

## 四、Files

### 新增 — 纯逻辑（可离线开发、可单测）

```
web/lib/mocap/mocap-types.ts      MocapRawFrame / MocapCaptureV1 / Landmark / 质量与校准结构
web/lib/mocap/retarget-profile.ts ★ Kalidokit → VRM normalized 的轴映射与符号（F3/F4 的落点）+ 左右开关
web/lib/mocap/calibration.ts      中立姿态采集、四元数统一符号后平均、corrections 计算
web/lib/mocap/smoothing.ts        四元数指数平滑（默认 80ms）+ 置信度回退（保持/渐变/标记丢失）
web/lib/mocap/clip-builder.ts     帧序列 → 重采样 30fps → 符号连续化 → ClipFile v1
web/lib/mocap/recording.ts        录制缓冲、时间戳、质量统计（有效率/最长丢失段/推理 FPS）
web/lib/mocap/kalidokit-solver.ts 包住 Kalidokit，**可注入实现**（F5：Node 侧不能直接 import）
web/lib/mocap/holistic-session.ts 摄像头 + Holistic 生命周期、串行推理、locateFile → 本地 vendor
```

### 新增 — UI / 路由

```
web/app/motion-library/page.tsx
web/app/api/motion-library/route.ts                GET / POST
web/app/api/motion-library/[id]/landmarks/route.ts GET
web/components/motion-library/motion-library-page.tsx   三区布局 + 状态机
web/components/motion-library/camera-capture.tsx        摄像头控制 + 设备选择
web/components/motion-library/landmark-overlay.tsx      Canvas 覆盖层
web/components/motion-library/mocap-vrm-preview.tsx     实时预览 / 录后回放 / 单双角色
web/components/motion-library/clip-trimmer.tsx          入点/出点裁剪
web/components/motion-library/motion-list.tsx           动作库列表 + 搜索 + 下载
```

### 新增 — 工具与测试

```
tools/sync-mediapipe.mjs          复制 npm 包里的 wasm/模型到 web/public/vendor/mediapipe/holistic/
tests/mocap-retarget.test.mjs     校准/权重/左右/轴映射
tests/mocap-clipbuilder.test.mjs  重采样、符号连续、裁剪、通过全部规则
tests/motion-library-api.test.mjs 保存 API：非法 ID/clip、超大体、同名 -2、失败不破坏 index
docs/G2-验收记录.md
```

### 修改

```
tools/gen-clips.mjs        改 read-modify-write（F8）
tools/fetch-assets.mjs     加第二角色（pinned commit + sha256，F7）
assets/vrm/*.manifest.json 第二角色 manifest
web/package.json           加 sync:mediapipe / test:mocap 脚本 + 两个依赖
.gitignore                 web/public/vendor/、data/mocap/、.firecrawl/
web/app/page.tsx           加页面间导航
web/components/display-case.tsx  只在必要时改动（加导航/抽取共用）
docs/Collaborate.md        §十一 补 G2 实现状态
README.md                  新页面与命令
```

---

## 五、Reuse（已有的，不要重造）

| 复用 | 位置 | 用途 |
|---|---|---|
| `ClipFile` / `CLIP_SPEC` / `validateClip` / `normalizeClipQuaternions` / `slerpQuat` | `web/lib/clip-spec.ts` | clip 生成后的格式校验；浏览器侧直接调用 |
| `validateClipFile(clip, targetBones)` | `web/lib/contracts.ts` | 保存前与导入时的浏览器侧校验入口 |
| `Quat`/`Pose`/`rotQ`/`mulQ`/`compose`/`normalizeQ`/`slerp`/`smoothstep` | `web/lib/pose.ts` | 全部四元数数学；**不要再写第三份 slerp** |
| `BASE_STANDING_POSE` / `baseQuatOf` / `RIG_AXIS_CONVENTION` / `ARM_DOWN_DEG` | `web/lib/pose.ts` | 校准的目标姿态；G1 实测出的轴向语义 |
| `CharacterRuntime`（`applyPose` / `applyBasePose` / `checkBones` / `commit`） | `web/lib/character-runtime.ts` | 唯一骨骼写入者；**双角色 = 两个实例**，各 `commit()` |
| `ClipPlayer`（`play/pause/seek/stop/reset/getSnapshot/update`） | `web/lib/clip-player.ts` | 录后回放；录制中**不用**它（实时姿态直传 runtime） |
| `ClipCatalogEntry` / `ClipSource`（**已含 `'mocap'`**）/ `fetchCatalog` / `loadClipFile` / `importClipFromFile` | `web/lib/clip-catalog.ts` | 动作库列表与导入，source 字段无需扩展 |
| `loadVrm(url, opts)` → `LoadedVrm{vrm,root,capabilities,dispose}` / `probeCapabilities` | `web/lib/vrm-character.ts` | 加载两个角色；能力探测（`lookAtType` 禁止写死） |
| `HUMAN_BONES_VRM1` / `PROJECT_USED_BONES` / `REQUIRED_BONES` | `web/lib/contracts.ts` | 骨骼白名单 |
| `tools/validate-clip.mjs --all/--fixtures/--target` | `tools/` | 命令行复验；保存 API 复用同一套规则 |
| `dev-browser.ps1` | `tools/` | 浏览器验收时的进程纪律 |
| `docs/G1-验收记录.md` 的写法 | `docs/` | G2 验收记录照同一结构写 |

---

## 六、Steps

> **执行状态（2026-09-22 23:20）**：步骤 1–39、41、42 已完成；
> 步骤 40（浏览器验收 10 项）**部分完成** —— 其中 25 项已由
> `tools/verify-mocap-pipeline.mjs`（假摄像头）自动验证，
> **真人对着摄像头的部分待执行**（见 `docs/G2-验收记录.md` §三）。
>
> 轴向标定（P3）实际经历了一轮真实的收敛过程，详见 `docs/G2-验收记录.md` §三·五：
> `za` 键名 → 交换左右时符号 → 标定姿势 → 手部桶名 → 腕自转 → 手指弯曲（两侧相反）
> —— 每一轮都是**实机反馈**定位的，不是推导出来的。

### P0 基建（先做，因为它决定后面是否白做）
- [x] `git switch -c feat/g2-motion-library origin/main`（基于已合入 G1 的 main）
- [x] 装 `@mediapipe/holistic@0.5.1675471629` + `kalidokit@1.1.5`（用国内镜像，锁版本）
- [x] 写 `tools/sync-mediapipe.mjs`，按 F6 清单复制到 `web/public/vendor/mediapipe/holistic/`
- [x] `.gitignore` 加 `web/public/vendor/`、`data/mocap/`、`.firecrawl/`
- [x] **冒烟：`import { Holistic } from '@mediapipe/holistic'` 在 `next dev` 与 `next build` 下都能编译**（F5）
- [x] **冒烟：`import * as Kalidokit from 'kalidokit'` 同上**；不行则加 `transpilePackages` 或改走 `dist/kalidokit.es.js`
- [x] 页面加运行时自检：vendor 文件缺失时给出**明确错误**（不是静默失败）

### P1 纯逻辑（不需要摄像头）
- [x] `mocap-types.ts`：`Landmark`(x/y/z/visibility **可为 null，不伪造 0**)、`MocapRawFrame`、`MocapCaptureV1`
- [x] `retarget-profile.ts`：映射表 + `AxisMap` + 符号 + **`swapLeftRight` 一个开关**（F3 待实测）
- [x] `calibration.ts`：收 1.5s、检测率 ≥80%、肩肘腕置信度检查、统一符号后平均、corrections
- [x] `smoothing.ts`：80ms 指数平滑 + 置信度三级回退（≤200ms 保持 / 200–500ms 渐变 / >500ms 标记丢失）
- [x] `clip-builder.ts`：裁剪区间 → 30fps 重采样 → 最短路径 slerp → 符号连续 → ClipFile v1
- [x] `recording.ts`：缓冲、时间戳、有效率 / 最长丢失段 / 推理 FPS 统计
- [x] 单测（全部离线）：校准中立输入 == `BASE_STANDING_POSE`；抬右手只动右臂；视觉镜像不改模型输入左右；
      spine 35/65 与 head 35/65 拆分正确；短缺失保持/长缺失回基础；变帧率重采样严格 30fps；
      符号无跳变；裁剪后 duration/frameCount 正确；生成 clip 通过现有全部规则
- [x] **回归：G1 的 15 项测试继续通过**

### P2 摄像头与状态机
- [x] `holistic-session.ts`：`getUserMedia`（640×480 @30）、`requestVideoFrameCallback`（回退 rAF）、
      串行 `send()`、`locateFile` → `/vendor/mediapipe/holistic/`、`close()` 释放 tracks 与实例
- [x] `landmark-overlay.tsx`：身体/手/脸三组开关；低于 0.5 黄色、严重丢失红色、左右手不同色；
      **视频镜像、模型输入不镜像**；覆盖层用同一视觉变换，保证对齐
- [x] `motion-library-page.tsx` 状态机：`camera-off → loading-model → detecting → calibrating → ready →
      countdown → recording → processing → reviewing → saving → ready`，异常进 `error` 并留重试入口
- [x] 录制流程：校准 → 3 秒倒计时 → 录制 → 手动停止或 10 秒自动停 → 处理

### P3 ★ 轴向标定（关键路径最大未知）
- [x] **实测哪一侧**：真人抬右手，看 `RightUpperArm` / `LeftUpperArm` 谁变（F3 判据）
- [x] **实测哪根轴**：分别抬臂/屈肘/转头，记录 `Pose.solve` 输出里哪个分量在变、方向如何
- [x] 把结果**写死进 `retarget-profile.ts` 的常量**，并在文件头注明「实测于 …，判据 …」
- [x] 用 VRM 侧数值断言确认：抬右手 → `rightHand.x < 0` 侧抬高，且左手 Δ = 0（精确 0）
- [x] 加断言：把归一化点当 `lm3d` 传进去会得到 RestingDefault（F2 的回归测试）

### P4 裁剪与回放
- [x] `clip-trimmer.tsx`：入点/出点拖动，最短 0.5s；显示选区时长
- [x] 停止后**切到 ClipPlayer 回放生成的正式 clip**（而不是继续用实时姿态），保证与动作库播放一致
- [x] 回放支持播放/暂停/时间轴定位（复用 G1 的控件模式）
- [x] 校验不通过时**保留原状态**、显示具体 issue，不做部分应用

### P5 双角色与动作库页
- [x] `fetch-assets.mjs` 拉第二角色（F7 的 url/commit/sha256），生成 manifest
- [x] `mocap-vrm-preview.tsx` 单/双角色切换：同一个 scene + renderer，左右并排，
      **两个 `CharacterRuntime` 共用同一份采样结果，各 `commit()` 一次**
- [x] `motion-list.tsx`：显示名/ID/来源/时长/帧率/帧数/骨骼/创建时间/跟踪有效率；
      播放、时间轴、下载 clip、下载 landmarks、切换预览
- [x] 导入流程复用 `importClipFromFile`（重名拒绝）+ `validateClipFile`；无 raw 的动作 `captureId = null`
- [x] G2 **不做**删除与重命名（避免误删团队资产）—— 在 UI 上明确标注

### P6 保存 API
- [x] `GET /api/motion-library`：返回目录
- [x] `POST`：`displayName` 1–40、`requestedId` 限 `[a-z0-9-]` ≤48、缺省 `mocap-YYYYMMDD-HHmmss`、
      同名 `-2/-3`、体限 32 MiB、**服务端重新校验 clip**、拒绝 `..`/斜杠/绝对路径、仅同源、
      非 localhost 或未设 `MOTION_LIBRARY_WRITE_ENABLED=1` → 403
- [x] 写入顺序：临时文件 → 校验 → rename；**`index.json` 最后替换**；失败回滚本请求产物；进程内保存锁
- [x] `GET /api/motion-library/[id]/landmarks`：只经本地 API 下载，不在 `public/`
- [x] 保存成功后页面刷新目录并自动选中新动作

### P7 验收与证据
- [x] `tools/gen-clips.mjs` 改 read-modify-write + 测试（F8）
- [ ] 浏览器验收 10 项（见 §七）
- [x] `docs/G2-验收记录.md`：clip ID + SHA-256 + capture ID、两个 VRM 名称与哈希、
      右手峰值高度变化、左手非目标位移/旋转变化、tracking 有效率、截图、全套命令结果
- [x] 更新 `docs/Collaborate.md` §十一 与 README

---

## 七、Verification

### 自动
```bash
cd web
npm run typecheck && npm run build
npm run test:mocap        # 新增：P1 的纯逻辑测试
npm run test:clip         # G1 的 15 项必须继续通过
npm run validate:all      # 含新录的 mocap 动作
npm run validate:fixtures # 规则本身没被改坏
npm run sync:mediapipe -- --check   # vendor 文件齐全
```

### 浏览器（需真实摄像头，用 `tools/dev-browser.sh` 管进程）
1. 启动摄像头，视频与覆盖层对齐
2. **抬右手 → 画面镜像但识别结果仍是 rightUpperArm**（F3 的最终判据）
3. 校准完成后 VRM 处于基础站姿
4. 实时抬手时 VRM 同侧手臂抬起
5. 录制 → 停止 → 裁剪 → 生成合法 clip
6. **同一 clip 在两个 VRM 上同时播放，方向一致**（G2 门槛）
7. 保存后刷新，动作仍在目录里
8. clip 与 landmarks 均可下载
9. **断网重载，Holistic 仍能工作**（证明不依赖 CDN）
10. 关闭页面后**摄像头指示灯熄灭**，MediaStream tracks 与 Holistic 实例均释放

### 手工判读注意
- 角色自身右侧 = 世界 −X（G1 实测），左右一律数值断言
- Seed-san 的 `robo_arm` 道具任何姿态都不动，不是蒙皮失败

---

## 八、⚠️ 需要你拍板的两件事

### 1. 时间：G2 门槛 21:00 只剩不到 2 小时，而全量计划我估约 6–10 小时
现在 19:08。全量做完，G2 会明显晚于门槛，后面 G3/G4 也会被压。

请选一个：
- **(a) 全量做**，里程碑顺延（我会先报一个修正后的时间线）
- **(b) 先做「最小 G2」**，只保 G2 的 7 条完成标准：能录 → 能裁剪 → 能存 → 双角色回放 → 刷新仍在 →
  关键点/骨架/置信度/FPS 可见 → 全本地资源。
  **砍掉**：动作库搜索、导入流程细节、录后过渡动画、覆盖层的美化、双角色的并排布局微调。
- **(c) 只做 P0+P1+P3 的「打通验证」**（能录一段、生成合法 clip、单角色回放），双角色与保存 API 放到明天。

### 2. 录下来的动作要不要入库？
我的建议：`web/public/clips/<id>.json` **入库**（约 100 KB，是团队资产，且门槛要求"刷新后仍在"）；
`data/mocap/<id>.landmarks.json` **不入库**（F9 实测可能 5–10 MB/段）→ `data/mocap/` 进 `.gitignore`，
代价是新克隆后 landmarks 下载失效（可接受，页面上要写明"原始关键点仅本机"）。

### 3. F3 的左右问题（不需要你拍板，但欢迎给结论）
我已经确定「Kalidokit 的 Right 对应 MediaPipe 的 left_*」，但**物理左右必须实测拍板**，
所以计划里它是一轮显式标定（P3）。如果你之前用 Kalidokit 调通过，直接告诉我结论
（`selfieMode` 用 true 还是 false、要不要交换左右）能省掉一整轮。
**默认按计划走实测，不需要你等我。**
