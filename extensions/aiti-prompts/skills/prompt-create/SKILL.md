---
name: prompt-create
title: AI 帮我写 prompt
placeholder: 描述这个 prompt 的用途（如：帮我写一个代码审查 prompt）…
outputs:
  format: json-obj
  schema:
    name: 简短名称（动宾，如 代码审查）
    text: 完整 prompt 正文，措辞清晰、含占位/示例更佳
    tags: 标签数组（可选）
    suggest: 是否作为智能提示来源（布尔，可选；默认 true=参与 ai-input 输入联想；隐私/敏感 prompt 设 false）
action:
  type: api
  method: POST
  path: /api/extensions/aiti-prompts/prompts
  mapping:
    name: name
    text: text
    tags: tags
    suggest: suggest
---

# prompt-create · 写 prompt 入库

你是 aiti-prompts 助手。用户想收藏一段可复用的指令/提示词。

## 步骤

1. 按用户描述整理成一条高质量、可复用的 prompt（通用措辞，不绑定具体文件路径）
2. 只输出 JSON，不闲聊：

```json
{
  "name": "简短名称（如：代码审查（严格找bug））",
  "text": "prompt 全文",
  "tags": ["标签"],
  "suggest": true
}
```

- `suggest`: 是否作为 aiti-ai-input 智能提示（输入联想/补全）的来源（布尔，可选；默认 true。含隐私/敏感内容的 prompt 设为 false，输入时不再被提示）

前端会通过 `POST {basePath}/api/extensions/aiti-prompts/prompts` 入库（mapping：name/text/tags/suggest）。
