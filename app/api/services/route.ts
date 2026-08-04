import { NextRequest, NextResponse } from "next/server";
import { getServicePorts, getServiceHostSuffix, getServiceHostSuffixes } from "@/lib/service-ports";
import { getTunnelInfos } from "@/lib/tunnels";
import { isApiRequestAllowed } from "@/lib/request-security";

// GET /api/services?refresh=1
// Lists TCP ports that pi-web's own process tree (the in-process pi agent and
// everything it spawned) is currently listening on. The returned set is also
// the allow-list used by proxy.ts to decide which ports may be proxied via
// their virtual host <port><suffix>.
export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const refresh = request.nextUrl.searchParams.get("refresh") === "1";
  const services = getServicePorts(refresh);
  return NextResponse.json({
    services,
    serviceHostSuffix: getServiceHostSuffix(),
    serviceHostSuffixes: getServiceHostSuffixes(),
    tunnels: getTunnelInfos(),
    platform: process.platform,
  });
}
