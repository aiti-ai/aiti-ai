/**
 * aiti-containers · port parsing.
 *
 * `docker ps` renders published ports as a flat string:
 *   "0.0.0.0:1025->1025/tcp, :::1025->1025/tcp, 1110/tcp"
 * The middle form (IPv6) and the trailing bare container port both matter, so we
 * parse the field into structured mappings instead of showing the raw string.
 */
export interface PortMapping {
  /** "" for unpublished container ports. */
  hostIp: string;
  /** 0 when the port is not published to the host. */
  hostPort: number;
  containerPort: number;
  proto: string;
  published: boolean;
}

const PROTO_RE = /^(tcp|udp|sctp)$/i;

/** Parse one `docker ps` Ports field into structured mappings. */
export function parsePortMappings(field: unknown): PortMapping[] {
  const out: PortMapping[] = [];
  for (const raw of String(field ?? "").split(",")) {
    const part = raw.trim();
    if (!part) continue;
    // Split host side from container side: "0.0.0.0:1025->1025/tcp" / "1110/tcp".
    const hasArrow = part.includes("->");
    const arrow = hasArrow ? part.split("->") : ["", part];
    const left = hasArrow ? (arrow[0] ?? "").trim() : "";
    const right = (arrow[1] ?? "").trim();
    const cParts = right.split("/");
    const containerPort = Number(cParts[0]);
    const proto = (cParts[1] ?? "tcp").toLowerCase();
    if (!Number.isInteger(containerPort) || containerPort <= 0 || !PROTO_RE.test(proto)) continue;

    if (!left) {
      out.push({ hostIp: "", hostPort: 0, containerPort, proto, published: false });
      continue;
    }
    const idx = left.lastIndexOf(":");
    const hostIp = idx >= 0 ? left.slice(0, idx).trim() : "";
    const hostPort = Number(left.slice(idx + 1));
    if (!Number.isInteger(hostPort) || hostPort <= 0) continue;
    out.push({ hostIp, hostPort, containerPort, proto, published: true });
  }
  return out;
}

export interface PortEntry {
  /** Host port (the one a tunnel would expose). */
  port: number;
  containerPort: number;
  proto: string;
  /** First non-empty host IP (IPv4 usually comes first in docker output). */
  hostIp: string;
  container: string;
  image: string;
  /** Compose project / service, when the container belongs to one. */
  project?: string;
  service?: string;
}

/**
 * Aggregate published ports across containers: one row per host port, IPv4/IPv6
 * duplicates collapsed (docker lists the same mapping twice).
 */
export function aggregatePorts(
  containers: Array<{ name?: string; image?: string; portsList?: PortMapping[]; compose?: { project?: string; service?: string } | null }>,
): PortEntry[] {
  const byKey = new Map<string, PortEntry>();
  for (const c of containers) {
    for (const p of c.portsList ?? []) {
      if (!p.published || !p.hostPort) continue;
      const key = p.hostPort + "/" + p.proto;
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.hostIp && p.hostIp) existing.hostIp = p.hostIp;
        continue;
      }
      byKey.set(key, {
        port: p.hostPort,
        containerPort: p.containerPort,
        proto: p.proto,
        hostIp: p.hostIp || "",
        container: String(c.name ?? ""),
        image: String(c.image ?? ""),
        ...(c.compose?.project ? { project: c.compose.project } : {}),
        ...(c.compose?.service ? { service: c.compose.service } : {}),
      });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => a.port - b.port);
}
