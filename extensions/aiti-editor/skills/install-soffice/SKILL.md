---
name: install-soffice
title: AI 帮我在服务器安装 LibreOffice
placeholder: 描述情况，如「.doc 打不开 / 转不了 PDF」…
summary: pi-web 所在服务器缺少 LibreOffice (soffice) 导致 .doc/.xls/.ppt 老格式无法在线转换 / PDF 预览时，AI 自动检测平台并安装（Linux 多发行版 / Windows winget / macOS brew），装完自动验证
outputs:
  format: text
---

# install-soffice · 服务器安装 LibreOffice

用户在 pi-web 里打开 .doc/.xls/.ppt 等老格式时提示「转换该文件需要 LibreOffice (soffice)」——pi-web 所在服务器没装 LibreOffice。你（AI）的会话 shell 与 pi-web 服务在同一台机器上，直接在本机执行安装即可。

## 步骤

1. **先探测现状**（避免重复安装）：

   ```
   curl -s "{basePath}/api/extensions/aiti-editor/soffice-status?refresh=1"
   ```

   `available: true` → 已可用，报告 `path`/`version` 并告知用户刷新页面重试转换，结束（不要重装）。

2. **判定平台**（pi-web 服务所在系统）：`uname -s`：
   - `Linux` → 走第 3 步
   - `MINGW*` / `MSYS*` / `CYGWIN*`（Windows，git-bash）→ 走第 4 步
   - `Darwin` → `brew install --cask libreoffice`，装完跳第 5 步

3. **Linux**：优先用随扩展部署的一键脚本（已处理 root/sudo 提权、发行版自适应、中文字体）：

   ```bash
   ls ~/.pi/web/extensions/aiti-editor/tools/install-soffice.sh ~/.pi/web-dev/extensions/aiti-editor/tools/install-soffice.sh 2>/dev/null
   ```

   存在则 `bash <该脚本>`。结尾行 `SOFFICE_INSTALL_RESULT ok …` = 成功；`already` = 本来就有；`exit 32` = sudo 需要密码 → **不要反复重试**，把对应发行版命令交给用户手动跑（apt 系：`sudo apt install -y libreoffice fonts-noto-cjk`）。脚本不存在（旧部署）→ 直接按发行版裸装：apt-get / dnf / pacman / apk / zypper（包名参考脚本内实现），务必带中文字体（fonts-noto-cjk，防 PDF 中文乱码）。

4. **Windows**（git-bash 里调 winget）：

   ```bash
   winget install --id TheDocumentFoundation.LibreOffice -e --silent --accept-source-agreements --accept-package-agreements
   ```

   约 350MB，耐心等命令返回（不要中途判死）。装完落点 `C:\Program Files\LibreOffice\program\soffice.exe`。

5. **验证**（必须带 `refresh=1`，定位结果有 60s 缓存）：

   ```
   curl -s "{basePath}/api/extensions/aiti-editor/soffice-status?refresh=1"
   ```

   `available: true` → 报告版本与路径，告知用户**刷新页面**后重新打开文件 / 点「重试转换」即可。
   仍 `false`（旧版定位代码无 Windows 常见路径支持）→ 指导用户：扩展管理器 → aiti-editor → 功能 → 「soffice 路径（LibreOffice）」填入上面实际路径，保存后刷新页面；或先升级部署本扩展。

## 注意

- 本 skill 是**纯执行任务**：安装/验证全程用 shell 完成，无需表单回填；结果以 text 报告。
- 报告格式：平台 → 执行了什么 → 安装结果（版本/路径）→ 验证状态 → 用户下一步动作（刷新页面重试）。
- 失败（网络/磁盘/权限）时如实报告错误摘要与手动安装命令，不要声称成功。
- 转换能力归属：aiti-editor（.doc/.ppt→PDF/.docx/.pptx）、aiti-sheet-univer（.xls/.ods→xlsx）共用本机 soffice，装一次两边都好。
