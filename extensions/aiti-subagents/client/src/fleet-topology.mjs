/**
 * fleet-topology · fleet/status runs → topology data (pure, no DOM).
 *
 * Graph/tree dual-mode topology view data layer (dsh-better-sidebar borrow plan §2.2).
 * fleet rows already carry the parent chain: `parentSessionFile` = parent session file
 * path, `sessionFile` = this run's own session file. A child run whose parent is another
 * run's sessionFile nests under it (workflow parallel/dependency chains collapse into a
 * layered DAG from the call structure); runs whose parent session is not in the set are
 * roots (their parent is a plain AI session).
 */

/** Build topology nodes from fleet run rows. Returns { nodes, roots, maxDepth } —
 *  each node: { run, parent, children, depth, orphan }. Cycle-safe (cycle members surface as roots). */
export function buildTopology(runs) {
  const list = (Array.isArray(runs) ? runs : []).filter((r) => r && typeof r === "object");
  const nodes = list.map((run) => ({ run, parent: null, children: [], depth: 0, orphan: true }));
  const byFile = new Map();
  for (const n of nodes) {
    const f = n.run.sessionFile;
    if (typeof f === "string" && f && !byFile.has(f)) byFile.set(f, n);
  }
  for (const n of nodes) {
    const pf = n.run.parentSessionFile;
    const parent = typeof pf === "string" && pf ? byFile.get(pf) : null;
    if (parent && parent !== n) {
      n.orphan = false;
      n.parent = parent;
      parent.children.push(n);
    }
  }
  // Depth from roots (BFS). Nodes swallowed by a cycle never get reached here and are
  // promoted back to roots below so nothing silently disappears.
  const roots = nodes.filter((n) => n.orphan);
  const seen = new Set();
  let maxDepth = 0;
  const queue = roots.map((n) => (seen.add(n), [n, 0]));
  while (queue.length) {
    const [n, d] = queue.shift();
    n.depth = d;
    if (d > maxDepth) maxDepth = d;
    for (const c of n.children) {
      if (!seen.has(c)) { seen.add(c); queue.push([c, d + 1]); }
    }
  }
  for (const n of nodes) {
    if (!seen.has(n)) { n.orphan = true; roots.push(n); }
  }
  // Sibling order: earlier runs first (workflow launch order); roots: newest first.
  const byCreated = (a, b) => (a.run.createdAt || 0) - (b.run.createdAt || 0);
  for (const n of nodes) n.children.sort(byCreated);
  roots.sort((a, b) => byCreated(b, a));
  return { nodes, roots, maxDepth };
}

/** Depth-banded layers for left-to-right graph layout: layers[depth] = [nodes], DFS from roots. */
export function topologyLayers(topology) {
  const layers = [];
  const walk = (n) => {
    (layers[n.depth] ||= []).push(n);
    for (const c of n.children) walk(c);
  };
  for (const r of topology.roots) walk(r);
  for (let i = 0; i < layers.length; i++) if (!layers[i]) layers[i] = [];
  return layers;
}

/** Flat depth-keyed count (badge helper). */
export function topologyCounts(topology) {
  const byDepth = new Map();
  for (const n of topology.nodes) byDepth.set(n.depth, (byDepth.get(n.depth) || 0) + 1);
  return { total: topology.nodes.length, byDepth };
}
