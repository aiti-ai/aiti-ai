# aiti-feedback — 用户反馈扩展

从 pi-web 界面直接报告问题：弹窗里填写表单、实时预览（已脱敏）的最终内容，
一键打开**预填好的 GitHub issue**——用户自己登录 GitHub 点提交即可。
零 token、零服务端。

## 隐私模型
- 弹窗预览 = 最终提交内容（best-effort 脱敏：内部域名/内网 IP/内部仓名/路径/常见 token 形态 → 占位符）
- 环境信息（UA/平台/语言/页面路径，query 剥离）默认勾选、可关闭
- 会话内容**永不自动读取**；提供自愿粘贴框（同样脱敏）
- GitHub 预填超长时自动截断，全文始终写入剪贴板兜底

方案：内部 `aiti-feedback-plan.md`（pi-work docs）。
