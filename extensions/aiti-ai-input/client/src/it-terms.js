/**
 * IT 专业词汇 + 语音误听映射（词典层①，确定性 · 离线 · 毫秒级）
 * 设计：token/短语直接替换 + 编辑距离兜底（Levenshtein ≤2 命中术语表）
 * 误伤控制：仅对「疑似英文/代码 token」做替换，中文原意词不碰。
 */
export const IT_TERMS = Object.freeze({
  // ===== React / 前端 =====
  "useEffect": { variants: ["youse effect", "youseeffect", "有用的 effect", "有效果", "use effect"], weight: 100 },
  "useState": { variants: ["youse state", "yousestate", "有用的 state", "use state"], weight: 100 },
  "useRef": { variants: ["youse ref", "youseref", "有用的 ref", "use ref"], weight: 100 },
  "useCallback": { variants: ["youse callback", "use callback"], weight: 90 },
  "useMemo": { variants: ["youse memo", "有用的 memo", "use memo"], weight: 90 },
  "createContext": { variants: ["create context"], weight: 80 },
  "useEffect": { variants: ["youse effect", "youseeffect", "有用的 effect", "有效果", "use effect"], weight: 100 },
  "useState": { variants: ["youse state", "yousestate", "有用的 state", "use state"], weight: 100 },

  // ===== 语言 =====
  "TypeScript": { variants: ["typescript", "type script", "太空脚本", "打字脚本"], weight: 100 },
  "JavaScript": { variants: ["javascript", "java script", "杰瓦脚本"], weight: 100 },
  "Python": { variants: ["python", "派森", "蟒蛇"], weight: 80 },
  "Java": { variants: ["java"], weight: 50 },
  "Rust": { variants: ["rust", "拉斯"], weight: 50 },

  // ===== 命令/CLI =====
  "docker": { variants: ["doker", "dollhouse", "dokar", "多克"], weight: 100 },
  "docker compose": { variants: ["docker-compose", "doker compose", "多克组合"], weight: 100 },
  "npm install": { variants: ["npm i", "n p m install"], weight: 90 },
  "npm": { variants: ["n p m", "npm"], weight: 80 },
  "yarn": { variants: ["yarn", "雅恩"], weight: 70 },
  "git push": { variants: ["git push", "极推"], weight: 80 },
  "git commit": { variants: ["git commit", "极科米特", "科米特", "git科米特"], weight: 80 },
  "git pull": { variants: ["git pull", "极普尔"], weight: 80 },
  "localhost:3000": { variants: ["localhost 3000", "本地主机冒号三千", "本地主机三千"], weight: 100 },
  "localhost": { variants: ["local host", "本地主机"], weight: 90 },
  "localhost": { variants: ["local host", "本地主机", "本地好死"], weight: 90 },

  // ===== 后端/数据 =====
  "PostgreSQL": { variants: ["postgres", "postgres ql", "波斯特格瑞"], weight: 90 },
  "Redis": { variants: ["redis", "瑞迪斯"], weight: 80 },
  "MongoDB": { variants: ["mongo db", "mongodb", "蒙哥数据库"], weight: 80 },
  "MySQL": { variants: ["my sql", "mysql", "买 SQL"], weight: 80 },
  "Express": { variants: ["express", "快递斯"], weight: 70 },
  "FastAPI": { variants: ["fast api", "快的 API"], weight: 80 },
  "Django": { variants: ["django", "姜戈"], weight: 70 },

  // ===== AI/ML =====
  "transformer": { variants: ["transformer", "变形金刚"], weight: 80 },
  "embedding": { variants: ["embedding", "嵌入"], weight: 70 },
  "attention": { variants: ["attention", "注意力"], weight: 60 },
  "RAG": { variants: ["rag", "拉格"], weight: 70 },
  "prompt": { variants: ["prompt", "普罗姆特", "提示词"], weight: 80 },
  "token": { variants: ["token", "托肯", "令牌"], weight: 70 },

  // ===== 网络/协议 =====
  "WebSocket": { variants: ["web socket", "websocket", "网络套接字"], weight: 80 },
  "JSON": { variants: ["json", "杰森"], weight: 60 },
  "REST": { variants: ["rest", "雷斯特"], weight: 60 },
  "GraphQL": { variants: ["graphql", "格拉夫 Q L"], weight: 80 },

  // ===== 运维/部署 =====
  "Kubernetes": { variants: ["k8s", "k 8 s", "库伯内特斯"], weight: 90 },
  "Dockerfile": { variants: ["docker file", "dockerfile", "多克文件"], weight: 80 },
  "CI/CD": { variants: ["ci cd", "c i c d", "持续集成"], weight: 70 },
  "Nginx": { variants: ["nginx", "恩基克斯"], weight: 70 },
});

// 常见停用词（动态术语提取时过滤，避免把通用词当术语）
export const STOPWORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for","with","by","from","of","is","it","this","that","these","those",
  "function","class","return","import","export","default","const","let","var","if","else","for","while","switch","case",
  "true","false","null","undefined","string","number","boolean","object","array",
]);

/**
 * 动态上下文术语表（从会话消息/当前文件/项目依赖提取）
 * 权重：最近消息 > 当前文件 > package.json > 静态表
 */
export function getContextTerms({ recentMessages, activeFilePath, packageJson } = {}) {
  const terms = new Map();

  const add = (term, weight) => {
    const key = String(term).trim();
    if (!key || STOPWORDS.has(key.toLowerCase())) return;
    if (!/^[A-Za-z][A-Za-z0-9_.\-:/]{1,60}$/.test(key)) return;
    terms.set(key, (terms.get(key) || 0) + weight);
  };

  if (Array.isArray(recentMessages)) {
    const text = recentMessages.map(m => typeof m === "string" ? m : (m.content || "")).join("\n");
    const words = text.match(/[A-Za-z][A-Za-z0-9_.\-:/]{2,60}/g) || [];
    for (const w of words.slice(-80)) add(w, 10);
  }

  if (typeof activeFilePath === "string" && activeFilePath) {
    const name = activeFilePath.split(/[\\/]+/).filter(Boolean).pop() || "";
    if (name) add(name, 8);
  }

  if (packageJson && typeof packageJson === "object") {
    for (const dep of Object.keys(packageJson.dependencies || {})) add(dep, 6);
    for (const dep of Object.keys(packageJson.devDependencies || {})) add(dep, 5);
  }

  return terms;
}

export default IT_TERMS;
