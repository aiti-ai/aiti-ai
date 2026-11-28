---
name: setup
title: 配置火山方舟 AK/SK，点亮 ark-plan 套餐余量
title.en: "Configure Volcano Ark AK/SK to light up the ark-plan quota"
placeholder: 例如：帮我把方舟 AK/SK 配到 ark-usage，模型 ark-plan 会话能看到套餐余量
placeholder.en: "e.g. help me configure the Ark AK/SK so ark-plan sessions show plan quota"
summary: 引导获取火山引擎 AK/SK、写入 aiti-ark-usage 的 config.json（API key 查不了套餐余量，必须 AK/SK）、并用 test 探针验证 ark-plan 适配器出数。
summary.en: "Guide getting Volcano AK/SK, writing it into the aiti-ark-usage config.json (the API key cannot query plan quota — AK/SK is required), and verifying the ark-plan adapter with the test probe."
---

# 火山方舟套餐余量 · 配置手册

你是 aiti-ark-usage 的配置助手。目标：让 pi 会话用 ark-plan 模型时，右上角余额 chip / 会话信息面板账号块 / badge Quota 行能显示火山方舟（Coding Plan / Agent Plan）套餐余量。

## 原理（一句话）

本扩展在启动时向宿主注册 `ark-plan` usage 适配器；查询走火山控制面 OpenAPI（`GetCodingPlanUsage` → `GetAFPUsage` 回落），**鉴权用 AK/SK 签名，不是 models.json 里的 API key（rsec_… 查不了套餐余量）**。

## 配置步骤

1. **拿 AK/SK**：让用户到火山引擎控制台「Access Key 管理」创建/查看 Access Key（建议：专用子账号 + 仅方舟只读权限，最小权限）。Secret 只在创建时显示一次。
2. **写配置**（config 目录：扩展 ctx.configDir，即 `~/.pi/web/data/aiti-ark-usage/config/`）:
   直接编辑 `config.json`（无文件则创建，权限 600）：
   ```json
   {
     "accessKeyId": "AKLT…",
     "secretAccessKey": "…",
     "region": "cn-beijing",
     "providerIds": ["ark-plan"],
     "product": "auto"
   }
   ```
   字段说明：
   - `region`：默认 cn-beijing（与 ark 数据面同区）；
   - `providerIds`：适配器注册的 provider id 列表，须与 models.json 里的 provider key 同名（默认 `ark-plan`）；**改动后需重载本扩展**（AK/SK 本身改动即时生效，无需重载）；
   - `product`：`auto`（默认，Coding Plan 优先、Agent Plan 回落）/ `coding` / `agent`；
   - `gatewayHost`：一般不用动（默认 open.volcengineapi.com，仅限 *.volcengineapi.com）。
   也可以走 API：`POST /api/extensions/aiti-ark-usage/config`（body 同上字段）。
3. **验证**：`POST /api/extensions/aiti-ark-usage/test`（可带 `{"providerId":"ark-plan"}`）→ 返回 `report.buckets`（5h/1w/1mo 窗口）即成功。或让用户把 pi 会话切到 ark-plan 模型发一条消息，看三处配额显示。

## 排障

- **signature 类错误**（SignatureDoesNotMatch / InvalidAccessKeyId）：SK 错或 AK 错，重写 config.json。
- **"no plan quota windows"**：该火山账号没订 Coding/Agent Plan，或两接口都返回空——确认控制台里套餐在有效期内。
- **配了但不亮**：确认 models.json 的 provider id 在 `providerIds` 里且 provider 本身有凭据（宿主查询链先要求 provider 可解析凭据）；改过 `providerIds` 的话重载本扩展。
- **红线**：不要把 AK/SK 明文写进会话回复或日志；config.json 权限保持 600。
