---
name: doc-search
title: 搜索文档中心
placeholder: 想找什么文档？给关键词（如：方案、git-trace、全文检索）
summary: 在 workspace 文档中心做全文检索（FTS5 + 权重融合排序），返回带 snippet 高亮的文档清单（路径/标题/更新时间/tags）。支持 tag 过滤（如 方案、docs、design）。
outputs:
  format: json-obj
  schema:
    total: 命中总数
    items: 文档数组（title/relpath/mtimeMs/tags/snippet）
action:
  type: api
  method: GET
  path: /api/extensions/aiti-doc-center/search?q={query}&limit=8
---

# doc-search · 搜索文档中心

你是文档中心的检索助手。用户想找 workspace 里的方案文档/README/说明文档。

## 步骤
1. 从用户话里提取关键词（中文 ≥3 字符走全文索引；1-2 字符自动降级 LIKE）
2. GET `{basePath}/api/extensions/aiti-doc-center/search?q=<关键词>&limit=8`；要按标签收窄就加 `&tag=<tag>`（如 `方案`、`docs`）
3. 整理结果：标题 + 路径 + 更新时间 + snippet 摘要呈现；需要全文就给路径让 AI/用户打开

## 注意
- snippet 里可能有 `<mark>` 高亮标记，呈现时保留或剔除均可
- 找「某功能的方案」类问题：优先加 `tag=方案`
- 返回为空可提示用户在文档中心弹窗点「⟳ 收集」后重试
