---
name: asr-gpu
title: ASR 服务 GPU 加速适配（识别 GPU / 查版本 / 升级 / 回退）
placeholder: 想给 ASR 服务启用 GPU 加速，帮我识别显卡、查支持、适配并测试，不行就回退 CPU…
outputs:
  format: text
---

# asr-gpu · ASR 服务 GPU 加速适配手册

把 aiti-ai-input 的 ASR（8767/8766）从 CPU 迁到 **GPU**（Linux/Windows AMD ROCm · NVIDIA CUDA · macOS MPS），确认不支持则回退 CPU。
**本手册只含公开通用信息**：识别硬件用公开命令、版本匹配查官方信息源、升级/回退流程。
**不要硬编码任何具体机型/override 值**——每台机器的 GPU 和驱动不同，用命令现场探测 + 官方文档判读。

## 1. 识别 GPU（公开命令，任何机器通用）

```bash
# 1) 硬件型号（PCI 厂商设备名：AMD / NVIDIA / Intel）
lspci | grep -iE 'vga|display|3d'
#   Windows: wmic path win32_VideoController get name  或  Get-CimInstance Win32_VideoController
#   macOS:   system_profiler SPDisplaysDataType | grep -iE 'chipset|metal'

# 2) 按厂商选探测工具：
#   NVIDIA（装驱动后）
nvidia-smi                                  # 型号/驱动/CUDA 版本/显存占用
#   AMD Linux（装 ROCm 后）
rocminfo | grep -E 'Marketing Name|Compute Unit|gfx'   # gfxXXXX = LLVM target 名，最关键
/opt/rocm/bin/rocm-smi | head -20                      # 温度/占用/VRAM
#   AMD Windows：AMD Software (Adrenalin) 设置页查看 GPU 型号/驱动
#   macOS：system_profiler 看 Metal 支持（Apple Silicon 全支持）

# 3) 设备节点（Linux 两者通用）
ls /dev/kfd 2>/dev/null && echo 'kfd(AMD ROCm) 存在'   # 无 kfd = 内核没加载
ls -la /dev/dri/                                        # renderD128 等
```

**判读 → 决定路径**：
- **NVIDIA** → §2-N CUDA 路径（官方支持最全，通常直接装）
- **AMD** → 判 gfx 名（Linux rocminfo / Windows 看官方支持矩阵）：
  - `gfx90a/gfx942`（CDNA 数据中心）· `gfx1100/gfx1101/gfx1201`（RDNA3/RDNA4 独显）→ **官方全支持，直接装**（Linux §2-A / Windows §2-W）
  - `gfx1103`（RDNA3 APU 集显，780M 级）/`gfx1150`（RDNA3.5）→ Linux 需特殊索引（§2-A），Windows 走 §2-W 官方 wheel
  - 不认识的 gfx / 无信息 → 不支持 → 回退 CPU（§4）
- **Intel**（Arc/核显）→ 官方 ROCm/CUDA 均不支持；Intel 走 oneAPI/IPEX 另路线，**本服务默认回退 CPU**（§4）
- **macOS**（Apple Silicon / Intel）→ §2-M：ROCm/CUDA 不支持，只认 MPS 后端；funasr 对 mps 兼容差 → 大概率回退 CPU

## 2-N. NVIDIA CUDA 路径（官方支持最全）

| 主题 | 官方地址 |
|---|---|
| 驱动下载 | https://www.nvidia.com/Download/index.aspx |
| CUDA 工具包 / 安装 | https://docs.nvidia.com/cuda/cuda-installation-guide-linux/ |
| PyTorch 安装选择器 | https://pytorch.org/get-started/locally/ |

```bash
# 2-N.1 NVIDIA 驱动（nvidia-driver 或 runfile；装完 nvidia-smi 能出库列表即驱动 OK）
# 2-N.2 PyTorch CUDA 版（版本按 pytorch.org 选择器给的 --index-url）
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu<版本>
# 2-N.3 真测（§3 GPU 真测同款假阳性检测）
```

## 2-W. Windows · AMD ROCm 路径（官方支持，注意版本限制）

| 主题 | 官方地址 |
|---|---|
| Radeon & Ryzen 上使用 ROCm（Windows/Linux 总入口） | https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/index.html |
| Windows PyTorch 安装（PIP） | **https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/install/installrad/windows/install-pytorch.html** |
| Windows llama.cpp 预编译（AMD 官方验证） | **https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/advanced/advancedrad/windows/llm/llamacpp.html** |
| TheRock（PyTorch 官方 ROCm 构建项目，Windows 可用） | https://github.com/ROCm/TheRock |

**要点（官方明示，查文档核最新版）**：
- Windows PyTorch ROCm 面向 **Radeon 9000/7000 系 + Ryzen APU（gfx110X/gfx115X/gfx120X）**；ROCm 7.2.1 对应 **Python 3.12 + 指定 Adrenalin 驱动版本**（不匹配会静默失败）
- **装 PyTorch 前先装 rocm SDK 包**（官方 `repo.radeon.com` 的 `rocm_sdk_core/devel/libraries_custom` wheel + tar.gz），否则 torch 装完 `is_available()` 为 False
- **CPU 版 torch 被 pip 依赖解析器覆盖的坑存在**（官方 issue #5733）→ 用 `--no-cache-dir` 显式 URL 直装，安装后立即 `torch.cuda.is_available()` 验证
- **WSL2 备选**：Windows 上 AMD GPU 也可用 WSL2 + ROCDXG（官方 Adrenalin 26.2.2 + ROCm 7.2.1 起支持 Strix/Strix Halo）——性能更接近 Linux、生态更全
- llama.cpp 走 AMD 官方预编译二进制（gfx110X/gfx115X/gfx120X 带 `-ngl 99` 全卸到 GPU）

## 2-M. macOS · GPU 加速路径（无 ROCm，用 Metal/MPS 或 CPU）

| 主题 | 官方地址 |
|---|---|
| PyTorch MPS 后端（Apple 官方） | https://developer.apple.com/metal/pytorch/ |
| MPS 后端说明（PyTorch 官方） | https://docs.pytorch.org/docs/stable/notes/mps.html |

**要点**：
- **ROCm/CUDA 不支持 macOS**——只有 Apple GPU（Apple Silicon）有 PyTorch **MPS 后端**（Metal Performance Shaders），设备为 **`mps`**（`torch.device("mps")`，前提 `torch.backends.mps.is_available()` 为 True）
- 安装：标准 `pip install torch`（macOS 默认带 MPS）；无需特殊索引
- 服务侧：`AITI_ASR_DEVICE=mps`（**funasr 对 mps 支持不佳，通常仍用 CPU**——先实测再定）
- 验证：mps 真测 + 注意 **Fallback 警告**（出现即部分算子降 CPU 运算，加速可能名存实亡）

## 2-A. AMD ROCm 路径（Linux）

| 主题 | 官方地址 |
|---|---|
| GPU 兼容规格表（gfx 名/架构/支持列表） | https://rocm.docs.amd.com/en/latest/reference/gpu-specs.html |
| ROCm 兼容矩阵（版本×GPU） | https://rocm.docs.amd.com/en/latest/compatibility/compatibility-matrix.html |
| ROCm 安装（amdgpu-install / runfile） | https://rocm.docs.amd.com/en/latest/how-to/installation/ |
| PyTorch ROCm 安装页 | https://docs.amd.com/zh-CN/rocm/latest/how-to/ai-frameworks/pytorch |
| AMD 官方 nightly 索引（含 APU kernel） | https://docs.amd.com/en-US/rocm/latest/ai-frameworks/pytorch/#extra-install-notes |
| TheRock（PyTorch 官方 ROCm 构建项目） | https://github.com/ROCm/TheRock |

```bash
# 2-A.1 装官方完整 ROCm（或确认已有）
sudo apt install amdgpu-install && amdgpu-install --usecase=rocm   # Ubuntu
# 或按规格页对应发行版用 runfile
# 2-A.2 确认驱动层 OK（不用 torch）
rocminfo | grep -E 'gfx|Compute Unit'      # 能看到目标 gfx = 驱动正常
# 2-A.3 装 PyTorch（按 gfx 决策）：
#   a) 官方支持 gfx（独显/数据中心）→ 稳定版
pip install torch torchaudio --index-url https://download.pytorch.org/whl/rocm6.x
#   b) APU/部分 RDNA3 → AMD 官方 nightly gfx 索引（--pre；版本号含 a0+rocm 前缀）
pip install --pre torch torchvision torchaudio --index-url <上表官方 nightly 索引>
#   c) TheRock 方案（ROCm 7.x）：照 TheRock README 的 pip 命令（版本对应严格按仓库表）
```

**HSA_OVERRIDE_GFX_VERSION 取值法（仅 AMD，不要写死）**：
- 目标 gfx 名 → 对应 `11.0.M`（gfx1101→11.0.1，gfx1102→11.0.2，gfx1103→11.0.2 或 11.0.3，**实际可用值现场逐个试**——不同 ROCm 版本能用的值不同）
- 查法：`ls /opt/rocm/lib/rocblas/library/`（或 `find / -name 'librocblas*'`）看到哪些 `11.0.x` 有编译库，**选库文件里存在的值**
- 设错的表现：`invalid device function` / `GPU Hang` / segfault / 桌面闪黑 → 换值或回退

## 3. GPU 真测（假阳性检测—— is_available() 为 True 不代表 kernel 能跑）

```bash
python -c "
import torch
print('torch', torch.__version__, '| cuda', torch.cuda.is_available())
a = torch.randn(1024,1024,device='cuda'); b = torch.randn(1024,1024,device='cuda')
c = a @ b; torch.cuda.synchronize()
print('GPU matmul OK:', float(c[0,0]))   # 这里报错/崩 = kernel 不匹配 → 换版本/驱动/索引
"
# AMD Linux 需先 export HSA_OVERRIDE_GFX_VERSION=<§2-A 查到的值>（NVIDIA/Windows AMD 不需要）
# macOS 将 device 改为 'mps' 并先确认 torch.backends.mps.is_available()
```

## 4. ASR 服务升级为 GPU 版（代码已支持）

服务读取 `~/.pi/web/data/aiti-ai-input/asr-config.json` 的 `env` 对象，启动时全部灌入进程环境
（优先级 config.env > 进程 env > 代码默认 `"cpu"`）。**生产旁路：改配置 + 重启，不改代码。**

```bash
# 4.1 通过管理弹窗「⚙️ 环境变量」（或直接改 json）
#   env 可含（键名标准，无需别名）：
#     AITI_ASR_DEVICE          = cuda:0            # NVIDIA/AMD 通用；macOS 可用 mps（需实测）
#     AITI_ASR_COMPUTE_DTYPE   = float16
#     HSA_OVERRIDE_GFX_VERSION = <§2-A 查到的值>   # 仅 AMD Linux 需要；NVIDIA / Windows AMD / mps 不设
# 4.2 若 asr-venv 的 torch 是 CPU 版 → 重建（`pip uninstall -y torch torchaudio` 后按 §2-N/§2-W/§2-A 重装）
# ⚠ 坑（实测踩过）：**requirements.txt 不要写 torch/torchaudio 行**——
#   服务启动脚本若 `pip install -r requirements.txt`，`torchaudio>=X.Y` 会从 PyPI 拉 **CUDA 版**覆盖 ROCm 版
#   （a0 预发布版本号不满足 >= 判断）→ 报 `libcudart.so.13: cannot open shared object file` 缺库崩溃。
#   正确做法：torch/torchaudio 由 venv 手动锁定（TheRock wheel 或官方索引），requirements 只管业务依赖；
#   或者干脆让启动脚本**不自动 pip install**（venv 由部署锁定）。
# 4.3 重启服务（弹窗 ⟳ 或 /asr/control {action:"restart"}）
# 4.4 验证（顺序）：
curl -s http://127.0.0.1:8767/health          # stream_loaded/offline_loaded/quick_loaded 全 true
# 真音频转写（server/test_asr_stream.py 或 POST /voice/transcribe）+ 利用率采样：
#   NVIDIA: nvidia-smi --query-gpu=utilization.gpu --format=csv 连续看
#   AMD:    rocm-smi --showuse 连续看 GPU% 抬升 = 真在 GPU；一直 0% = 偷偷回退 CPU
#   macOS:  torch.backends.mps.is_available() + 无 Fallback 警告
```

## 5. 适配不了 / 测试不过 → 回退 CPU（推荐路径）

```bash
# 5.1 配置清除 GPU 项（env 清空或删 AITI_ASR_DEVICE/HSA_OVERRIDE）
#     管理弹窗 ⚙️ 删行保存，或直接改 json： "env": {}
# 5.2 如 asr-venv 已换过 GPU torch → 装回 CPU 版
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
# 5.3 重启服务 → /health 确认三模型加载 → 真转写 ms 正常且无 GPU 占用
# 5.4 保底：asr-venv 损坏时删掉重建（start-stream.sh 自动 pip install requirements.txt）
```

**回退判据（任一满足即回退）**：
- GPU 利用率持续 0%（没真用上）
- 真推理报 `Memory access fault` / `GPU Hang` / `invalid device function` / segfault
- macOS MPS 大量 Fallback 警告（加速名存实亡）
- 桌面/显示卡顿闪黑（iGPU 同时驱动显示器时 GPU hang 会拖垮桌面）→ **立即回退 CPU**

## 6. 关键提醒

- **iGPU 风险**：集显同时驱动桌面显示，GPU hang 会带崩桌面；用 GPU 推理前先跑 §3 单测，稳定再上服务
- **内核回归**：amdgpu 驱动的 GPU hang 有时是**内核版本回归**（换内核可解）；遇不明 hang 先查内核版本与 amdgpu-dkms 是否匹配
- **CTranslate2 例外**：`voice-asr.py`（8765 faster-whisper）基于 CTranslate2 —— **只有 NVIDIA CUDA 后端，AMD/macOS 不支持**；AMD 机上该服务保持 CPU（不要设 `AITI_ASR_DEVICE=cuda`）
- **Windows 版约束**：PyTorch ROCm wheel 要求 Python 3.12 + 匹配 Adrenalin 驱动，且需先装 rocm SDK——版本链严格，先看官方页再动手
- **不要轮询**：验证加载状态用 `/health` 轮询最多 30 次×2s，或事件等待；不要 setInterval 死循环
- **本机不上传到任何地方**：诊断信息只留本地日志
