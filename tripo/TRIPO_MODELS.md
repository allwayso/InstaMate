# Tripo 模型与参数清单

> 按 Tripo 官方文档整理，更新于 2026-09-23。本项目使用 V2 `POST /task` 接口。

## 当前默认的高质量组合

```dotenv
TRIPO_MODEL_VERSION=v3.1-20260211
TRIPO_GEOMETRY_QUALITY=detailed
TRIPO_FACE_LIMIT=100000
TRIPO_TEXTURE_MODEL_VERSION=v3.0-20250812
TRIPO_TEXTURE_QUALITY=detailed
TRIPO_TEXTURE_SIZE=4096
TRIPO_ENABLE_IMAGE_AUTOFIX=true
```

这组配置使用 H3.1 Ultra 生成几何，然后单独调用 V2 接口支持的高级 `v3.0-20250812` 贴图模型生成 detailed PBR，最后导出 4K FBX。质量高于旧的 `v2.5 + standard + 50000 面 + 2K`，但耗时和积分也会增加。

## `TRIPO_MODEL_VERSION`：3D 几何模型

| 值 | 定位 | 主要能力 | 适合场景 |
| --- | --- | --- | --- |
| `v3.1-20260211` | H3.1 旗舰，当前默认 | 最高几何质量；Standard 最高约 150 万三角面，Ultra 最高约 200 万；支持 `geometry_quality`、quad、smart low-poly | 高保真人物、英雄资产、复杂物体 |
| `v3.0-20250812` | H3 稳定高级版 | 边缘和硬表面效果好；Standard 最高约 100 万面，Ultra 最高约 150 万 | 希望使用 H3 功能但不需要最新几何模型 |
| `v2.5-20250123` | H2.5 均衡版 | 稳定、兼容性高，比 H3 便宜，不支持 H3 Ultra 几何质量 | 通用资产、批量生成、成本优先 |
| `v2.0-20240919` | H2 旧稳定版 | 支持常规贴图、PBR 和后处理 | 旧项目兼容，新项目不建议优先选 |
| `P1-20260311` | 干净低模 | 48–20000 面；低面数下拓扑干净；约 10 秒生成无贴图基础网格 | 手游、实时应用、风格化资产、对面数严格的流程 |
| `Turbo-v1.0-20250506` | 速度优先 | 延迟最低、快速返回，保真度和高级控制弱于 H3 | 预览、原型、大批量快速试错 |

注意：`P1-20260311` 不支持 `quad`、`smart_low_poly`、`generate_parts` 和 `geometry_quality`。脚本会自动避免向 P1 发送 H3 专用的 `geometry_quality`。新 V3 文档还列出了 Preview 版 `P2-20260801`，但它不在本脚本的 V2 允许清单中。

## `TRIPO_GEOMETRY_QUALITY`：H3 几何质量

| 值 | 能力 |
| --- | --- |
| `standard` | 速度和几何细节的平衡模式 |
| `detailed` | Ultra 模式，复杂结构和表面细节更好，额外消耗积分 |

仅对 `v3.0-20250812` 和 `v3.1-20260211` 有意义。

## `TRIPO_TEXTURE_MODEL_VERSION`：V2 贴图模型

| 值 | 能力 | 推荐搭配 |
| --- | --- | --- |
| `v3.0-20250812` | V2 当前高级贴图流程；高清晰度、现实感、文字/复杂图案与 PBR | `v3.0`、`v3.1` 或 P1 几何；本脚本默认 |
| `v2.5-20250123` | 稳定的 H2.5 贴图基线 | `v2.5-20250123` 几何 |

`v3.5-20260815` 是新 V3 API 的贴图模型，支持 `fast`、`extreme` 和 `delight`。当前脚本保留已验证的 V2 调用方式，不会把 V3 专用参数混入 V2 请求。

## `TRIPO_TEXTURE_QUALITY`：贴图质量

| 值 | 能力/限制 |
| --- | --- |
| `standard` | 速度、费用和细节的平衡模式 |
| `detailed` | 高保真高清贴图，当前默认 |

V2 仅使用 `standard` / `detailed`。`fast` / `extreme` 是 V3 新贴图流程的档位，不能直接填入本脚本。

## 其他常用配置

| 环境变量 | 可用值 | 说明 |
| --- | --- | --- |
| `TRIPO_FACE_LIMIT` | 正整数 | 网格最大面数。H3.1 Ultra 最高约 200 万；P1 为 48–20000 |
| `TRIPO_ENABLE_IMAGE_AUTOFIX` | `true` / `false` | 生成前修复低清、缺失或不利于 3D 重建的图像；会增加耗时 |
| `TRIPO_TEXTURE_SIZE` | `1024` / `2048` / `4096` | 转换为 FBX 时的烘焙贴图分辨率；注意它不是生成贴图模型本身的质量档位 |
| `RIG_MODEL_VERSION` | `v1.0-20240301` / `v2.5-20260210` | v1 用于双足人形；v2.5 主要用于四足、多足、鸟类、蛇形和水生生物 |
| `TRIPO_RIG_SPEC` | `mixamo` / `tripo` | Mixamo 骨骼命名方便 Unity/UE/Mixamo；Tripo 使用原生骨骼命名。本项目不再生成动作，默认保留 `mixamo` |
| `TRIPO_FBX_PRESET` | `blender` / `3dsmax` / `mixamo` | 静态 FBX 导出兼容预设 |

## 几组实用预设

### 高质量人物（当前默认）

```dotenv
TRIPO_MODEL_VERSION=v3.1-20260211
TRIPO_GEOMETRY_QUALITY=detailed
TRIPO_FACE_LIMIT=100000
TRIPO_TEXTURE_MODEL_VERSION=v3.0-20250812
TRIPO_TEXTURE_QUALITY=detailed
TRIPO_TEXTURE_SIZE=4096
```

### 均衡质量/费用

```dotenv
TRIPO_MODEL_VERSION=v2.5-20250123
TRIPO_FACE_LIMIT=50000
TRIPO_TEXTURE_MODEL_VERSION=v2.5-20250123
TRIPO_TEXTURE_QUALITY=standard
TRIPO_TEXTURE_SIZE=2048
```

### 干净低模

```dotenv
TRIPO_MODEL_VERSION=P1-20260311
TRIPO_FACE_LIMIT=10000
TRIPO_TEXTURE_MODEL_VERSION=v3.0-20250812
TRIPO_TEXTURE_QUALITY=detailed
TRIPO_TEXTURE_SIZE=4096
```

## 官方文档

- V2 H3 图生 3D：<https://docs.tripo3d.ai/zh/model-generation/image-to-model-v3-0-v3-1.html>
- V2 P1 图生 3D：<https://docs.tripo3d.ai/zh/model-generation/image-to-model-p1-20260311.html>
- V2 v3.0 贴图模型：<https://docs.tripo3d.ai/zh/texture/texture-model-v3-0-20250812.html>
- 自动绑骨：<https://developers.tripo3d.com/zh/docs/animations-rig>
- FBX/格式转换：<https://developers.tripo3d.com/zh/docs/models-convert>
