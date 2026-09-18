// react-syntax-highlighter 语言子路径的 ambient 声明（@types 包只声明主入口与少量
// esm 出口，不含 languages/prism/* 文件；SyntaxHighlighterLite 按语言显式静态导入）。
// 语法声明本体的类型无消费价值（仅传给 registerLanguage），统一 unknown。
declare module "react-syntax-highlighter/dist/esm/languages/prism/*" {
  const language: unknown;
  export default language;
}
