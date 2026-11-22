# aiti-feedback 扩展（部署目录直改指南）

## 形态
- 纯客户端扩展：toolbar「报告问题」按钮 → 弹窗（表单 + 脱敏预览）→ GitHub 预填 issue
- 无服务端 API、无数据目录、零 token——用户自己登录 GitHub 提交
- 方案：workspace-tools `docs/aiti-feedback-plan.md`

## 小改现场流程
1. 改 `src/`（client/src）
2. `node tools/build-client.mjs`（client 有构建产物）
3. `curl -X POST http://127.0.0.1:3001/api/extensions/reload`（dev 3001 / prod 3002；外部经 nginx 带 basePath）
4. 刷新页面验证

## 红线
- 禁手改 dist/（构建产物）
- 脱敏规则表在 `client/src/feedback-build.ts`（REDACT_RULES），改前跑 `client/tests/feedback-build.test.mjs`
- **图标必须是 24×24 lucide 线条风**（stroke=currentColor）：宿主 `embedUiSvgIcons` 只取 svg 内部 path、用自己的 svg 根（16px、fill=none）重渲染——fill 实心型（如 GitHub octicon）的根属性被丢弃，16px 下必然糊
