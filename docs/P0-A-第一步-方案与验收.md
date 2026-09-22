# 附录 · VRM 示例资产实测与冻结表

> 本轮计划正文在 **`PLAN.md`**（仓库根）。本文档只保留**实测数据与冻结表**，供 B/C/D 引用，不重复计划步骤。
> 实测时间：2026-09-22，方法：解 GLB 的 JSON chunk（非文档抄录）。

---

## 一、示例资产选型

| 候选 | 体积 | `specVersion` | 结论 |
|---|---|---|---|
| **`Seed-san.vrm`**（vrm-c/vrm-specification 官方样例，VirtualCast 提供） | 10,917,800 B | `1.0` | ✅ **选定**。VRM 1.0 官方参考角色，能力最全 |
| `VRM1_Constraint_Twist_Sample.vrm`（three-vrm 示例目录） | 10,776,032 B | `1.0` | ❌ 约束/扭转专项样本，表情与弹簧骨不全 |
| VRoid Hub `AvatarSample_A/B` | — | `0.x` | ⚠️ 仅兜底。与 §七「正式资产用 VRM 1.0」不符，且有拇指骨骼名陷阱（见四） |

**拉取命令（资产不进 git）**

```bash
curl -sL -o web/public/avatars/sample.vrm \
  https://raw.githubusercontent.com/vrm-c/vrm-specification/master/samples/Seed-san/vrm/Seed-san.vrm
```

**sha256**（逐位比对用）

```
624d0d554bc205bbdc33e22a68a2c3c20edebb3e573011ead8878a65e5329b23
```

---

## 二、Seed-san 实测能力

| 项 | 实测值 | 服务哪个门槛 |
|---|---|---|
| `specVersion` | `1.0` | §八 验收 #1 |
| humanoid 骨骼 | **51 根**（含全部手指、脚趾、`shoulder`） | §八 #1、G1 |
| expressions preset | **18 个**，一个不少 | §八 #4、G4 |
| spring bone | **9 组 + 8 个碰撞体** | §八 #5、G4 |
| mesh / material / node | 5 / 17 / 147 | §八 #3 |
| 材质扩展 | `VRMC_materials_mtoon`、`KHR_materials_unlit` | §八 #3 |
| 其它扩展 | `VRMC_node_constraint`、`KHR_texture_transform`、`KHR_materials_emissive_strength` | — |
| `lookAt` | `type: "expression"`，`offsetFromHeadBone: [0, 0.0776, 0.1007]` | ⚠️ 见三 |
| 许可 | VRM Public License 1.0；`creditNotation: required`；`copyrightInformation: "VirtualCast, Inc."`；`avatarPermission: everyone`；`commercialUsage: corporation` | manifest 必填 |

**18 个表情逐个列出**（`§三` 的业务情绪映射要靠它）：

```
口型 : aa  ih  ou  ee  oh
眨眼 : blink  blinkLeft  blinkRight
情绪 : happy  angry  sad  relaxed  surprised  neutral
视线 : lookUp  lookDown  lookLeft  lookRight
```

> **自校验**：VRM 1.0 规范表共 **55 根**骨骼（已核对 `specification/VRMC_vrm-1.0/humanoid.md`；该文中另出现的 `leftFingers` / `rightFingers` 是**分组标题、不是骨骼名**）。
> 51 = 55 − 4，与实测缺失项完全吻合 → 解析结果可信。

---

## 三、两条必须写进契约的实测事实

### 1. 是 `expression` 型 lookAt，且没有眼球骨骼

缺失 `leftEye` / `rightEye`，lookAt 驱动的是 `lookUp/lookDown/lookLeft/lookRight` **四个表情**，不是眼球骨骼旋转。

| 影响 | 说明 |
|---|---|
| 契约 | `lookAtType` **必须由能力探测读取、禁止写死**。当前采样资产是 `expression`，而 B 用 VRoid 导出的很可能是 `bone` 型 —— 写死会在换资产时静默失效 |
| §十 | 控制权表里担心的"骨骼注视与 VRM lookAt 重复写同一通道"，在本资产上天然不存在，在 `bone` 型资产上是**真实风险** |
| 本轮 | **不做**注视相关设计（已按队长收敛），这里只记录事实，供下一步用 |

### 2. 没有 `upperChest`

脊柱链只有 5 段：`hips → spine → chest → neck → head`。相关代码路径**必须判空**，不能假定存在。

**补：** `jaw` 也缺失。

---

## 四、VRM 0.x 兜底时的骨骼名陷阱

若步骤一触发降级、改用 VRM 0.x 示例，注意拇指中段骨骼**改名了**：

| 位置 | VRM 0.x | VRM 1.0 |
|---|---|---|
| 拇指第 1 根 | `leftThumbProximal` | `leftThumbMetacarpal` |
| 拇指**中段** | `leftThumbIntermediate` | **`leftThumbProximal`** |
| 拇指末端 | `leftThumbDistal` | `leftThumbDistal` |

中段那根名字不同，**跨版本混用会静默丢一根骨骼**（不报错、只是少动一根）。`§七` 已规定 0.x 只在加载入口做版本兼容，本条是它的具体内容。

---

## 五、版本冻结表（2026-09-22 实测 npm）

| 包 | 冻结版本 | 依据 |
|---|---|---|
| `next` | `16.3.5` | 最新稳定 |
| `react` / `react-dom` | `19.3.0` | Next 16 要求 |
| `typescript` | 记录 `create-next-app` 实际装入值 | — |
| `three` | `0.186.0` | 最新（2026-09-08） |
| `@pixiv/three-vrm` | `3.5.5` | peer `three >=0.137` ✅；自带 `mtoon`/`springbone`/`node-constraint` 子包，恰好覆盖 Seed-san 用到的扩展 |
| Node | `24.16.0` | 本机已装 |
| npm | `11.13.0` | 本机已装 |
| `kalidokit` | `1.1.5` | C 泳道 |
| `@mediapipe/holistic` | `0.5.1675471629` | C 泳道，`§三.4` 已定「钉 0.5.x」 |

⚠️ **已知风险**：`three@0.186.0`（9/08）比 `@pixiv/three-vrm@3.5.5`（7/09）新两个月。**peer 允许 ≠ 验证过。**
**回退方案**：G0 失败 → `three` 退 `0.180.x`，其余不动，重跑 G0。

以上 8 项（不含 C 泳道两条）在步骤三写入 `docs/Collaborate.md` §三.4，作为**四份清单的第 1 份**。

---

## 六、Seed-san 的许可要点（manifest 必填）

| 字段 | 值 | 含义 |
|---|---|---|
| `licenseUrl` | `https://vrm.dev/licenses/1.0/` | VRM Public License 1.0 |
| `creditNotation` | `required` | **必须署名** |
| `copyrightInformation` | `VirtualCast, Inc.` | 署名内容 |
| `avatarPermission` | `everyone` | 可用作 avatar |
| `commercialUsage` | `corporation` | 允许商用 |
| `allowRedistribution` | `true` | 可再分发 |
| `modification` | `allowModificationRedistribution` | 可改可再分发 |

结论：**作为工程示例可用**，但演示材料/PPT 中出现该角色时必须署名 `VirtualCast, Inc.`。正式角色是 B 产出的 `companion.vrm`，本资产不进 git、不参与最终演示造型。

---

## 七、G0 通过记录（2026-09-22）

实测方式：dev server + 无头 Chrome（SwiftShader 软渲染 WebGL）截图与 DOM 取数，不是"看着像"。

| 判据（§十一 G0） | 实测结果 | 证据 |
|---|---|---|
| 材质完整 | MToon 材质 + unlit 全部正确解析，17 个材质无缺失，头发/面部贴图正常 | `g0-clean.png` |
| 朝向正确 | 相机在 +Z 侧看到角色正面 → **角色面向 +Z**，与 VRM 1.0 规范一致，无需 `rotateVRM0` 之外的修正 | `g0-clean.png` |
| 站姿正确 | T-pose 静止正常，无关节畸形、无穿模 | `g0-clean.png` |
| 无阻断错误 | 控制台与 dev server 日志均无 error | `/tmp/dev2.log` |
| 资产能力 | `inspect-vrm.mjs` 与运行时探测输出逐项一致 | 见下 |

运行时探测输出（调试页 HUD 实测）：

```
asset            Seed-san
specVersion      1.0（metaVersion 1）
骨骼             51 / 55，缺 upperChest, leftEye, rightEye, jaw
表情 preset      18
弹簧骨           9 组 / 19 关节 / 8 碰撞体
lookAtType       expression（实测，未写死）
实测身高         1.58 m（包围盒，含头发）
许可             required · VirtualCast, Inc.
```

### ⚠️ G0 抓到的两个真问题（已修）

**1. 弹簧骨有两个不同口径，混用会误判成 bug。**
第一版运行时探测报"19 组"，而 manifest 报"9 组"，看起来像对不上。真相：

| 口径 | 值 | 来源 |
|---|---|---|
| `springBoneGroups` | **9** | 规范级 `VRMC_springBone.springs` 条数（从 glTF JSON 读） |
| `springBoneJoints` | **19** | three-vrm 运行时持有的关节数（一组可含多个关节） |
| `springBoneColliders` | **8** | 碰撞体数 |

修正：`probeCapabilities()` 现在同时读 `gltf.parser.json`（规范级）与 `vrm.springBoneManager`（运行时），两个口径**分开报**。
这正是"探测输出必须与 manifest 一致"这条验收标准存在的意义。

**2. `three@0.186` 已不自带 TypeScript 类型。**
必须单独装 `@types/three`，且版本号要跟 `three` 对齐（都 `0.186.0`）。漏装会在写渲染代码时才炸。

### 给后续接手的人（B/C/D）

- **首次克隆后必须先 `npm ci`，再 `npm run build`（或 `npm run typecheck`）**。
  `app/layout.tsx` 用了 Next 16 生成的 `LayoutProps<'/'>` 全局类型，它由 `next typegen` 产出；没生成过就直接 `tsc --noEmit` 会报 `Cannot find name 'LayoutProps'`。
  已把 `typecheck` 脚本改成 `next typegen && tsc --noEmit`，直接跑脚本就没这个问题。
- **`AGENTS.md` / `CLAUDE.md` 不要删。** 那是 `next dev` 自动写入的 Next 16 破坏性变更提示；删了会被重新生成。
- **`web/app/layout.tsx` 里刻意不用 `next/font/google`** —— 它会在构建期联网拉字体，与 §三.4「禁 CDN 直连」冲突，现场断网会构建失败。

---

## 八、环绕检视（2026-09-22 追加）

调试页加了 `OrbitControls`，用于多角度检视资产，**不改本轮"静态渲染"的范围**（角色本身仍是静止的）。

| 操作 | 行为 |
|---|---|
| 左键拖动 | 绕模型包围盒中心旋转 |
| **Shift + 左键拖动** | **平移** |
| 右键拖动 | 平移（`screenSpacePanning = true`，跟随屏幕轴，检视角色最直觉） |
| **Shift + 右键拖动** | **旋转**（反转） |
| 滚轮 | 推近/拉远 |
| 触屏 | 单指旋转 · 双指平移 + 缩放 |
| 「归位视角」按钮 | 回到自动取景状态（关掉阻尼跑一次 `update()` 把 `_panOffset`/`_sphericalDelta` 归零，否则残留惯性会把相机继续推跑） |

参数：`enableDamping = true`、`dampingFactor = 0.09`、`minDistance = 0.25`、`maxDistance = 初始距离 × 10`。
枢轴取模型包围盒中心（不是原点），所以旋转不会绕偏。

### ⚠️ 走过的弯路：Shift 平移是 OrbitControls **自带**的，不要自己实现

我一开始以为需要手写「Shift + 左键 = 平移」，于是去改了 `controls.mouseButtons.LEFT`。
**结果反而把它搞坏了**。读源码（`examples/jsm/controls/OrbitControls.js` 的 `onMouseDown`）才看到内置反转：

```js
case MOUSE.ROTATE:                       // 左键默认映射
  if (event.ctrlKey || event.metaKey || event.shiftKey) {
    this._handleMouseDownPan(event);     // Shift + 左键 = 平移  ← 库已经做了
    this.state = _STATE.PAN;
  } else { /* ROTATE */ }

case MOUSE.PAN:                          // 右键默认映射
  if (event.ctrlKey || event.metaKey || event.shiftKey) {
    this._handleMouseDownRotate(event);  // Shift + 右键 = 旋转（反转）
    this.state = _STATE.ROTATE;
  } else { /* PAN */ }
```

因为我把 `LEFT` 改成了 `PAN`，按下 Shift 后就落到 `case MOUSE.PAN` + `shiftKey` 分支 → **反转又转回来了，变成旋转**。

**教训**：想要修饰键行为，先查库是否已有；`mouseButtons` / `touches` 这类映射是**默认值语义**，
去改它等于改变「默认」的含义，会与库内部基于默认值的分支逻辑打架。现在代码里显式断言了「不覆写默认映射」。

### 验证方式：CDP 真实派发鼠标事件，不是"看着像"

`web/components/display-case.tsx` 的 `__vrmDebug.readView()` 暴露**实时**相机状态（位置 / 枢轴 / 距离 / 极角 / 方位角），
`readControls()` 暴露 `mouseButtons` 实际值与 `pointerdown` 收到的 `shiftKey`，供自动化测试读取。
测试脚本用 Node 24 内置 WebSocket 直连 CDP，派发真实的 `mousePressed`/`mouseMoved`/`mouseReleased`/`mouseWheel`：

| 断言 | 结果 |
|---|---|
| 左键拖动 → 相机位置变、枢轴不变 | ✅ `[0.395,0.853,4.13]` → `[-3.293,-0.551,-1.845]` |
| 旋转保持枢轴距离 | ✅ 4.2759 → 4.2759 |
| 右键拖动 → 枢轴平移 | ✅ `[0.395,0.79,-0.145]` → `[0.501,1.034,-0.569]` |
| 右键平移是纯平移（Δpos == Δtarget） | ✅ `Δ[0.107,0.245,-0.424]` == `Δ[0.106,0.245,-0.424]` |
| 滚轮 → 推近 | ✅ 4.2759 → 3.8275 |
| 未覆写 OrbitControls 默认按钮映射 | ✅ `LEFT=0(ROTATE) RIGHT=2(PAN)` |
| Shift + 左键拖动 → 平移 | ✅ `[0.501,1.035,-0.569]` → `[0.593,1.229,-0.922]` |
| Shift + 左键是纯平移（Δpos == Δtarget） | ✅ `Δ[0.092,0.195,-0.353]` == `Δ[0.092,0.195,-0.353]` |
| Shift + 右键拖动 → 旋转（反转） | ✅ 枢轴不变、相机位置变 |
| 松开 Shift → 左键恢复旋转 | ✅ |
| 「归位视角」→ 精确回到初始取景 | ✅ 误差 < 5e-3 |
| 全程无崩溃，画布仍在 | ✅ |

**14/14 通过**。证据截图：`g0-clean.png`（初始正视）、`g0-orbit.png`（旋转后）。

> ⚠️ **测试脚本踩过的坑**：第一版 `__vrmDebug.camera` 是加载时算好的**死数组**，旋转后永远不会变，
> 导致测试假失败。改成 `readView()` 函数实时读取才测得出真实行为。
> 后续写 G3/G4/G5 自动化验收时，暴露给测试的状态一律要能**实时读取**，不要存快照。

---

## 九、开发环境纪律：headless Chrome 的 CPU 占用（2026-09-22）

### 先给结论：能被 CPU 打满，**是命令行 flag 选错，不是 headless 的锅**

对照实验（同一页面、同一台机器、各段均先 `down` 再开，全程只 1 个实例）：

| GL 后端 | 启动参数 | WebGL renderer | 帧率 | CPU 净增（16 逻辑核） |
|---|---|---|---|---|
| **hardware**（默认） | `--use-angle=default` | ANGLE (**AMD, AMD Radeon 780M, Direct3D11**) | **119.9 fps** | **+5%** |
| swiftshader（❌ 错用） | `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` | ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero))) | 20.9 fps | **+88%** |

**`--headless=new` 在 Windows 上完全能用真显卡**（走 ANGLE → Direct3D11）。
我一开始想当然地认为「无头环境没有 GPU，得退回软渲染」，于是主动加了 SwiftShader 参数，
把本来 5% 的开销放大到了 88%。**根因是自己的 flag，不是 headless 机制。**

参考：用户用 Edge 看同一个页面 CPU 一直很低 —— 因为 Edge 走的就是同一张 780M。

### 附带确认的两个事实

- **rAF 是 vsync 节流的**：hardware 模式下实测 **119.9 fps**，正好等于屏幕刷新率 120Hz。
  所以循环没有空转，也不会无限渲染。
- 软渲染下 20.9 fps 落在 §十一 G5 的「20–30 fps → 需降配」档位。
  **这恰好让 `-Gl swiftshader` 变成了一个有用的工具**：可以在本地模拟"目标机没独显"的情况，
  用来预演 G5 的降配分支。但不能拿这个数字判目标机性能，G5 仍必须到场用真实显卡实测。

### 另一个独立问题：进程叠着跑 + 整树杀

即使 GL 后端选对了，叠多个实例一样会出事。实测：**1 个实例 = 10 个 chrome 进程**（主进程 + renderer
+ gpu-process + utility×N + crashpad）。

- `pkill -f "remote-debugging-port"` **杀不干净**：它只匹配浏览器主进程的命令行，
  renderer/gpu 子进程命令行里没有这个标志 → 变孤儿继续跑 → 进程越积越多
- 必须 `taskkill /PID x /T /F` **整树杀**

### 规矩（`tools/dev-browser.sh`）

```bash
bash tools/dev-browser.sh status                # 进程数 + CPU 峰值 + 端口
bash tools/dev-browser.sh down                 # 清理 headless chrome（/T 整树杀）
bash tools/dev-browser.sh up                   # 先清后开，默认 hardware，只开 1 个实例
bash tools/dev-browser.sh up -Gl swiftshader   # 只在需要模拟无 GPU 目标机时用
bash tools/dev-browser.sh cpu                  # 只看 CPU
```

1. **GL 后端默认 hardware**（`--use-angle=default`）；不确认 GPU 路径之前不要加 SwiftShader 参数
2. **重开前必须先 `down`**，绝不叠着跑
3. **杀进程必须整树**（`taskkill /PID x /T /F`）
4. 用完立刻 `down`，并确认 **chrome.exe 归零**
5. CPU 采样取 **3 次峰值**（单次采样可能读到 0% 的假空闲；实测过第一次读到 0%）
6. 脚本只处理命令行里带 `--headless` 或本项目路径的 chrome.exe，**不会碰使用者自己正常用的 Chrome / Edge**

### 第三个坑：Chrome profile 缓存会被写坏

反复强杀 Chrome 会把 profile 的缓存写坏，页面报 `net::ERR_CACHE_READ_FAILURE`，表现为
「VRM 加载失败 / 模型 30 秒没加载出来」——看着像代码 bug，其实是环境脏了。
`dev-browser.ps1` 的 `down` 会顺手删掉 `.g0/chrome-profile`；启动时带 `--disable-http-cache`。

### 下次遇到 CPU 异常，按这个顺序查

1. `bash tools/dev-browser.sh status` → 先看**进程数**是不是叠了（1 个实例应该是 10 个进程）
2. `node .g0/fps.mjs` → 看 **WebGL renderer 字符串**：出现 `SwiftShader` 就是走了软渲染
3. 看 **帧率**：≈ 屏幕刷新率（如 120）说明正常；远低于刷新率且 CPU 高，就是渲染后端有问题
4. 都正常但 CPU 还高 → 才去查业务代码（死循环、重复 `vrm.update`、资源未释放）
