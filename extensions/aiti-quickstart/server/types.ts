/** aiti-quickstart · ExtApiCtx（与 session-manager/server/api.ts 同形；宽松避免依赖框架包）。 */
export interface ExtApiCtx {
  configDir: string;
  /** 缓存区（三目录对称）；旧宿主/测试缺省时由 dirname(configDir) 推导 */
  cacheDir?: string;
  path: string[];
  searchParams: URLSearchParams;
  core?: unknown;
  /** 跨扩展服务定位器（框架 ExtServerContext.services；宽松类型）。 */
  services?: {
    get?: <T = unknown>(key: string) => T | undefined;
  };
}
