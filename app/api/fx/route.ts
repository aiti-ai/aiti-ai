import { getFx } from "@/lib/fx";

export const dynamic = "force-dynamic";

/** USD→CNY 汇率（24h 惰性缓存；手动覆盖见 lib/fx.ts 头注释）。 */
export async function GET() {
  return Response.json(await getFx());
}
