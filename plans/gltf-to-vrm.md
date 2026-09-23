# GLB → VRM 1.0 转换器（`tools/gltf-to-vrm.mjs`）

> 分支：`feat/tripo-asset-pipeline` ｜ 目标：让第三方 GLB 真正进入本项目的角色运行层
> **验收标准（由用户指定）**：模型**通过我们的渲染层渲染出来**，**并且能用动作库实际运动起来**。
> 达到后才删除临时预览页 `web/app/tripo-preview/` 与 `web/public/_tripo-*`。

---

## 一、Context：为什么必须要这一步

Tripo / Mixamo 这类管线产出的是**普通 glTF（GLB）**，而本项目的角色运行层只吃 **VRM**：

```
web/lib/character-runtime.ts   ← 只写 normalized 骨骼
web/lib/vrm-scene.ts           ← 只加载 VRM
web/components/motion-library/mocap-vrm-preview.tsx ← 只加载 VRM
```

`normalized 骨骼` 是 VRM 规范特有的：three-vrm 在加载时**按 `VRMC_vrm.humanoid` 的映射现搭**一套骨架出来。
没有 `VRMC_vrm` 扩展，`CharacterRuntime` 就没有可写的东西。

当前手上有的是（本轮 Tripo 管线产出）：

| 产物 | 内容 | 能不能直接用 |
|---|---|---|
| `02_textured/*.glb` | 贴图 + 几何，**无骨架** | ❌ 没 skin |
| `03_rigged/*.fbx` | 有骨架，但贴图是 `/mnt/pfs/...` 外链死链 | ❌ |
| **`03_rigged/*.glb`** | **23 骨 + 完整蒙皮 + 3 张贴图内嵌** | ✅ **本方案输入** |

---

## 二、★ 一条硬约束，决定整个转换的形态

我们的 clip 格式是：

```json
"space": "normalized-local",
"rotationMode": "absolute",
"rigProfile": "vrm-normalized-v1"
```

即 **"相对 rest pose 的绝对旋转"**。而 normalized 骨骼的 rest rotation **恒为单位四元数**、朝向与 rig 根一致。
于是 —— **"同一个四元数落在身体的哪个方向"，完全由 rest pose 决定。**

我们的轴线约定是在 **Seed-san（VRM 1.0，面朝 +Z，T-pose 手臂沿 ±X）** 上实测的：

```
raiseArm = 绕 Z（因为 T-pose 下手臂沿 X，绕 Z 才是"抬"）
BASE_STANDING_POSE.rightUpperArm = rotZ(72°)
```

实测当前 Tripo 模型：**面朝 +X，手臂沿 ±Z**。
若直接转 VRM，`rotZ` 落在**手臂长轴**上 → 抬臂变成**扭臂**，所有 clip 全废。

### ⚠️ 关键：不能靠"给根节点加旋转"糊弄

给根加旋转会让 normalized rig 的坐标系**跟着一起转**，clip 的轴与身体的相对关系**不变** —— 抬臂仍然是扭臂。

> 推导：normalized rig 的根是一个裸 `Object3D`，所有 normalized 骨骼 rest rotation = 单位四元数，
> 所以**所有骨骼共享 rig 根的坐标系**。rig 根随场景根一起转 ⇒ 骨骼局部轴一起转 ⇒ 相对关系不变。

**必须把朝向与尺度烘进模型数据本身。**

---

## 三、Approach：三者配合烘进数据

设 **M = 缩放(s) ∘ 绕 Y 旋转(θ)**

| # | 改什么 | 公式 |
|---|---|---|
| ① | 顶点位置 | `p' = M · p`（并重算 accessor 的 `min`/`max`） |
| ② | 顶点法线 | `n' = R · n`（只转不缩，再归一化） |
| ③ | **骨架根节点** 的 local | `local' = M · local` |
| ④ | `inverseBindMatrices` | `IBM' = IBM · M⁻¹` |

### 为什么这样是对的（推导）

skin 的顶点最终世界位置 `= Σ w · jointWorld · IBM · p`。代入四步之后：

```
Σ w · (M·J) · (IBM·M⁻¹) · (M·p)
  = Σ w · M · J · IBM · p
  = M · Σ w · J · IBM · p        ✅ 整体恰好被 M 变换
```

### 为什么"只转骨架根"是安全的

Tripo 的 GLB 结构里，**骨架根与 mesh 节点是兄弟**：

```
Scene
 └─ Armature
     ├─ tripo_node_…（mesh=0, skin=0）   ← 兄弟
     └─ Root                            ← 骨架根（joints 之一）
         └─ Hips → Spine → …
```

所以给 `Root` 预乘 M **只影响骨架**；而 mesh 的几何数据已经被 ① 改过，两者仍然一致。
**额外好处**：mesh 节点的 `matrixWorld` 不含 M，所以 `Box3.setFromObject`（相机取景用）读到的是烘过的几何包围盒 → **包围盒与视锥剔除也是对的**。

---

## 四、骨骼映射：Mixamo → VRM 1.0 规范名（22 根）

躯干链**一一对齐**，所以三条脊柱骨各自落到 `spine` / `chest` / `upperChest`：

```
Mixamo:  Hips → Spine → Spine1 → Spine2 → Neck → Head
VRM 1.0: hips → spine →  chest  → upperChest → neck → head
```

| Mixamo | VRM | | Mixamo | VRM |
|---|---|---|---|---|
| `Hips` | `hips` | | `LeftUpLeg` | `leftUpperLeg` |
| `Spine` | `spine` | | `LeftLeg` | `leftLowerLeg` |
| `Spine1` | `chest` | | `LeftFoot` | `leftFoot` |
| `Spine2` | `upperChest` | | `LeftToeBase` | `leftToes` |
| `Neck` | `neck` | | `RightUpLeg` | `rightUpperLeg` |
| `Head` | `head` | | `RightLeg` | `rightLowerLeg` |
| `LeftShoulder` | `leftShoulder` | | `RightFoot` | `rightFoot` |
| `LeftArm` | `leftUpperArm` | | `RightToeBase` | `rightToes` |
| `LeftForeArm` | `leftLowerArm` | | | |
| `LeftHand` | `leftHand` | | （右侧四根同构） | |

- **22 根** → 填满 VRM 55 槽位里的 **54 个**（唯一填不上的是 Mixamo 没有更细的胸椎分段）
- **VRM 的 15 根必需骨骼全部包含** → 转换时必须断言，缺一根就报错退出
- `Root` 骨不映射（VRM 没有根骨名），它作为 `hips` 的非人形祖先保留 —— three-vrm 的 normalized rig 会把它的变换吸收进 `hips` 的位置 ✅

---

## 五、Files to modify

### 新增

| 文件 | 作用 |
|---|---|
| **`tools/gltf-to-vrm.mjs`** | 本方案主体 |
| `tests/gltf-to-vrm.test.mjs` | 纯逻辑测试（映射表 / 矩阵烘法 / accessor 改写） |

### 参考（复用，不修改）

| 文件 | 复用点 |
|---|---|
| **`web/lib/human-bones-vrm1.json`** | 55 根规范骨骼表 —— **唯一真相源，禁止复制第二份**。沿用 `tools/*.mjs` 的 `readFileSync(resolve(HERE,'../web/…'))` 读法（避开 JSON import attributes） |
| `tools/inspect-fbx.mjs` | 依赖解析写法（`web/node_modules` 绝对 URL）、判定逻辑风格 |
| `tools/inspect-vrm.mjs` | 输出必须能被它验证通过 |
| `web/lib/bone-classify.ts` | `missing` vs `unknown` 的语义（本转换产出的都是规范名，不应出现 `unknown`） |

### 后续（本方案验收通过后再做）

| 文件 | 改动 |
|---|---|
| `web/public/avatars/` | 放入转换产物；**不进仓库**（真人形象，同 `*.vrm` 忽略规则） |
| `web/app/page.tsx` 或 `vrm-character.ts` | 资产下拉从"写死两个 VRM"改成扫描目录（几行） |
| 删除 | `web/app/tripo-preview/page.tsx`、`web/public/_tripo-*` |

---

## 六、Steps

- [x] **1. 骨架与映射**
  - 解析 GLB（`readGlb` / `writeGlb`，含 4 字节对齐与 chunk 头、声明长度校验）
  - 节点名归一化 `normalizeBoneName()`：吃掉 `mixamorig:` / `mixamorig_` / `mixamorig` 三种写法
  - 按 `MIXAMO_TO_VRM` 建 `humanBones: { vrmName: { node: index } }`
  - **断言 15 根必需骨骼齐全**，缺则报错退出（避免“加载时才报错”）
  - **实测：22/22 映射成功，无 `unknown`**

- [x] **2. 自动判定朝向与尺度**
  - ★ **实施中改了方案**：原计划用“脚趾方向”，实作时发现两个问题：
    (a) 只用单脚会受外八/内八影响；(b) “指向前的量”不如“最长的水平基线”稳。
    改为**遍历左右轴候选（肩线 / 髋线），取最长的那根**；脚趾方向只作对照打印。
  - **实测该模型**：肩线 0.2753 → −91.73°；髋线 0.1320 → −97.92°；
    双脚均值脚趾 → −91.99°。**肩线与脚趾一致，髋线是离群值** ⇒ 取肩线。
  - 尺度：`s = targetHeight / 当前网格高`（0.9809 → 1.75 → ×1.7841），支持 `--height`

- [x] **3. 烘数据（①~④）**
  - POSITION 逐顶点 `applyMatrix4(M)`，同时扩包围盒 → 回写 accessor 的 `min`/`max`
  - NORMAL 逐顶点只乘旋转矩阵再归一化
  - 骨架根节点：`local' = M · local`，`decompose` 回 TRS 写回（并删掉可能的 `matrix` 字段）
  - IBM：逐矩阵 `multiply(Minv)` 写回
  - 遇到交错 bufferView（`byteStride`）显式报错，不猜
  - **实测：52,122 顶点 / 52,122 法线 / 1 个骨架根（`Root`）/ 23 个 IBM**

- [x] **4. 注入 `VRMC_vrm`**
  - `extensionsUsed` 追加 `VRMC_vrm`；`extensions.VRMC_vrm = { specVersion:'1.0', meta, humanoid:{ humanBones } }`
  - `meta` 填满 VRM 1.0 全部必填字段；空值键直接删掉（规范不允许 null/undefined）

- [x] **5. 自检（转换即验证，不靠人看）**
  - 重新解析产物，不复述内存状态
  - **实测：左右轴 (−1.0000, 0, 0)，与 −X 偏差 0.00°；身高 1.7500 m；`unknown` 为空**
  - 再用既有的 `tools/inspect-vrm.mjs` 独立交叉验证 ✅

- [x] **6. 端到端（★ 用户指定的验收）** —— **全部通过**
  - 渲染层：`/` 页面加载成功，`实测身高 1.75 m` / `许可 unnecessary · InstaMate` / 骨骼 22 根，零 console 报错
  - 动作库：**播放 `raise-right-arm`，右手世界 y 由 0.9376 升到 1.3207（上升 0.3831 m）**
  - ★ **关键：z 全程 ≈ 0** ⇒ 手臂在 XY 平面内**竖直抬起**，不是扭转 ⇒ clip 契约成立
  - 且峰值位置 (−0.679, 1.321) 与 T-pose 参考位置 (−0.682, 1.329) 重合 ⇒ 抬到了正确的地方
  - 新增 `?avatar=<url>` 查询参数（惰性读 query，避免 undefined→url 触发两次加载）

- [x] **7. 清理（验收通过后才做）**
  - 已删 `web/app/tripo-preview/`、`web/public/_tripo-rigged.fbx`、`web/public/_tripo-textured.glb`
    （逐个看退出码 + 存在性复核）
  - 保留 `web/public/avatars/companion-tpose.vrm`（已是正式资产；`*.vrm` 已 gitignore）

---

## 七、Verification

```bash
# 单元（纯逻辑，不需要浏览器）
cd web && npm test                       # 预期 146+ 全绿

# 转换 + 既有检查器
node tools/gltf-to-vrm.mjs \
  "tripo/output/tpose_20260923_101924/03_rigged/tripo_rigging_d3c48661-….glb" \
  -o web/public/avatars/companion-tpose.vrm --name "影伴" --height 1.75
node tools/inspect-vrm.mjs web/public/avatars/companion-tpose.vrm

# 端到端（★ 真正的验收）
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/            # 页面可用
# CDP 驱动：加载该资产 → 断言渲染成功 + 骨架 23 根 + 播放 clip 后右臂世界 y 上升
```

**判定标准（逐条可证伪）**

| # | 断言 | 怎么证 |
|---|---|---|
| 1 | `inspect-vrm.mjs` 能解析，`missingBones` 只含 `upperChest` 之外的规范槽位 | CLI 输出 |
| 2 | 渲染层加载成功，`probeCapabilities` 不报"未知骨骼" | 页面能力面板 |
| 3 | 骨架 23 根与网格对齐 | 骨架叠加截图 |
| 4 | **面朝 +Z**：脚趾方向 z 分量 > 0 | 转换器自检输出 |
| 5 | **身高 ≈ 1.75** | 转换器自检输出 |
| 6 | **★ 播放 `raise-right-arm` 后右臂世界 y 上升**（不是扭转） | CDP 读 `getBoneWorld('rightHand').pos[1]` 变化 |
| 7 | 已有 8 个 clip 全部继续可用（`validate:all`） | CLI |

**第 6 条是整个方案成败的判据** —— 它同时验了朝向、尺度、clip 契约三件事。

---

## 八、风险与对策

| 风险 | 对策 |
|---|---|
| **面朝判定错**（脚趾骨缺失或方向异常） | 支持 `--rotate` 显式覆盖；自检会打印实际朝向 |
| **IBM 烘错导致蒙皮炸开** | 数学推导已在方案里；端到端第 6 条会暴露；先备份输入 |
| **烘完包围盒不对，相机取景/剔除出问题** | ① 已回写 accessor 的 `min`/`max`；验收里肉眼确认取景 |
| **three-vrm 对非人形祖先（`Root`）处理异常** | normalized rig 会把 `Root` 的变换吸收进 `hips` 位置；第 6 条会暴露 |
| **`meta` 字段不合规范导致加载失败** | 删掉所有 `undefined` 键；用 `inspect-vrm.mjs` 验证 |
| **输入是交错 bufferView** | 显式报错，不猜 |

---

## 九、不做的事（明确划界）

- ❌ **不做 FBX → VRM**：FBX 的贴图是外链死链，且解析成本高；GLB 已是更优输入
- ❌ **不做表情 / 弹簧骨**：Tripo 这套 rig 本来就没有（0 blendShape），本转换也不伪造
- ❌ **不做手指**：Mixamo 22 骨无手指；「缺骨骼」路径代码已经支持（写交集 + 报告）
- ❌ **不改 `RETARGET_IS_MEASURED`**：与本次转换无关

---

## 十、本轮已确认的实测事实（供实施时直接引用）

| 事实 | 值 |
|---|---|
| 输入 GLB | `tripo/output/tpose_20260923_101924/03_rigged/tripo_rigging_d3c48661-….glb`，15.45 MB |
| 节点结构 | `Scene → Armature(24) → { mesh 节点(23), Root(22) }`，骨架根与 mesh 节点是**兄弟** |
| 骨骼 | 23 joints（= `Root` + 22 Mixamo），名带 `mixamorig:` 冒号（**GLB 保留冒号，FBXLoader 会吃掉**） |
| 蒙皮 | `POSITION/NORMAL/TEXCOORD_0/JOINTS_0/WEIGHTS_0` ✅ |
| 拓扑 | 1 连通块 / 0 边界边 / **0 非流形边** |
| 贴图 | 3 张**全内嵌**（normal 0.89MB / base_color 2.04MB / metallic-roughness 9.38MB） |
| 包围盒 | `0.2146 × 0.9809 × 0.9771`（Y 为身高） |
| **朝向** | **面朝 +X**（`toeDir` 主导轴 +X，两脚一致） |
| **尺度** | 身高 **0.9809** 单位 —— **不是米**，VRM 要求米 |
| rest pose | 上臂下斜 **5.52°(左) / 8.55°(右)** —— 近似 T-pose 而非严格（另一个独立问题，不在本方案范围） |
| 既有扩展 | **无** —— `VRMC_vrm` 是唯一要注入的扩展 |
| bufferView 布局 | 各属性**独立、非交错**，可原地改写 |
| `human-bones-vrm1.json` | 55 条，唯一真相源 |

---

## 十一、实施结果（2026-09-23 完成）

### 端到端验收（★ 用户指定的判据）

```
输入  tripo/…/03_rigged/tripo_rigging_d3c48661-….glb   15.45 MB
输出  web/public/avatars/companion-tpose.vrm           16.20 MB

检测    肩线 0.2753 → 绕 Y −91.73°（采用）；髋线 −97.92°（离群）；双脚脚趾 −91.99°
        缩放 ×1.7841 → 身高 1.7500 m
自检    左右轴 (−1.0000, 0, 0)   与 −X 偏差 0.00°
        骨骼 22 根 / unknown 0 / 15 根必需齐全
        身高 1.7500 m ✅

渲染层  /?avatar=/avatars/companion-tpose.vrm 加载成功
        实测身高 1.75 m ｜ 许可 unnecessary · InstaMate ｜ 骨骼 22/55
        零 console 报错、零 hydration 告警

动作库  ★ 播放 raise-right-arm：
          右手世界 y   0.9376 → 1.3207   上升 0.3831 m
          峰值坐标     (−0.679, 1.321, −0.000)
          T-pose 参考  (−0.682, 1.329, −0.000)   ← 几乎重合
          z 全程 ≈ 0   ⇒ 在 XY 平面内【竖直抬起】，不是扭转  ✅
```

### 测试

```
新增 tests/gltf-to-vrm.test.mjs     14 项
全套                               160 / 160 通过（原 146 + 14）
typecheck / build / validate:all   零错误 / 零错误 / 8/8
```

### 一个必须说明的已知缺陷

**手臂从 T-pose 转下来时，T 恤袖子在肩/腋下会出现明显的折叠褶皱。**

这不是转换引入的 —— 数学上转换只施加**整体刚性变换**，对任意姿态都有

```
Σ w · (M·J) · (IBM·M⁻¹) · (M·p) = M · Σ w · J · IBM · p
```

即输出恒等于「原模型输出被 M 变换」，**不可能引入相对形变**。
根因是 Tripo 自动绑骨的肩部权重 + T 恤袖子几何：
袖管刚性跟随上臂，转 72° 后被拖进腋下造成自相交。

对比：Seed-san（专业制作）在同样姿态下肩部干净。这属于**模型质量**问题，
是接入第三方资产的固有代价，不是本工具能修的。
