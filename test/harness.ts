import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';
import { GitRepo, parseNameStatusZ, parseNumstatZ } from '../src/git';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcgit-test-'));
const remote = path.join(root, 'remote.git');
const repoDir = path.join(root, 'repo');
fs.mkdirSync(repoDir);
fs.mkdirSync(remote);

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test User',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test User',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_AUTHOR_DATE: '2026-01-01T10:00:00+07:00',
  GIT_COMMITTER_DATE: '2026-01-01T10:00:00+07:00',
};

function git(args: string[], cwd = repoDir): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env });
}

function write(file: string, text: string): void {
  fs.writeFileSync(path.join(repoDir, file), text);
}

function step(name: string): void {
  console.log('·', name);
}

async function main(): Promise<void> {
  step('init repo');
  git(['init', '-b', 'main']);
  git(['init', '--bare', remote]);
  git(['config', 'user.name', 'Test User']);
  git(['config', 'user.email', 'test@example.com']);

  write('a.txt', 'one\n');
  write('b.txt', 'two\n');
  git(['add', '.']);
  git(['commit', '-m', 'initial commit']);
  git(['tag', 'v1.0']);
  write('b.txt', 'two changed\n');
  git(['add', '.']);
  git(['commit', '-m', 'second commit']);

  git(['checkout', '-b', 'feature/payments']);
  write('c.txt', 'feature\n');
  git(['add', '.']);
  git(['commit', '-m', 'feature: add c']);
  write('c.txt', 'feature v2\n');
  git(['add', '.']);
  git(['commit', '-m', 'feature: tweak c']);

  git(['checkout', 'main']);
  git(['merge', '--no-ff', 'feature/payments', '-m', 'Merge feature/payments']);

  step('remote + tracking');
  git(['remote', 'add', 'origin', remote]);
  git(['push', '-u', 'origin', 'main', 'feature/payments']);
  write('a.txt', 'one\nmore\n');
  git(['add', '.']);
  git(['commit', '-m', 'main: local change']);

  step('rename branch');
  git(['checkout', '-b', 'rename-test']);
  git(['mv', 'b.txt', 'd.txt']);
  git(['commit', '-m', 'rename b to d']);

  step('parse branches/log/details');
  const repo = new GitRepo(repoDir);
  const refs = await repo.branches();
  assert.equal(refs.current, 'rename-test');
  assert.equal(refs.detached, false);
  assert.ok(refs.branches.some((b) => b.name === 'main' && !b.isRemote));
  assert.ok(refs.branches.some((b) => b.name === 'origin/main' && b.isRemote));
  const main = refs.branches.find((b) => b.name === 'main');
  assert.ok(main);
  assert.equal(main?.ahead, 1, 'main should be ahead by 1 after local commit');
  assert.equal(main?.behind, 0);

  const tags = await repo.tags();
  assert.ok(tags.some((t) => t.name === 'v1.0'));

  const commits = await repo.log('main', 50);
  assert.ok(commits.length >= 5);
  const merge = commits.find((c) => c.subject === 'Merge feature/payments');
  assert.ok(merge, 'merge commit present');
  assert.equal(merge?.parents.length, 2);

  const featureCommits = await repo.log('origin/feature/payments', 50);
  assert.equal(featureCommits[0].subject, 'feature: tweak c');

  const all = await repo.log(null, 100);
  assert.ok(all.length >= commits.length);

  const details = await repo.details(merge!.hash, merge!.parents);
  assert.ok(details.files.length >= 1, 'merge has files vs first parent');
  assert.ok(details.body.includes('Merge feature/payments'));

  const renameLog = await repo.log('rename-test', 10);
  const renameCommit = renameLog.find((c) => c.subject === 'rename b to d');
  assert.ok(renameCommit);
  const renameDetails = await repo.details(renameCommit!.hash, renameCommit!.parents);
  const renamed = renameDetails.files.find((f) => f.path === 'd.txt');
  assert.ok(renamed, 'rename target present');
  assert.equal(renamed?.status, 'R');
  assert.equal(renamed?.oldPath, 'b.txt');

  const content = await repo.fileContent('main', 'a.txt');
  assert.ok(content.toString('utf8').includes('one'));

  step('parse numstat -z');
  const numstat = parseNumstatZ('12\t3\tsrc/file.ts\0-\t-\timage.png\0');
  assert.deepEqual(numstat.get('src/file.ts'), { adds: 12, dels: 3, binary: false });
  assert.equal(numstat.get('image.png')?.binary, true);

  step('graph');
  const graphGlobal = globalThis as unknown as {
    PyCharmGraph?: { computeGraph: (commits: Array<{ hash: string; parents: string[] }>, o: object) => { rows: any[]; width: number } };
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../media/graph.js');
  assert.ok(graphGlobal.PyCharmGraph, 'graph module loaded');
  const graph = graphGlobal.PyCharmGraph!.computeGraph(
    all.map((c) => ({ hash: c.hash, parents: c.parents })),
    { rowH: 24, laneW: 14, padX: 10 }
  );
  assert.equal(graph.rows.length, all.length);
  assert.ok(graph.width >= 24);
  for (const row of graph.rows) {
    assert.ok(row.lane >= 0);
    assert.ok(row.shapes.length > 0);
    for (const shape of row.shapes) {
      assert.ok(shape.x1 >= 0 && shape.x1 <= graph.width, 'x within graph');
      assert.ok(shape.y1 >= 0 && shape.y2 <= 24, 'y within row');
    }
  }

  step('name-status parse');
  const parsed = parseNameStatusZ('M\0a.txt\0R100\0b.txt\0d.txt\0A\0new.txt\0');
  assert.equal(parsed.length, 3);
  assert.equal(parsed[1].oldPath, 'b.txt');
  assert.equal(parsed[1].path, 'd.txt');

  console.log('\nAll checks passed. Repo:', repoDir);
}

main().catch((error) => {
  console.error('\nTEST FAILED');
  console.error(error);
  process.exitCode = 1;
});
