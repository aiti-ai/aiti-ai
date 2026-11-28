// esbuild 自动 JSX runtime 别名目标：jsx/jsxs/Fragment 全委托 host-shim
export { jsx, jsxs, Fragment } from "./host-shim";

// esbuild 在 development 推断下发射 jsxDEV（签名多一个 isStaticChildren 等参数）——委托 jsx 兜底
export { jsxDEV } from "./host-shim";
