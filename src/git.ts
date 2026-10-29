import { spawn } from 'node:child_process';

/** Well-known hash of git's empty tree. Used to diff the root commit. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface RunOptions {
  /** Kill git after this many ms. 0/undefined means no timeout. */
  timeoutMs?: number;
}

export class GitError extends Error {
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly args: string[];

  constructor(
    message: string,
    opts: { stderr?: string; code?: number | null; args?: string[] } = {}
  ) {
    super(message);
    this.name = 'GitError';
    this.stderr = opts.stderr ?? '';
    this.exitCode = opts.code ?? null;
    this.args = opts.args ?? [];
  }
}

function formatGitError(args: string[], code: number | null, stderr: string): string {
  const text = stderr.trim();
  if (text) {
    const lines = text
      .split(/\r?\n/)
      .filter((line) => line.trim() && !/^hint:/i.test(line))
      .slice(0, 8);
    if (lines.length) {
      return lines.join('\n');
    }
  }
  return `git ${args[0] ?? ''} exited with code ${code ?? '?'}`;
}

function runGit(root: string, args: string[], options: RunOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd: root,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_PAGER: 'cat',
          LC_ALL: 'C',
          LANGUAGE: 'en',
        },
      });
    } catch (e) {
      reject(new GitError(`Failed to start git: ${(e as Error).message}`, { args }));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      fn();
    };

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (e) => {
      finish(() => reject(new GitError(`Failed to run git: ${e.message}`, { args })));
    });
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) {
          resolve(Buffer.concat(stdout));
          return;
        }
        const err = Buffer.concat(stderr).toString('utf8');
        reject(
          new GitError(formatGitError(args, code, err), {
            stderr: err,
            code,
            args,
          })
        );
      });
    });

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
      }, options.timeoutMs);
    }
  });
}

export async function execGit(root: string, args: string[], options: RunOptions = {}): Promise<string> {
  return (await runGit(root, args, options)).toString('utf8');
}

export async function execGitBuffer(root: string, args: string[], options: RunOptions = {}): Promise<Buffer> {
  return runGit(root, args, options);
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface BranchInfo {
  /** Full ref name, e.g. refs/heads/main or refs/remotes/origin/main. */
  ref: string;
  /** Short name: "main" for local, "origin/main" for remote. */
  name: string;
  isRemote: boolean;
  /** Remote name for remote branches (origin), null for local. */
  remote: string | null;
  current: boolean;
  sha: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
  subject: string;
  date: number;
}

export interface RefsResult {
  current: string | null;
  detached: boolean;
  headSha: string | null;
  branches: BranchInfo[];
}

export interface TagInfo {
  name: string;
  sha: string;
}

export interface CommitInfo {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  authorTime: number;
  commitTime: number;
  subject: string;
  refs: RefBadge[];
}

export type RefKind = 'head' | 'local' | 'remote' | 'tag';

export interface RefBadge {
  kind: RefKind;
  name: string;
  current?: boolean;
}

export interface FileChange {
  path: string;
  oldPath?: string;
  status: string;
  adds: number;
  dels: number;
  binary: boolean;
}

export interface CommitDetails {
  body: string;
  files: FileChange[];
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

const FIELD = '\u001f';
const RECORD = '\u001e';
const LOG_FORMAT = ['%H', '%h', '%P', '%an', '%ae', '%at', '%ct', '%s'].join(FIELD) + RECORD;
const BRANCH_FORMAT = [
  '%(refname)',
  '%(refname:short)',
  '%(objectname)',
  '%(HEAD)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
  '%(committerdate:unix)',
  '%(subject)',
].join('%00');

export function parseLog(out: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  for (const chunk of out.split(RECORD)) {
    const record = chunk.replace(/^[\r\n]+/, '');
    if (!record) {
      continue;
    }
    const fields = record.split(FIELD);
    if (fields.length < 8) {
      continue;
    }
    const [hash, short, parents, author, email, authorTime, commitTime, subject] = fields;
    commits.push({
      hash,
      short,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      author,
      email,
      authorTime: Number(authorTime) || 0,
      commitTime: Number(commitTime) || 0,
      subject: subject ?? '',
      refs: [],
    });
  }
  return commits;
}

function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  if (!track) {
    return { ahead: 0, behind: 0, gone: false };
  }
  if (track === 'gone') {
    return { ahead: 0, behind: 0, gone: true };
  }
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    gone: false,
  };
}

export function parseBranches(out: string): BranchInfo[] {
  const branches: BranchInfo[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const [ref, short, sha, head, upstream, track, date, subject] = line.split('\u0000');
    if (!ref || !ref.startsWith('refs/')) {
      continue;
    }
    if (ref.endsWith('/HEAD')) {
      continue;
    }
    const isRemote = ref.startsWith('refs/remotes/');
    const name = isRemote ? short : short;
    const parsed = parseTrack(track ?? '');
    branches.push({
      ref,
      name,
      isRemote,
      remote: isRemote ? name.split('/')[0] : null,
      current: head === '*',
      sha,
      upstream: upstream || null,
      ahead: parsed.ahead,
      behind: parsed.behind,
      gone: parsed.gone,
      subject: subject ?? '',
      date: Number(date) || 0,
    });
  }
  branches.sort((a, b) => {
    if (a.current !== b.current) {
      return a.current ? -1 : 1;
    }
    if (a.isRemote !== b.isRemote) {
      return a.isRemote ? 1 : -1;
    }
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  return branches;
}

export function parseNameStatusZ(out: string): Array<{ status: string; path: string; oldPath?: string }> {
  const parts = out.split('\u0000');
  const files: Array<{ status: string; path: string; oldPath?: string }> = [];
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i];
    if (!token) {
      continue;
    }
    const status = token[0];
    if (status === 'R' || status === 'C') {
      const oldPath = parts[++i];
      const newPath = parts[++i];
      if (newPath) {
        files.push({ status, path: newPath, oldPath: oldPath || undefined });
      }
    } else {
      const filePath = parts[++i];
      if (filePath) {
        files.push({ status, path: filePath });
      }
    }
  }
  return files;
}

export interface NumstatEntry {
  adds: number;
  dels: number;
  binary: boolean;
}

export function parseNumstatZ(out: string): Map<string, NumstatEntry> {
  const result = new Map<string, NumstatEntry>();
  const parts = out.split('\u0000');
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i];
    if (!token) {
      continue;
    }
    const firstTab = token.indexOf('\t');
    const secondTab = token.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) {
      continue;
    }
    const addsRaw = token.slice(0, firstTab);
    const delsRaw = token.slice(firstTab + 1, secondTab);
    let filePath = token.slice(secondTab + 1);
    if (!filePath) {
      // Rename/copy with -z: "a\td\t\0old\0new\0"
      i++; // old path
      filePath = parts[++i] ?? '';
    }
    if (!filePath) {
      continue;
    }
    const binary = addsRaw === '-' || delsRaw === '-';
    result.set(filePath, {
      adds: binary ? 0 : Number(addsRaw) || 0,
      dels: binary ? 0 : Number(delsRaw) || 0,
      binary,
    });
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Repository                                                          */
/* ------------------------------------------------------------------ */

export class GitRepo {
  constructor(readonly root: string) {}

  run(args: string[], options: RunOptions = {}): Promise<string> {
    return execGit(this.root, args, options);
  }

  async head(): Promise<{ current: string | null; detached: boolean; sha: string | null }> {
    let sha: string | null = null;
    try {
      sha = (await this.run(['rev-parse', 'HEAD'])).trim() || null;
    } catch {
      sha = null;
    }
    if (!sha) {
      return { current: null, detached: false, sha: null };
    }
    try {
      const abbrev = (await this.run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      if (abbrev === 'HEAD') {
        return { current: null, detached: true, sha };
      }
      return { current: abbrev, detached: false, sha };
    } catch {
      return { current: null, detached: false, sha };
    }
  }

  async branches(): Promise<RefsResult> {
    const out = await this.run(['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes'], {
      timeoutMs: 30_000,
    });
    const branches = parseBranches(out);
    const head = await this.head();
    for (const branch of branches) {
      if (head.current && branch.name === head.current) {
        branch.current = true;
      }
    }
    return {
      current: head.current,
      detached: head.detached,
      headSha: head.sha,
      branches,
    };
  }

  async tags(): Promise<TagInfo[]> {
    const out = await this.run(
      ['for-each-ref', '--format=%(refname:short)%00%(objectname)%00%(*objectname)', 'refs/tags'],
      { timeoutMs: 30_000 }
    );
    const tags: TagInfo[] = [];
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      const [name, object, deref] = line.split('\u0000');
      if (name && (deref || object)) {
        tags.push({ name, sha: deref || object });
      }
    }
    return tags;
  }

  async remotes(): Promise<string[]> {
    try {
      const out = await this.run(['remote']);
      return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  async hasCommits(): Promise<boolean> {
    try {
      await this.run(['rev-parse', '--verify', '--quiet', 'HEAD']);
      return true;
    } catch {
      return false;
    }
  }

  async resolve(rev: string): Promise<string | null> {
    try {
      const out = await this.run(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
      return out.trim() || null;
    } catch {
      return null;
    }
  }

  async branchExists(name: string): Promise<boolean> {
    try {
      await this.run(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @param rev branch name, tag, range (a..b) or null for --all
   */
  async log(rev: string | null, limit: number): Promise<CommitInfo[]> {
    const args = [
      'log',
      '--no-color',
      '--no-show-signature',
      `--max-count=${limit}`,
      '--topo-order',
      `--pretty=format:${LOG_FORMAT}`,
    ];
    if (rev) {
      args.push(rev);
    } else {
      args.push('--all');
    }
    const out = await this.run(args, { timeoutMs: 60_000 });
    return parseLog(out);
  }

  async logSingle(rev: string): Promise<CommitInfo | null> {
    const commits = await this.log(rev, 1);
    return commits[0] ?? null;
  }

  async commitBody(hash: string): Promise<string> {
    return (await this.run(['show', '-s', '--format=%B', hash], { timeoutMs: 30_000 })).replace(/\s+$/, '');
  }

  async commitFiles(hash: string, parents: string[]): Promise<FileChange[]> {
    const base = parents[0] ?? EMPTY_TREE;
    const common = ['--no-color', '--find-renames', '-M', '-z'];
    const statusOut = await this.run(['diff', ...common, '--name-status', base, hash], { timeoutMs: 60_000 });
    const numstatOut = await this.run(['diff', ...common, '--numstat', base, hash], { timeoutMs: 60_000 });
    const statuses = parseNameStatusZ(statusOut);
    const stats = parseNumstatZ(numstatOut);
    return statuses.map((entry, index) => {
      const stat = stats.get(entry.path) ?? (stats.size === statuses.length ? [...stats.values()][index] : undefined);
      return {
        path: entry.path,
        oldPath: entry.oldPath,
        status: entry.status,
        adds: stat?.adds ?? 0,
        dels: stat?.dels ?? 0,
        binary: stat?.binary ?? false,
      };
    });
  }

  async details(hash: string, parents: string[]): Promise<CommitDetails> {
    const [body, files] = await Promise.all([this.commitBody(hash), this.commitFiles(hash, parents)]);
    return { body, files };
  }

  async fileContent(rev: string, filePath: string): Promise<Buffer> {
    return execGitBuffer(this.root, ['show', `${rev}:${filePath}`], { timeoutMs: 60_000 });
  }

  async statusCount(): Promise<number> {
    try {
      const out = await this.run(['status', '--porcelain=v1', '-uno'], { timeoutMs: 20_000 });
      return out.split(/\r?\n/).filter(Boolean).length;
    } catch {
      return 0;
    }
  }

  /* ------------------------------ mutations ----------------------------- */

  async checkoutBranch(name: string, isRemote: boolean): Promise<{ branch: string; created: boolean }> {
    if (isRemote) {
      const localName = name.split('/').slice(1).join('/');
      if (await this.branchExists(localName)) {
        await this.run(['checkout', localName], { timeoutMs: 120_000 });
        return { branch: localName, created: false };
      }
      await this.run(['checkout', '-b', localName, '--track', name], { timeoutMs: 120_000 });
      return { branch: localName, created: true };
    }
    await this.run(['checkout', name], { timeoutMs: 120_000 });
    return { branch: name, created: false };
  }

  async checkoutDetached(sha: string): Promise<void> {
    await this.run(['checkout', '--detach', sha], { timeoutMs: 120_000 });
  }

  async createBranch(name: string, from?: string | null): Promise<void> {
    const args = ['checkout', '-b', name];
    if (from) {
      args.push(from);
    }
    await this.run(args, { timeoutMs: 120_000 });
  }

  async deleteBranch(name: string, force: boolean): Promise<void> {
    await this.run(['branch', force ? '-D' : '-d', name], { timeoutMs: 60_000 });
  }

  async renameBranch(oldName: string, newName: string): Promise<void> {
    await this.run(['branch', '-m', oldName, newName], { timeoutMs: 60_000 });
  }

  async merge(rev: string): Promise<void> {
    await this.run(['merge', '--no-edit', rev], { timeoutMs: 120_000 });
  }

  async rebase(rev: string): Promise<void> {
    await this.run(['rebase', rev], { timeoutMs: 180_000 });
  }

  async cherryPick(hash: string): Promise<void> {
    await this.run(['cherry-pick', hash], { timeoutMs: 120_000 });
  }

  async revert(hash: string): Promise<void> {
    await this.run(['revert', '--no-edit', hash], { timeoutMs: 120_000 });
  }

  async reset(hash: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    await this.run(['reset', `--${mode}`, hash], { timeoutMs: 120_000 });
  }

  async createTag(name: string, hash: string, message?: string): Promise<void> {
    if (message) {
      await this.run(['tag', '-a', name, '-m', message, hash], { timeoutMs: 30_000 });
    } else {
      await this.run(['tag', name, hash], { timeoutMs: 30_000 });
    }
  }

  async fetchAll(): Promise<void> {
    await this.run(['fetch', '--all', '--prune'], { timeoutMs: 0 });
  }

  async pull(): Promise<void> {
    await this.run(['pull', '--no-edit'], { timeoutMs: 0 });
  }

  async push(branch?: string, remote?: string, setUpstream?: boolean): Promise<void> {
    const args = ['push'];
    if (setUpstream && remote && branch) {
      args.push('--set-upstream', remote, branch);
    } else if (remote && branch) {
      args.push(remote, branch);
    }
    await this.run(args, { timeoutMs: 0 });
  }

  async abortOperation(kind: 'merge' | 'rebase' | 'cherry-pick' | 'revert'): Promise<void> {
    await this.run([kind, '--abort'], { timeoutMs: 60_000 });
  }
}
