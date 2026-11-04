/**
 * 宿主扩展契约的本地镜像（lib/ext/types.ts 的 ExtMiddlewareResult）。
 *
 * 扩展代码运行在宿主进程内，但目录在宿主源码之外（~/.pi/web/extensions/），
 * 无法 import 宿主 TS 类型——这里用结构化镜像保持编译期检查；运行时由
 * 宿主 registry 按形状消费（{ handled: true, response } | { handled: false }）。
 */
export type ExtMiddlewareResult =
  | { handled: true; response: Response }
  | { handled: false }
  ;
