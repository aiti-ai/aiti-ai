// Ambient declarations for react-syntax-highlighter language subpaths (the @types
// package only declares the main entry and a few esm exports, not the
// languages/prism/* files; SyntaxHighlighterLite imports them statically per language).
// The syntax declarations themselves have no consumable type value (they are only
// passed to registerLanguage), so they are uniformly unknown.
declare module "react-syntax-highlighter/dist/esm/languages/prism/*" {
  const language: unknown;
  export default language;
}
