import { getFx } from "@/lib/fx";

export const dynamic = "force-dynamic";

/** USD→CNY exchange rate (24h lazy cache; see the header comment in lib/fx.ts for manual overrides). */
export async function GET() {
  return Response.json(await getFx());
}
