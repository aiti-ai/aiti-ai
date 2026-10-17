// JSX runtime shim for hook tests: the hook-under-test's JSX (e.g. I18nProvider)
// compiles to jsx()/jsxs() calls under the automatic runtime. Hook tests never
// render — the vnode is a plain record the tests can ignore.
export const Fragment = (props) => props?.children ?? null;
export function jsx(type, props, key) {
  return { type, props: { ...props, children: props?.children }, key: key ?? null };
}
export const jsxs = jsx;
export const jsxDEV = jsx;
