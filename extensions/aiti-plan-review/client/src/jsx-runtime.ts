// esbuild 自动 JSX runtime 别名目标：jsx/jsxs/Fragment 全委托 host-shim
export { jsx, jsxs, Fragment } from "./host-shim";
import { jsx } from "./host-shim";

// dev JSX runtime（react/jsx-dev-runtime 也被 vite alias 到本文件）：esbuild 在
// development 模式下生成 jsxDEV(type, props, key, isStatic, source, self) 调用。
// 前 3 参与 jsx 相同；后 3 个是 dev 调试信息（定位栈），宿主渲染原语用不上 → 直接丢弃。
export const jsxDEV = (type: unknown, props: unknown, key: unknown, ..._dev: unknown[]): unknown =>
	jsx(type, props, key);
