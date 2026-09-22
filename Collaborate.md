# InstaMate · 影伴 — 4 人分工方案

> 两天赛程 · 赛道一 AI+影像
> 关联文档：`PLAN.md`、`docs/photo-to-3d-research.md`、`docs/companion-window-analysis.md`

---

## 一、已定案：两段式形象产线

```
照片(5–6张) ──AI动漫化──► 动漫设定图 ──┬─[主线]─► VRoid 捏人 ──► .vrm（有骨骼/表情/弹簧骨）
                                       └─[兜底]─► CharacterGen/Hunyuan3D ─► GLB ─UniRig─► VRM
直出照片→3D（Hunyuan3D 2mv）──────────► 仅作 2.5D 兜底与"全自动路线"演示素材
```

决策：**不做照片直出 3D**。3D 阶段主力 VRoid（确定产出），开源自动化路线只作探索与答辩素材。可靠兜底应是一个提前通过动态验收的示例 VRM；自动生成的网格即使完成自动绑骨，也仍需补齐 VRM 人形骨骼映射、蒙皮、表情、材质和弹簧骨配置，不能直接视为可替换角色。

开发顺序调整为：**先用一个粗版 VRM 跑通一段真实动作，再批量制作角色细节和动作库。** 角色资产、动作数据和渲染运行时的详细适配契约见第七至十二节。

---

## 二、角色划分

| 角色 | 负责模块 | 核心交付物 | 文件归属（单人所有，避免冲突） |
|---|---|---|---|
| **A · 角色集成（核心路径）** | WS 位置 → `vrm.lookAt.target` + 弹簧阻尼；眨眼/呼吸/Perlin 生命层；状态机 | 角色在窗里看着你（Day 1 下午必须跑通） | `web/components/display-case.tsx`、新增 `web/lib/vrm-character.ts`、`web/lib/state-machine.ts` |
| **B · 形象产线** | 拍摄规范 → 动漫设定图 → VRoid 捏人 → VRM 1.0 → 动态验收 | 一个通过骨骼、蒙皮、表情测试的专属 VRM | `assets/vrm/`、`web/public/avatars/` |
| **C · 动捕与动作库** | 录像 → MediaPipe + Kalidokit → 标准骨架重定向 → JSON clip；播放器 + 渐变混合 | 先交付 1 个通过双角色测试的动作，再扩展到 6 个 | `tools/mocap/`、`web/lib/clip-player.ts`、`web/public/clips/*.json` |
| **D · 对话·记忆·语音 + 演示包装** | LLM(注入记忆 JSON) + edge-tts + 音量驱动嘴型 + 情绪表情；演示脚本/PPT/备份视频 | 对话环 + 3 分钟演示 | `web/components/chat-panel.tsx`、`web/app/api/chat/`、`data/memory.json`、`docs/demo-script.md` |

---

## 三、接口契约（Day 0 晚全员 30 分钟冻结）

### 1. `CharacterController`（A 提供，C/D 只消费）

```ts
type CharacterState = 'idle' | 'noticing' | 'tracking' | 'listening' | 'thinking' | 'speaking';

interface CharacterController {
  setLookTarget(pos: { x: number; y: number; z: number } | null): void;
  playClip(name: string, opts?: { fadeIn?: number; fadeOut?: number; loop?: boolean }): Promise<void>;
  stopClip(): void;
  setMouthOpen(value: number): void;                 // 0..1
  setExpression(name: 'happy' | 'sad' | 'surprised' | 'neutral'): void;
  setState(state: CharacterState): void;
  onStateChange(cb: (s: CharacterState) => void): () => void;
}
```

补充语义：`fadeIn`/`fadeOut` 单位为秒；`setLookTarget` 接收 Three.js 世界坐标，单位米，传入 `null` 时平滑回正；`onStateChange` 返回退订函数；非循环 `playClip` 在播放完成后 resolve，加载失败或被新动作取代时给出可识别的错误/取消结果。A 负责模型卸载、事件退订和 GPU 资源释放。

### 2. clip JSON schema（A/C 共同冻结，C 产出）

```json
{
  "schemaVersion": 1,
  "rigProfile": "vrm-normalized-v1",
  "name": "format-example",
  "space": "normalized-local",
  "rotationMode": "absolute",
  "quaternionOrder": "xyzw",
  "fps": 30,
  "frameCount": 2,
  "duration": 0.03333333333333333,
  "loop": false,
  "rootMotion": "locked",
  "mask": ["rightUpperArm"],
  "bones": {
    "rightUpperArm": [[0, 0, 0, 1], [0, 0, 0, 1]]
  }
}
```

骨骼名使用 VRM 标准人形骨骼名，旋转必须已转换到 normalized 骨架的局部空间。示例只说明数据结构，不是可验收的挥手动作。完整规则见第九节。

### 3. 对话事件 schema（D 定义）

```ts
{ userText: string, replyText: string, emotion: 'happy' | 'sad' | 'surprised' | 'neutral', audioUrl: string, durationMs: number }
```

驱动状态机事件：`listening` → `thinking` → `speaking`。

### 4. 依赖与环境

- A：`three` + `@pixiv/three-vrm`，锁定一组实际验证过的兼容版本
- C：`npm i kalidokit @mediapipe/holistic`
- D：LLM API key + `edge-tts` 可用性验证
- JS 依赖统一进入 `web/package.json` 和 lockfile；Python CLI、MediaPipe 模型/WASM、TTS 运行环境分别记录并验证

---

## 四、时间线（四泳道）

### Day 0 晚（准备，1–2 小时）

| A | B | C | D |
|---|---|---|---|
| 示例 VRM + 程序化抬手 + 控制器骨架 | 导出最简 VRM 1.0 粗版，参加骨骼/蒙皮验收 | 录单侧抬手，验证解算环境；与 A 冻结动作契约 | 确认 LLM/TTS；用假控制器验证对话事件 |

### Day 1 上午：形象产线

| A | B | C | D |
|---|---|---|---|
| 与 C 跑通真实抬手 clip；验证同一动作复用两个角色 | 设定图 → 捏人；先交粗版 .vrm，不等美术完稿 | 解算 → 重定向 → clip；先让真实抬手通过渲染验收 | 对话页 + 记忆 JSON + edge-tts |

### Day 1 下午：它看着你（核心差异）

| A | B | C | D |
|---|---|---|---|
| ⚠️ **lookAt 与动作叠加必须跑通** + 眨眼/呼吸 | 专属 .vrm 通过同一动作集测试；调位/光 | 首个动作通过后扩展动作库，优先挥手/点头/说话手势 | 嘴型与表情对接，同时播放动作检查冲突 |

### Day 2 上午：动捕 + 对话

| A | B | C | D |
|---|---|---|---|
| 状态机接通全部 clip 与对话事件 | 形象微调 + 备选形象（应对"不像"） | clip 裁剪循环 + 平滑；接入状态机 | 记忆演示调通 + **备份视频录制** |

### Day 2 下午：整合与彩排

| A | B | C | D |
|---|---|---|---|
| 修 bug、保稳定 | 配合彩排 | 配合彩排 | 演示脚本彩排 3 遍（全员） |

---

## 五、决策点与风险替补

| 时间 | 责任人 | 触发信号 | 对策 |
|---|---|---|---|
| Day 1 中午 | B | 形象"不像" | 抓发型/眼镜/主色 3 个标志特征，不纠缠 |
| Day 1 下午 | A | lookAt 方向错误/反向 | 全员支援；用鼠标模式二分排查镜像与坐标映射（项目最大集成风险） |
| Day 1 中午 | A/C | 一段真实抬手仍不能正确驱动角色 | 暂停批量录像，用标准骨架程序化动作保住演示链路，并集中排查镜像、坐标系和重定向 |
| Day 2 中午 | C | 次要 clip 出不来 | 保留已验收动作，其余退化为程序化动画，**状态机和动作契约不变** |
| 全程 | D | 现场网络故障 | 预生成 3 条常见问答音频 + 完整备份视频 |
| 全程 | D | 现场光线差/追踪丢失 | 演示位补光；切鼠标模式保底 |

---

## 六、待确认事项

1. **技能映射**：谁强前端/Three.js（→A）？谁强 AI 绘图与美术（→B）？谁强 Python/视频处理（→C）？谁强后端/Agent（→D）？
2. **GPU 资源**：是否有 NVIDIA 独显或云 GPU？有则 B 可并行试 CharacterGen 兜底，无则 VRoid 单线。
3. **出镜与主讲**：形象与动捕是否同一人？建议出镜人 = 主讲人（叙事最完整），但当天需预留拍摄时间。

---

## 七、统一适配架构

```text
B：照片 → VRoid → VRM 1.0 → 资产验收 ──────────────────────┐
                                                          ↓
C：录像 → 关键点 → 姿态解算 → 重定向 → 标准动作 JSON → A：采样/混合
                                                          ↓
D：对话/语音 → 状态、表情、嘴型意图 ───────────────→ A：统一控制器
                                                          ↓
                           normalized 人形骨架 → VRM.update → 渲染
```

适配发生两次：C 把拍摄人物的动作转换到项目公共骨架；A 再通过 three-vrm 的 normalized human bones 把公共姿态应用到当前 VRM。B 必须保证资产的 humanoid 映射和蒙皮正确。动作文件不引用 VRoid 导出的实际节点名，也不保存拍摄者的骨长。

统一约定：

- 正式资产使用 VRM 1.0；如果引入 VRM 0.x，只在加载入口做版本/朝向兼容并重新验收。
- 动作只写 normalized human bones，不直接写 raw bones。three-vrm 文档说明 `VRMHumanoid.update()` 会在 `autoUpdateHumanBones` 开启时把 normalized 姿态同步到 raw bones；因此运行时要避免 normalized/raw 双写。
- 项目空间为右手系、Y 向上、米为单位；标准角色面向 +Z，左右以角色自身为准。展示朝向修正放在模型外层容器，不烘进动作。
- MVP 锁定站立、原地、以上半身为主的动作；保留目标角色自己的骨长和关节位置，不写关节平移、骨骼缩放和根运动。
- `vrm-normalized-v1` 是项目内部 rigProfile，记录骨骼表、参考姿态、轴定义和转换测试，并不代表任意第三方 VRM 都自动兼容。

## 八、VRM 角色交付与验收（B 主责，A 联验）

每个正式角色交付：

| 产物 | 建议位置 | 内容 |
|---|---|---|
| VRoid 源工程 | `assets/vrm/` | 保留可修改源文件 |
| 运行资产 | `web/public/avatars/companion.vrm` | 与 A/C 验收的是同一导出文件 |
| manifest | `assets/vrm/companion.manifest.json` | 文件哈希、VRM/导出器版本、身高、表情与弹簧骨能力、已知问题 |
| 验收记录 | `assets/vrm/companion-validation.md` | 使用的动作版本及静态/动态测试结果 |

角色每次重新导出都更新哈希并重跑关键动作。验收包含：

1. 加载器成功解析 VRM 1.0，必要 humanoid 骨骼存在；脊柱、头颈、双臂、双手等项目实际使用的骨骼可用。
2. 用程序化测试姿态做单侧抬手、屈肘和转头；网格正确随动，肩、肘、衣袖没有严重塌陷、断裂或穿模。骨骼映射正确不代表蒙皮正确，必须看动态结果。
3. VRM/MToon 材质、贴图、透明头发和面部在实际渲染页正确；不能为省事统一替换普通材质。
4. 验证 `blink`、`aa` 和业务情绪映射。业务 `neutral` 表示清除业务情绪权重，不强制资产存在同名表情；缺失能力写入 manifest 并降级。
5. 若资产配置了 spring bones，转头和动作时头发/衣物稳定，碰撞体合理。人体动作轨道不能写头发链。
6. 定位和展示缩放放在外层容器；多次加载/卸载不产生重复更新循环和持续资源增长。

## 九、人物动作适配（C 主责，A 联验）

### 9.1 采集到动作文件

1. 固定机位和光线，人物躯干、肘、手腕尽量完整入镜；每段先保持自然站立，再录单侧抬手/屈肘/挥手。初期避开转身、遮挡和交叉手臂。
2. 明确视频是否镜像。预览镜像和解算输入分离，只在一个边界修正左右；用“人物自己的右手抬起”作为固定测试。
3. 同时保留 MediaPipe 图像关键点、world landmarks、时间戳和置信度。官方文档说明 world landmarks 单位为米，原点在两髋中心，但它不是 Three.js 世界坐标，也不应直接写到角色关节。
4. 按 Kalidokit 官方调用约定把 world 关键点和普通 pose 关键点同时传给 `Pose.solve`，固定 `runtime` 和版本。其输出需通过样本确认 Euler 顺序、轴向、局部/世界含义，不能直接复制给 VRM。
5. 重定向器完成源骨骼名映射、坐标基变换、参考姿态偏移和父子空间转换，最后输出 normalized 骨骼的绝对局部四元数。
6. 重采样为 30 fps，规范化四元数、修正四元数符号跳变，裁掉无效头尾，再导出 JSON。
7. 同一 clip 先驱动示例 VRM，再驱动专属 VRM；无需修改文件即可保持左右、屈肘方向和动作节奏，才算交付。

重定向必须处理：

- 如果源输出是世界旋转，在统一坐标基后按同一乘法约定换算局部旋转：`Qlocal = inverse(QparentWorld) × QboneWorld`。如果 Kalidokit 输出已经是局部角度，不能重复换算。
- 让源参考姿态映射到 normalized 参考姿态，为上臂、前臂等链校准骨轴。只对应骨骼名称、直接复制 Euler 角不足以保证兼容。
- clip v1 保存 absolute normalized-local 四元数；播放器采样后直接作为该层目标，不再额外乘参考旋转。
- 保留目标 VRM 的骨长；不把 MediaPipe 世界坐标当作目标骨骼位置，也不缩放每根骨骼去拟合真人。
- 单目姿态对上臂扭转、手腕朝向和遮挡肢体有天然歧义，使用稳定默认值、幅度限制和低置信度回退。关键点可视化正确不能证明重定向正确。

### 9.2 clip v1 校验规则

- `frameCount >= 2`、`fps > 0`，第 n 帧时间为 `n / fps`，`duration = (frameCount - 1) / fps`，容差 `1e-6` 秒。播放器按真实经过时间采样，不假定渲染帧率等于 clip fps。
- 每条轨道长度等于 `frameCount`；每个四元数包含四个有限数字并近似单位长度。导出时规范化；加载误差不超过 `1e-3` 可再规范化，零长度或明显异常则拒绝。
- `mask` 与轨道名称集合一致，名称来自冻结的 VRM 人形骨骼表；目标缺少被使用骨骼时默认拒绝动作并报告名称。
- 相邻四元数点积为负时翻转后一项符号，插值使用最短路径 slerp。循环片段同时检查首尾姿态和接缝速度。
- v1 禁止根位移、骨骼缩放、表情轨道和弹簧骨轨道。嘴型、眨眼和情绪由运行时分别合成。
- 未被 mask 覆盖的骨骼由基础姿态或其他合法层控制；动作结束时所有占用骨骼渐变回基础姿态，不能遗留最后一帧。

动作优先级：P0 单侧抬手/屈肘用于诊断；P1 挥手、点头、说话手势用于演示；P2 思考、开心、待机小动作。G2 验收前不批量制作 P2。

## 十、动态渲染与控制权（A 主责）

加载器使用 `GLTFLoader + VRMLoaderPlugin` 解析模型，加载后缓存 normalized 参考姿态、检查能力并进入 `ready`；ready 前不播放动作。C 的播放器只返回某时刻姿态，D 只发送状态/表情/嘴型意图，最终骨骼和表情写入集中在一个 `CharacterRuntime`。

建议每帧顺序：

1. 读取真实 delta；浏览器恢复前台时把单步 delta 暂限为 0.05 秒，防止弹簧骨突然爆振。
2. 从稳定基础姿态采样当前/下一动作，按 mask 和 fade 权重混合；建议淡入淡出 0.15–0.3 秒。
3. 叠加小幅呼吸/待机；动作占用同一骨骼时该层减权。
4. 计算注视并分配头颈控制权：点头动作优先，眼球可继续跟踪；避免骨骼注视和 VRM lookAt 重复写同一通道。
5. 一次性写入 normalized bones，合成情绪、眨眼和嘴型。
6. 更新目标/场景所需的世界矩阵，调用一次 `vrm.update(delta)`，再渲染。VRM 1.0 规范明确 humanoid、lookAt、expression 和 spring bone 的执行顺序会影响结果；以冻结的 three-vrm 版本行为为准，检查一帧延迟和双重更新。

控制权冻结如下：

| 通道 | 默认来源 | 冲突规则 |
|---|---|---|
| 身体/手臂 | 当前动作 | 按 mask 接管，结束时混回基础姿态 |
| 头/颈 | 注视 | 点头占用时注视减权，结束后渐变恢复 |
| 眼睛 | VRM lookAt | 同一资产只启用一种 lookAt 类型/驱动路径 |
| 眨眼 | 程序生命层 | 与情绪 expression override 联验，确保可恢复 |
| 嘴部 | 音量 → `aa` | 音频停止、取消或报错立即归零 |
| 情绪 | D 的业务意图 | 清旧权重后渐变到新表情，缺失能力降级 |
| 头发/衣物 | spring bones | clip 不写，排错时可独立关闭 |
| 世界位置/缩放 | 模型外层容器 | clip v1 不移动根节点 |

`viewer_position_m` 必须先从追踪坐标转换为 Three.js 世界坐标，再交给 `setLookTarget`。调试页同时显示原始输入、转换后目标点和方向辅助线；先用鼠标目标验证左右/上下，再接 WebSocket。追踪丢失时平滑回正，不停止身体动作。

## 十一、兼容性验收门槛

A 建一个共用调试页，包含角色切换、骨架显示、参考姿态复位、左右抬手按钮、clip 选择、暂停/单步、注视目标可视化、各层开关，以及资产版本、rigProfile、播放时刻、缺失骨骼和错误信息。

| 门槛 | 测试 | 通过标准 | 失败优先排查 |
|---|---|---|---|
| G0 静态资产 | 加载示例和粗版专属角色 | 材质完整、朝向/站姿正确、无阻断错误 | VRM 版本、材质插件、路径 |
| G1 骨骼/蒙皮 | 程序化左右抬手、屈肘、转头 | 角色自身左右正确，网格随动，无明显关节畸形 | normalized/raw 混用、绑定、参考姿态 |
| G2 真实动作 | 真实单侧抬手驱动两个角色 | 同一 clip 直接复用，无反关节、左右交换或持续扭转 | 镜像、Euler 顺序、坐标空间、姿态偏移 |
| G3 动作合成 | 挥手 + 鼠标注视 + 呼吸 | 手臂动作持续，头眼跟随，切换无跳回 T-pose | mask、重复写入、更新顺序 |
| G4 表情/次级运动 | 说话 + 开心 + 眨眼 + 转头 | 嘴型持续且结束归零；头发稳定 | expression override、双重更新、delta |
| G5 稳定性 | 切角色、循环动作、连续对话 10 分钟 | 无崩溃和持续资源增长；目标机稳定 30 fps 以上 | 资源释放、模型负载、重复循环 |

G1 失败先修资产/渲染；G1 通过而 G2 失败再查动捕重定向。G2 通过前不制作六段精细动作。更换 VRM、rigProfile 或核心依赖后重跑相关门槛。格式可自动校验，关节变形、穿模、左右和动作自然度必须人工看动态画面。

## 十二、联网论证与实施边界

本方案于 2026-09-21 依据以下资料核对：

- [VRM 1.0 规范：VRMC_vrm](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/README.md)：humanoid 为必需组件；lookAt、expression、spring bone 的应用顺序会影响最终结果。
- [three-vrm 官方仓库](https://github.com/pixiv/three-vrm)：官方加载示例采用 `GLTFLoader`、`VRMLoaderPlugin`，并在渲染循环调用 `vrm.update(delta)`。
- [three-vrm VRMHumanoid API](https://pixiv.github.io/three-vrm/docs/classes/three-vrm.VRMHumanoid.html)：`autoUpdateHumanBones` 开启时，update 会把 normalized bones 的姿态同步到 raw bones，为统一动作入口提供依据。
- [MediaPipe Pose 官方文档](https://github.com/google-ai-edge/mediapipe/blob/master/docs/solutions/pose.md)：world landmarks 是以髋中心为原点、单位米的真实世界三维坐标；因此必须显式转换后才能进入场景/重定向逻辑。
- [Kalidokit 官方仓库](https://github.com/yeemachine/kalidokit)：`Pose.solve` 同时接收 33 个 world 关键点和普通 pose 关键点，并需要指定 runtime；其结果是运动学求解输出，不是 VRM 动画文件。

资料能证明接口与坐标语义，但不能证明某个具体 VRM、浏览器版本和动作样本已经兼容；最终兼容性由 G0–G5 实测确认。项目当前仓库还没有 `web/`、VRM 资产或动作样本，上述路径和验收页属于下一阶段实施任务。

最终演示验收：**专属 VRM 在实际窗口中播放至少三个已验证动作，同时正确注视用户并完成语音嘴型；示例 VRM 能复用同一组动作，切换时无需重录或逐角色修改动作。** 精确手指、脚底锁定、走路根运动、复杂手脸接触和任意第三方 VRM 兼容列为赛后能力。
