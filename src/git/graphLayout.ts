/* Lane layout for the commit graph. Pure module. */

export interface GraphInputCommit {
  sha: string;
  parents: string[];
}

export interface GraphEdge {
  /** lane at the start of the segment */
  fromLane: number;
  /** lane at the end of the segment */
  toLane: number;
  /** 'top' = from top of row to node / bottom; 'node' = from node to bottom of row */
  kind: 'pass' | 'in' | 'out';
  color: number;
}

export interface GraphRow {
  sha: string;
  lane: number;
  color: number;
  edges: GraphEdge[];
  /** number of lanes used in this row (for width calculation) */
  width: number;
}

/**
 * Computes lanes for commits given in topological order (children before parents).
 * Each row contains:
 *  - 'pass' edges: lines that cross the row vertically (top → bottom) without touching the node
 *  - 'in' edges: lines from the top of the row into the node
 *  - 'out' edges: lines from the node to the bottom of the row, towards its parents
 */
export function layoutGraph(commits: GraphInputCommit[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const laneColors: number[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];

  const allocLane = (sha: string, color?: number): number => {
    let idx = lanes.indexOf(null);
    if (idx === -1) {
      idx = lanes.length;
      lanes.push(sha);
    } else {
      lanes[idx] = sha;
    }
    laneColors[idx] = color ?? nextColor++;
    return idx;
  };

  for (const commit of commits) {
    const edges: GraphEdge[] = [];
    const before = lanes.slice();

    // Lanes that were waiting for this commit
    const incoming: number[] = [];
    before.forEach((s, i) => {
      if (s === commit.sha) incoming.push(i);
    });

    let lane: number;
    if (incoming.length === 0) {
      lane = allocLane(commit.sha);
    } else {
      lane = incoming[0];
    }
    const color = laneColors[lane];

    for (const i of incoming) {
      edges.push({ fromLane: i, toLane: lane, kind: 'in', color: laneColors[i] });
      if (i !== lane) lanes[i] = null;
    }

    // Pass-through lanes
    before.forEach((s, i) => {
      if (s !== null && s !== commit.sha) edges.push({ fromLane: i, toLane: i, kind: 'pass', color: laneColors[i] });
    });

    // Parents
    if (commit.parents.length === 0) {
      lanes[lane] = null;
    } else {
      const [first, ...rest] = commit.parents;
      const existingFirst = lanes.findIndex((s, i) => s === first && i !== lane);
      if (existingFirst !== -1) {
        // First parent already tracked by another lane: merge into it and free ours
        lanes[lane] = null;
        edges.push({ fromLane: lane, toLane: existingFirst, kind: 'out', color });
      } else {
        lanes[lane] = first;
        edges.push({ fromLane: lane, toLane: lane, kind: 'out', color });
      }
      for (const p of rest) {
        let target = lanes.indexOf(p);
        if (target === -1) target = allocLane(p);
        edges.push({ fromLane: lane, toLane: target, kind: 'out', color: laneColors[target] });
      }
    }

    // Trim trailing empty lanes
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();

    const width = Math.max(before.length, lanes.length, lane + 1);
    rows.push({ sha: commit.sha, lane, color, edges, width });
  }
  return rows;
}
