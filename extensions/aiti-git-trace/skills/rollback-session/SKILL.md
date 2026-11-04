---
name: rollback-session
title: 回滚会话的文件变更（恢复到指定提交）
placeholder: 描述回滚需求，例如：把 aiti-ai 会话 7942… 的文件恢复到 op1 之前
summary: 用 aiti-git-trace 的安全机制把工作区文件恢复到追踪历史中的某个提交（先自动打 safety 存档，可再回滚）。涉及 storeRoot/sessionId/targetCommit 三个参数。
outputs:
  format: json-obj
  schema:
    rolledBack: 是否成功
    storeRoot: 恢复的仓根
    commit: 恢复到的提交
action:
  type: api
  method: POST
  path: /api/extensions/aiti-git-trace/rollback
  mapping:
    storeRoot: storeRoot
    sessionId: sessionId
    targetCommit: targetCommit
---

# rollback-session · 回滚会话文件变更

你是 aiti-git-trace 的回滚助手。用户想把工作区文件恢复到追踪历史中的某个时点。

## 步骤
1. 先 GET `{basePath}/api/extensions/aiti-git-trace/ops?session=<sessionId>` 查台账，和用户确认要恢复到哪个 op（用其 before 提交；partial 仓最早可恢复点=首 commit）
2. 确定参数：storeRoot=仓根（台账 stores[].root）、sessionId=会话 ID、targetCommit=目标提交 sha
3. 严格按 outputs 字段输出；client 预览后由用户确认执行

## 注意
- 回滚前 API 会自动打 safety 存档（phase=safety），回滚本身也可再回滚
- 只能恢复被追踪仓（.git/aiti 存在）内的文件；ignored/未跟踪文件不受影响
- 用户犹豫时用 aiti_user_choose 列出候选 op 让其选择，不要擅自回滚
