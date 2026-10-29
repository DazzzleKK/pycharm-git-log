/* Verifies the lane assignment invariant on real and random DAGs:
 * every edge's target lane must be the lane where its parent commit is drawn. */
const { execFileSync } = require('node:child_process');
require('../media/graph.js');
const { computeGraph } = globalThis.PyCharmGraph;

function check(commits, label) {
  const graph = computeGraph(commits, { rowH: 24, laneW: 14, padX: 10 });
  const rowOf = new Map(commits.map((commit, index) => [commit.hash, index]));
  let checked = 0;
  for (let i = 0; i < commits.length; i++) {
    const row = graph.rows[i];
    const parents = commits[i].parents;
    let edgeIndex = 0;
    for (const parent of parents) {
      const parentRow = rowOf.get(parent);
      if (parentRow === undefined) {
        continue;
      }
      const edge = row.edges[edgeIndex++];
      if (!edge) {
        throw new Error(`${label}: missing edge on row ${i} to ${parent.slice(0, 7)}`);
      }
      const targetLane = graph.rows[parentRow].lane;
      if (edge.to !== targetLane) {
        throw new Error(
          `${label}: row ${i} (lane ${row.lane}) -> parent row ${parentRow} (lane ${targetLane}) drawn at lane ${edge.to}\n` +
            `  parent ${parent.slice(0, 7)}`
        );
      }
      checked++;
    }
  }
  // no two nodes on the same lane in the same row is trivial; lanes must be in range
  for (const row of graph.rows) {
    if (row.lane < 0 || row.lane >= graph.maxLanes) {
      throw new Error(`${label}: lane out of range`);
    }
  }
  return { rows: graph.rows.length, edges: checked, maxLanes: graph.maxLanes, width: graph.width };
}

const repo = process.argv[2];
if (repo) {
  const out = execFileSync(
    'git',
    ['-C', repo, 'log', '--all', '--topo-order', '--pretty=format:%H%x1f%P%x1f%s%x1e'],
    { encoding: 'utf8' }
  );
  const commits = out
    .split('\x1e')
    .map((chunk) => chunk.replace(/^\s+/, ''))
    .filter(Boolean)
    .map((chunk) => {
      const [hash, parents, subject] = chunk.split('\x1f');
      return { hash, parents: parents ? parents.split(' ') : [], subject };
    });
  console.log('repo:', check(commits, 'repo'), 'commits:', commits.length);
  commits.forEach((commit, index) => {
    const row = computeGraph(commits, { rowH: 24, laneW: 14, padX: 10 }).rows[index];
    console.log(
      String(index).padStart(2),
      'lane', String(row.lane).padStart(2),
      '->',
      row.edges.map((edge) => edge.to).join(','),
      '|',
      commit.subject.slice(0, 60)
    );
  });
}

// random DAGs
let seed = 123456789;
function rnd() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
}

for (let round = 0; round < 300; round++) {
  const count = 5 + Math.floor(rnd() * 60);
  const commits = [];
  for (let i = 0; i < count; i++) {
    const parents = [];
    if (i > 0 && rnd() < 0.92) {
      parents.push('c' + (i + 1 + Math.floor(rnd() * 3)));
    }
    if (rnd() < 0.18) {
      parents.push('c' + (i + 1 + Math.floor(rnd() * 6)));
    }
    commits.push({
      hash: 'c' + i,
      parents: parents.filter((p, idx, arr) => arr.indexOf(p) === idx && Number(p.slice(1)) < count),
    });
  }
  check(commits, 'random#' + round);
}
console.log('random DAGs: ok');
