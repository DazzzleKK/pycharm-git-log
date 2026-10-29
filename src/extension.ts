import * as vscode from 'vscode';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { getHtml } from './html';
import {
  BranchInfo,
  CommitInfo,
  GitError,
  GitRepo,
  RefBadge,
  TagInfo,
  execGit,
} from './git';

const VIEW_TYPE = 'pycharmGit.log';
const SCHEME = 'pycharm-git';
const STATE_KEY = 'pycharmGit.state';

type RefKey = string; // 'ALL' | branch name | 'RANGE:from..to'

interface RepoSummary {
  root: string;
  name: string;
  current: string | null;
}

interface WebviewState {
  repos: RepoSummary[];
  repo: string;
  ref: string;
  label: string;
  refKind: 'all' | 'branch' | 'range';
  branches: BranchInfo[];
  commits: CommitInfo[];
  limit: number;
  hasMore: boolean;
  current: string | null;
  detached: boolean;
  headSha: string | null;
  ahead: number;
  behind: number;
  empty: boolean;
  showGraph: boolean;
  dateStyle: 'absolute' | 'relative';
}

interface SavedState {
  repo?: string;
  refs: Record<string, string>;
}

function config() {
  const cfg = vscode.workspace.getConfiguration('pycharmGit');
  return {
    maxCommits: Math.max(50, cfg.get<number>('maxCommits', 500)),
    dateStyle: cfg.get<'absolute' | 'relative'>('dateStyle', 'absolute'),
    confirmDestructive: cfg.get<boolean>('confirmDestructive', true),
    autoRefreshOnFocus: cfg.get<boolean>('autoRefreshOnFocus', true),
    showGraph: cfg.get<boolean>('showGraph', true),
    remoteName: cfg.get<string>('remoteName', '').trim(),
  };
}

async function discoverRepos(): Promise<string[]> {
  const roots = new Set<string>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const result = await tryRepoRoot(folder.uri.fsPath);
    if (result) {
      roots.add(result);
    }
  }
  if (!roots.size) {
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active?.scheme === 'file') {
      const result = await tryRepoRoot(path.dirname(active.fsPath));
      if (result) {
        roots.add(result);
      }
    }
  }
  return [...roots];
}

async function tryRepoRoot(start: string): Promise<string | null> {
  try {
    const out = await execGit(start, ['rev-parse', '--show-toplevel'], { timeoutMs: 15_000 });
    const root = out.trim();
    return root || null;
  } catch {
    return null;
  }
}

function revisionUri(root: string, rev: string, filePath: string): vscode.Uri {
  const abs = path.join(root, filePath);
  return vscode.Uri.file(abs).with({
    scheme: SCHEME,
    query: JSON.stringify({ root, rev, path: filePath.split(path.sep).join('/') }),
  });
}

function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

function errorText(error: unknown): string {
  if (error instanceof GitError || error instanceof Error) {
    return error.message;
  }
  return String(error);
}

class GitContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    let query: { root?: string; rev?: string; path?: string };
    try {
      query = JSON.parse(uri.query) as { root?: string; rev?: string; path?: string };
    } catch {
      return '';
    }
    if (!query.root || !query.rev || !query.path || query.rev === 'EMPTY') {
      return '';
    }
    try {
      const buffer = await new GitRepo(query.root).fileContent(query.rev, query.path);
      const sample = buffer.subarray(0, 8000);
      if (sample.includes(0)) {
        return `Binary file: ${query.path}\n`;
      }
      return buffer.toString('utf8');
    } catch (error) {
      return `Unable to load ${query.path} at ${query.rev}\n\n${errorText(error)}\n`;
    }
  }
}

function buildRefMap(branches: BranchInfo[], tags: TagInfo[], headSha: string | null): Map<string, RefBadge[]> {
  const map = new Map<string, RefBadge[]>();
  const add = (sha: string, badge: RefBadge) => {
    const list = map.get(sha) ?? [];
    if (!list.some((item) => item.kind === badge.kind && item.name === badge.name)) {
      list.push(badge);
      map.set(sha, list);
    }
  };

  const current = branches.find((branch) => branch.current);
  if (current) {
    add(current.sha, { kind: 'local', name: current.name, current: true });
  }
  for (const branch of branches) {
    if (!branch.current) {
      add(branch.sha, {
        kind: branch.isRemote ? 'remote' : 'local',
        name: branch.name,
      });
    }
  }
  if (headSha) {
    add(headSha, { kind: 'head', name: 'HEAD' });
  }
  for (const tag of tags) {
    add(tag.sha, { kind: 'tag', name: tag.name });
  }
  const order: Record<RefBadge['kind'], number> = { head: 0, local: 1, remote: 2, tag: 3 };
  for (const list of map.values()) {
    list.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
  }
  return map;
}

class GitLogController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly output: vscode.OutputChannel;

  private repos: string[] = [];
  private repoRoot: string | undefined;
  private refKey: RefKey | undefined;
  private limit = 500;
  private branches: BranchInfo[] = [];
  private commits: CommitInfo[] = [];
  private headSha: string | null = null;
  private detached = false;
  private currentBranch: string | null = null;
  private lastState: WebviewState | undefined;

  private busyCount = 0;
  private refreshSeq = 0;
  private refreshing = 0;
  private initialized = false;
  private refreshTimer: NodeJS.Timeout | undefined;
  private watchers: vscode.FileSystemWatcher[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel('PyCharm Git');
    this.disposables.push(this.output);

    this.disposables.push(
      vscode.window.onDidChangeWindowState((event) => {
        if (!event.focused) {
          return;
        }
        if (this.panel?.visible && config().autoRefreshOnFocus) {
          this.scheduleRefresh(120);
        }
      })
    );
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.repos = [];
        this.repoRoot = undefined;
        this.initialized = false;
        if (this.panel) {
          void this.refresh();
        }
      })
    );
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('pycharmGit')) {
          return;
        }
        this.limit = Math.max(config().maxCommits, this.limit);
        if (this.panel) {
          void this.refresh();
        }
      })
    );
  }

  dispose(): void {
    this.disposeWatchers();
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.panel?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  async open(repoRoot?: string): Promise<void> {
    if (this.panel) {
      if (repoRoot && this.repos.includes(repoRoot) && repoRoot !== this.repoRoot) {
        this.repoRoot = repoRoot;
        this.refKey = this.savedRef(repoRoot);
        this.limit = config().maxCommits;
        await this.refresh();
      }
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'Git',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
      }
    );
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.png');
    panel.webview.html = getHtml(panel.webview, this.context.extensionUri);
    this.panel = panel;

    panel.onDidDispose(
      () => {
        this.panel = undefined;
        this.initialized = false;
        this.lastState = undefined;
        this.disposeWatchers();
      },
      null,
      this.disposables
    );

    panel.onDidChangeViewState(
      () => {
        if (panel.visible) {
          this.setupWatchers();
          this.scheduleRefresh(80);
        }
      },
      null,
      this.disposables
    );

    this.disposables.push(panel.webview.onDidReceiveMessage((message) => {
      void this.onMessage(message);
    }));

    await this.initialize(repoRoot);
    this.setupWatchers();
  }

  private async initialize(repoRoot?: string): Promise<void> {
    this.repos = await discoverRepos();
    if (!this.repos.length) {
      this.post({
        type: 'emptystate',
        text: 'No Git repository found in this workspace. Open a folder that is inside a Git repository.',
      });
      this.initialized = true;
      return;
    }
    const saved = this.loadSaved();
    const preferred = repoRoot ?? this.repoRoot ?? saved.repo;
    this.repoRoot = preferred && this.repos.includes(preferred) ? preferred : this.repos[0];
    this.refKey = this.savedRef(this.repoRoot) ?? this.refKey;
    this.limit = config().maxCommits;
    this.initialized = true;
    await this.refresh();
  }

  private loadSaved(): SavedState {
    return this.context.workspaceState.get<SavedState>(STATE_KEY, { refs: {} });
  }

  private savedRef(root: string): string | undefined {
    const saved = this.loadSaved();
    return saved.refs[root];
  }

  private async persistSelection(): Promise<void> {
    const saved = this.loadSaved();
    const next: SavedState = { repo: this.repoRoot, refs: { ...saved.refs } };
    if (this.repoRoot && this.refKey) {
      next.refs[this.repoRoot] = this.refKey;
    }
    await this.context.workspaceState.update(STATE_KEY, next);
  }

  private async onMessage(message: { type?: string; [key: string]: unknown }): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          // The webview may finish loading after the extension already posted
          // the first state; re-send it so the UI never stays on "Loading".
          if (this.lastState) {
            this.post({ type: 'state', state: this.lastState });
            this.post({ type: 'refreshing', value: false });
          } else if (!this.initialized) {
            await this.initialize();
            this.setupWatchers();
          } else {
            await this.refresh();
          }
          break;
        case 'refresh':
          await this.refresh();
          break;
        case 'selectRepo': {
          const root = String(message.repo ?? '');
          if (!this.repos.includes(root) || root === this.repoRoot) {
            break;
          }
          this.repoRoot = root;
          this.refKey = this.savedRef(root);
          this.limit = config().maxCommits;
          await this.persistSelection();
          await this.refresh();
          break;
        }
        case 'selectRef': {
          const ref = String(message.ref ?? '');
          if (!ref) {
            break;
          }
          this.refKey = ref;
          this.limit = config().maxCommits;
          await this.persistSelection();
          await this.refresh();
          break;
        }
        case 'loadMore':
          this.limit += Math.max(100, config().maxCommits);
          await this.refresh();
          break;
        case 'details':
          await this.sendDetails(String(message.hash ?? ''));
          break;
        case 'diff':
          await this.openDiff(message);
          break;
        case 'action':
          await this.handleAction(message);
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(String(message.text ?? ''));
          break;
        case 'settings':
          await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:keril.pycharm-git-log');
          break;
        case 'close':
          this.panel?.dispose();
          break;
        default:
          break;
      }
    } catch (error) {
      this.report(error);
    }
  }

  private post(message: unknown): void {
    void this.panel?.webview.postMessage(message);
  }

  private async refresh(): Promise<void> {
    if (!this.panel) {
      return;
    }
    const seq = ++this.refreshSeq;
    this.refreshing++;
    this.post({ type: 'refreshing', value: true });
    try {
      if (!this.repos.length) {
        this.repos = await discoverRepos();
      }
      if (!this.repos.length) {
        this.post({
          type: 'emptystate',
          text: 'No Git repository found in this workspace.',
        });
        return;
      }
      if (!this.repoRoot || !this.repos.includes(this.repoRoot)) {
        this.repoRoot = this.repos[0];
      }
      const repo = new GitRepo(this.repoRoot);
      const refs = await repo.branches();
      const tags = await repo.tags();
      if (seq !== this.refreshSeq) {
        return;
      }

      this.branches = refs.branches;
      this.headSha = refs.headSha;
      this.detached = refs.detached;
      this.currentBranch = refs.current;

      const resolved = this.resolveRef();
      this.refKey = resolved.key;
      let commits: CommitInfo[] = [];
      let hasMore = false;
      if (!refs.headSha) {
        commits = [];
      } else {
        try {
          const raw = await repo.log(resolved.rev, this.limit + 1);
          hasMore = raw.length > this.limit;
          commits = hasMore ? raw.slice(0, this.limit) : raw;
        } catch (error) {
          if (resolved.kind === 'range') {
            this.refKey = this.currentBranch ?? 'ALL';
            const fallback = this.resolveRef();
            this.refKey = fallback.key;
            const raw = await repo.log(fallback.rev, this.limit + 1);
            hasMore = raw.length > this.limit;
            commits = hasMore ? raw.slice(0, this.limit) : raw;
            resolved.label = fallback.label;
            resolved.kind = fallback.kind;
          } else {
            throw error;
          }
        }
      }

      const refMap = buildRefMap(this.branches, tags, refs.headSha);
      for (const commit of commits) {
        commit.refs = refMap.get(commit.hash) ?? [];
      }
      if (seq !== this.refreshSeq) {
        return;
      }
      this.commits = commits;

      const summaries = await Promise.all(this.repos.map((root) => this.summarizeRepo(root)));
      if (seq !== this.refreshSeq) {
        return;
      }
      const currentInfo = this.branches.find((branch) => branch.current);
      const state: WebviewState = {
        repos: summaries,
        repo: this.repoRoot,
        ref: this.refKey ?? 'ALL',
        label: resolved.label,
        refKind: resolved.kind,
        branches: this.branches,
        commits,
        limit: this.limit,
        hasMore,
        current: this.currentBranch,
        detached: this.detached,
        headSha: this.headSha,
        ahead: currentInfo?.ahead ?? 0,
        behind: currentInfo?.behind ?? 0,
        empty: !refs.headSha,
        showGraph: config().showGraph,
        dateStyle: config().dateStyle,
      };
      this.lastState = state;
      this.post({ type: 'state', state });
      this.panel.title = `Git — ${path.basename(this.repoRoot)}`;
    } catch (error) {
      if (seq === this.refreshSeq) {
        this.report(error);
      }
    } finally {
      this.refreshing--;
      if (this.refreshing === 0 && seq === this.refreshSeq) {
        this.post({ type: 'refreshing', value: false });
      }
    }
  }

  private resolveRef(): { rev: string | null; label: string; kind: 'all' | 'branch' | 'range'; key: string } {
    const current = this.currentBranch ?? this.branches.find((branch) => branch.current)?.name ?? null;
    let key = this.refKey;

    if (!key) {
      key = current ?? (this.detached ? 'HEAD' : 'ALL');
    }
    if (key === 'ALL') {
      return { rev: null, label: 'All branches', kind: 'all', key: 'ALL' };
    }
    if (key.startsWith('RANGE:')) {
      const [from, to] = key.slice('RANGE:'.length).split('..');
      if (from && to) {
        return { rev: `${from}..${to}`, label: `${to} ↔ ${from}`, kind: 'range', key };
      }
    }
    const branch = this.branches.find((item) => item.name === key);
    if (branch) {
      return { rev: branch.name, label: branch.name, kind: 'branch', key: branch.name };
    }
    if (current) {
      return { rev: current, label: current, kind: 'branch', key: current };
    }
    if (this.detached || this.headSha) {
      return { rev: 'HEAD', label: 'HEAD (detached)', kind: 'branch', key: 'HEAD' };
    }
    return { rev: null, label: 'All branches', kind: 'all', key: 'ALL' };
  }

  private async summarizeRepo(root: string): Promise<RepoSummary> {
    try {
      const head = await new GitRepo(root).head();
      return { root, name: path.basename(root), current: head.current };
    } catch {
      return { root, name: path.basename(root), current: null };
    }
  }

  private repo(): GitRepo {
    if (!this.repoRoot) {
      throw new Error('No repository selected');
    }
    return new GitRepo(this.repoRoot);
  }

  private async sendDetails(hash: string): Promise<void> {
    const commit = this.commits.find((item) => item.hash === hash);
    if (!commit) {
      return;
    }
    try {
      const details = await this.repo().details(hash, commit.parents);
      this.post({
        type: 'details',
        hash,
        body: details.body,
        files: details.files,
        parents: commit.parents,
        subject: commit.subject,
        author: commit.author,
        email: commit.email,
        authorTime: commit.authorTime,
        refs: commit.refs,
      });
    } catch (error) {
      this.post({ type: 'notice', kind: 'error', text: errorText(error) });
    }
  }

  private async openDiff(message: Record<string, unknown>): Promise<void> {
    if (!this.repoRoot) {
      return;
    }
    const hash = String(message.hash ?? '');
    const parent = message.parent ? String(message.parent) : null;
    const filePath = String(message.path ?? '');
    const oldPath = message.oldPath ? String(message.oldPath) : undefined;
    const status = String(message.status ?? 'M');
    const workingTree = Boolean(message.workingTree);
    if (!hash || !filePath) {
      return;
    }

    let left: vscode.Uri;
    let right: vscode.Uri;

    if (workingTree) {
      const abs = path.join(this.repoRoot, filePath);
      if (!existsSync(abs)) {
        void vscode.window.showWarningMessage(`File no longer exists in the working tree: ${filePath}`);
        return;
      }
      left = revisionUri(this.repoRoot, hash, filePath);
      right = vscode.Uri.file(abs);
    } else {
      const basePath = oldPath ?? filePath;
      left = revisionUri(this.repoRoot, parent ?? 'EMPTY', parent ? basePath : 'EMPTY');
      right = status === 'D'
        ? revisionUri(this.repoRoot, 'EMPTY', filePath)
        : revisionUri(this.repoRoot, hash, filePath);
      if (status === 'A' || !parent) {
        left = revisionUri(this.repoRoot, 'EMPTY', filePath);
      }
    }

    const title = `${path.basename(filePath)} (${shortHash(hash)})${workingTree ? ' ↔ Working Tree' : ''}`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  }

  private async promptBranchName(title: string, value = ''): Promise<string | undefined> {
    if (!this.repoRoot) {
      return undefined;
    }
    const root = this.repoRoot;
    const result = await vscode.window.showInputBox({
      title,
      prompt: 'Branch name',
      value,
      ignoreFocusOut: true,
      validateInput: async (input) => {
        const name = input.trim();
        if (!name) {
          return 'Branch name is required';
        }
        try {
          await execGit(root, ['check-ref-format', '--branch', name], { timeoutMs: 5000 });
          return undefined;
        } catch {
          return 'Invalid branch name';
        }
      },
    });
    return result?.trim() || undefined;
  }

  private async promptTagName(title: string): Promise<string | undefined> {
    if (!this.repoRoot) {
      return undefined;
    }
    const root = this.repoRoot;
    const result = await vscode.window.showInputBox({
      title,
      prompt: 'Tag name',
      ignoreFocusOut: true,
      validateInput: async (input) => {
        const name = input.trim();
        if (!name) {
          return 'Tag name is required';
        }
        try {
          await execGit(root, ['check-ref-format', '--allow-onelevel', name], { timeoutMs: 5000 });
          return undefined;
        } catch {
          return 'Invalid tag name';
        }
      },
    });
    return result?.trim() || undefined;
  }

  private async confirm(message: string, okLabel: string, detail?: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      message,
      { modal: true, detail },
      okLabel
    );
    return choice === okLabel;
  }

  private async run(label: string, action: () => Promise<string | void>): Promise<boolean> {
    this.busyCount++;
    this.output.appendLine(`[${new Date().toISOString()}] ${label}`);
    this.post({ type: 'busy', value: true, label });
    try {
      const message = await action();
      await this.refresh();
      if (message) {
        this.post({ type: 'notice', kind: 'success', text: message });
      }
      return true;
    } catch (error) {
      this.report(error);
      return false;
    } finally {
      this.busyCount--;
      if (this.busyCount === 0) {
        this.post({ type: 'busy', value: false });
      }
    }
  }

  private report(error: unknown): void {
    const message = errorText(error);
    this.output.appendLine(message);
    if (error instanceof GitError && error.stderr) {
      this.output.appendLine(error.stderr);
    }
    let hint = '';
    if (/CONFLICT|could not apply|Automatic merge failed/i.test(message)) {
      hint = '\nResolve conflicts in the Source Control view, then continue the operation in the terminal.';
    } else if (/overwritten by checkout|local changes/i.test(message)) {
      hint = '\nCommit or stash your changes before switching branches.';
    }
    this.post({ type: 'notice', kind: 'error', text: message.split('\n')[0] + hint });
    void vscode.window.showErrorMessage(`Git: ${message.split('\n')[0]}`, 'Show Output').then((choice) => {
      if (choice) {
        this.output.show();
      }
    });
  }

  private async handleAction(message: Record<string, unknown>): Promise<void> {
    if (!this.repoRoot) {
      return;
    }
    const repo = this.repo();
    const action = String(message.action ?? '');
    const ref = message.ref ? String(message.ref) : undefined;
    const hash = message.hash ? String(message.hash) : undefined;

    switch (action) {
      case 'checkoutBranch': {
        if (!ref) {
          break;
        }
        const isRemote = Boolean(message.remote);
        await this.run(`Checking out ${ref}`, async () => {
          const checkedOut = await repo.checkoutBranch(ref, isRemote);
          this.refKey = checkedOut.branch;
          await this.persistSelection();
          return checkedOut.created
            ? `Checked out ${checkedOut.branch} (tracking ${ref})`
            : `Checked out ${checkedOut.branch}`;
        });
        break;
      }

      case 'checkoutAndRebase': {
        if (!ref) {
          break;
        }
        const onto = this.currentBranch;
        if (!onto || onto === ref) {
          break;
        }
        await this.run(`Checking out ${ref} and rebasing onto ${onto}`, async () => {
          const checkedOut = await repo.checkoutBranch(ref, false);
          this.refKey = checkedOut.branch;
          await this.persistSelection();
          await repo.rebase(onto);
          return `Checked out ${checkedOut.branch} and rebased onto ${onto}`;
        });
        break;
      }

      case 'checkoutRevision': {
        if (!hash) {
          break;
        }
        const done = await this.run(`Checking out ${shortHash(hash)}`, async () => {
          await repo.checkoutDetached(hash);
          return `Checked out ${shortHash(hash)} (detached HEAD)`;
        });
        if (done) {
          void vscode.window
            .showWarningMessage(`HEAD is now detached at ${shortHash(hash)}.`, 'Create Branch...')
            .then((choice) => {
              if (choice) {
                void this.handleAction({ action: 'newBranch', ref: hash });
              }
            });
        }
        break;
      }

      case 'newBranch': {
        const from = ref ?? null;
        const fromLabel = from
          ? /^[0-9a-f]{40}$/i.test(from)
            ? shortHash(from)
            : from
          : 'HEAD';
        const title = `New branch from ${fromLabel}`;
        const name = await this.promptBranchName(title);
        if (!name) {
          break;
        }
        await this.run(`Creating branch ${name}`, async () => {
          await repo.createBranch(name, from);
          this.refKey = name;
          await this.persistSelection();
          return `Created and checked out ${name}`;
        });
        break;
      }

      case 'merge': {
        if (!ref) {
          break;
        }
        const current = this.currentBranch ?? 'HEAD';
        await this.run(`Merging ${ref} into ${current}`, async () => {
          await repo.merge(ref);
          return `Merged ${ref} into ${current}`;
        });
        break;
      }

      case 'mergeCommit': {
        if (!hash) {
          break;
        }
        await this.run(`Merging ${shortHash(hash)}`, async () => {
          await repo.merge(hash);
          return `Merged commit ${shortHash(hash)}`;
        });
        break;
      }

      case 'rebase': {
        if (!ref) {
          break;
        }
        const current = this.currentBranch ?? 'HEAD';
        await this.run(`Rebasing ${current} onto ${ref}`, async () => {
          await repo.rebase(ref);
          return `Rebased ${current} onto ${ref}`;
        });
        break;
      }

      case 'rebaseOntoCommit': {
        if (!hash) {
          break;
        }
        await this.run(`Rebasing onto ${shortHash(hash)}`, async () => {
          await repo.rebase(hash);
          return `Rebased onto ${shortHash(hash)}`;
        });
        break;
      }

      case 'cherryPick': {
        if (!hash) {
          break;
        }
        await this.run(`Cherry-picking ${shortHash(hash)}`, async () => {
          await repo.cherryPick(hash);
          return `Cherry-picked ${shortHash(hash)}`;
        });
        break;
      }

      case 'revert': {
        if (!hash) {
          break;
        }
        await this.run(`Reverting ${shortHash(hash)}`, async () => {
          await repo.revert(hash);
          return `Reverted ${shortHash(hash)}`;
        });
        break;
      }

      case 'reset': {
        if (!hash) {
          break;
        }
        const mode = await vscode.window.showQuickPick(
          [
            { label: 'Soft', description: 'Move HEAD, keep changes staged', value: 'soft' as const },
            { label: 'Mixed', description: 'Move HEAD, keep changes unstaged', value: 'mixed' as const },
            { label: 'Hard', description: 'Discard all working tree changes', value: 'hard' as const },
          ],
          { title: `Reset ${this.currentBranch ?? 'HEAD'} to ${shortHash(hash)}`, placeHolder: 'Reset mode' }
        );
        if (!mode) {
          break;
        }
        if (mode.value === 'hard' && config().confirmDestructive) {
          const ok = await this.confirm(
            `Hard reset ${this.currentBranch ?? 'HEAD'} to ${shortHash(hash)}?`,
            'Reset --hard',
            'All uncommitted changes will be lost.'
          );
          if (!ok) {
            break;
          }
        }
        await this.run(`Resetting to ${shortHash(hash)} (${mode.value})`, async () => {
          await repo.reset(hash, mode.value);
          return `Reset ${this.currentBranch ?? 'HEAD'} to ${shortHash(hash)} (${mode.value})`;
        });
        break;
      }

      case 'createTag': {
        if (!hash) {
          break;
        }
        const name = await this.promptTagName(`Tag ${shortHash(hash)}`);
        if (!name) {
          break;
        }
        await this.run(`Creating tag ${name}`, async () => {
          await repo.createTag(name, hash);
          return `Created tag ${name} at ${shortHash(hash)}`;
        });
        break;
      }

      case 'createTagFromBranch': {
        if (!ref) {
          break;
        }
        const branch = this.branches.find((item) => item.name === ref);
        if (!branch) {
          break;
        }
        const name = await this.promptTagName(`Tag ${ref}`);
        if (!name) {
          break;
        }
        await this.run(`Creating tag ${name}`, async () => {
          await repo.createTag(name, branch.sha);
          return `Created tag ${name} at ${ref}`;
        });
        break;
      }

      case 'deleteBranch': {
        if (!ref) {
          break;
        }
        if (config().confirmDestructive) {
          const ok = await this.confirm(`Delete branch '${ref}'?`, 'Delete');
          if (!ok) {
            break;
          }
        }
        await this.run(`Deleting branch ${ref}`, async () => {
          try {
            await repo.deleteBranch(ref, false);
          } catch (error) {
            if (!/not fully merged/i.test(errorText(error))) {
              throw error;
            }
            const force = await this.confirm(
              `Branch '${ref}' is not fully merged. Delete it anyway?`,
              'Force Delete',
              'Commits that are not merged into another branch will be lost.'
            );
            if (!force) {
              return;
            }
            await repo.deleteBranch(ref, true);
          }
          if (this.refKey === ref) {
            this.refKey = this.currentBranch ?? 'ALL';
            await this.persistSelection();
          }
          return `Deleted branch ${ref}`;
        });
        break;
      }

      case 'renameBranch': {
        if (!ref) {
          break;
        }
        const newName = await this.promptBranchName('Rename branch', ref);
        if (!newName || newName === ref) {
          break;
        }
        await this.run(`Renaming ${ref} to ${newName}`, async () => {
          await repo.renameBranch(ref, newName);
          if (this.refKey === ref) {
            this.refKey = newName;
            await this.persistSelection();
          }
          return `Renamed ${ref} to ${newName}`;
        });
        break;
      }

      case 'compare': {
        if (!ref) {
          break;
        }
        const current = this.currentBranch;
        if (!current) {
          void vscode.window.showWarningMessage('Checkout a branch to compare against.');
          break;
        }
        this.refKey = `RANGE:${current}..${ref}`;
        this.limit = config().maxCommits;
        await this.persistSelection();
        await this.refresh();
        break;
      }

      case 'fetch': {
        await this.run('Fetching all remotes', async () => {
          await repo.fetchAll();
          return 'Fetched all remotes';
        });
        break;
      }

      case 'pull': {
        const current = this.currentBranch;
        if (!current) {
          void vscode.window.showWarningMessage('Detached HEAD: checkout a branch before pulling.');
          break;
        }
        await this.run(`Pulling ${current}`, async () => {
          await repo.pull();
          return `Pulled ${current}`;
        });
        break;
      }

      case 'push': {
        await this.pushRef(repo, ref);
        break;
      }

      case 'newBranchFromCommit': {
        if (!hash) {
          break;
        }
        await this.handleAction({ action: 'newBranch', ref: hash });
        break;
      }

      default:
        break;
    }
  }

  private async pushRef(repo: GitRepo, requested?: string): Promise<void> {
    const current = this.currentBranch;
    const branch = requested ?? current;
    if (!branch) {
      void vscode.window.showWarningMessage('Detached HEAD: checkout a branch before pushing.');
      return;
    }
    const info = this.branches.find((item) => item.name === branch && !item.isRemote);
    const remotes = await repo.remotes();
    const configured = config().remoteName;
    const remote = info?.upstream?.split('/')[0]
      || (configured && remotes.includes(configured) ? configured : undefined)
      || (remotes.includes('origin') ? 'origin' : remotes[0]);
    if (!remote) {
      void vscode.window.showWarningMessage('No git remote configured.');
      return;
    }

    await this.run(`Pushing ${branch}`, async () => {
      if (branch !== current) {
        await repo.push(branch, remote, !info?.upstream);
        return `Pushed ${branch} to ${remote}`;
      }
      try {
        await repo.push();
      } catch (error) {
        if (!/no upstream branch|set-upstream|has no upstream/i.test(errorText(error))) {
          throw error;
        }
        await repo.push(branch, remote, true);
      }
      return `Pushed ${branch}`;
    });
  }

  public async runCommand(command: 'fetch' | 'pull' | 'push' | 'refresh'): Promise<void> {
    if (!this.panel) {
      await this.open();
    }
    if (command === 'refresh') {
      await this.refresh();
      return;
    }
    await this.handleAction({ action: command });
  }

  public showOutput(): void {
    this.output.show();
  }

  public async newBranchFromCommand(): Promise<void> {
    if (!this.panel) {
      await this.open();
    }
    await this.handleAction({ action: 'newBranch' });
  }

  public async checkoutBranchCommand(): Promise<void> {
    if (!this.panel) {
      await this.open();
    }
    if (!this.repoRoot) {
      return;
    }
    const repo = this.repo();
    const refs = await repo.branches();
    const items = refs.branches.map((branch) => ({
      label: `${branch.isRemote ? '$(cloud) ' : '$(git-branch) '}${branch.name}`,
      description: branch.current ? 'current' : branch.isRemote ? 'remote' : 'local',
      branch,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Checkout Branch',
      placeHolder: 'Select a local or remote branch',
      matchOnDescription: true,
    });
    if (!picked) {
      return;
    }
    await this.handleAction({
      action: 'checkoutBranch',
      ref: picked.branch.name,
      remote: picked.branch.isRemote,
    });
  }

  private setupWatchers(): void {
    this.disposeWatchers();
    if (!this.repoRoot) {
      return;
    }
    const rootUri = vscode.Uri.file(this.repoRoot);
    for (const pattern of ['.git/HEAD', '.git/refs/**', '.git/packed-refs', '.git/index']) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(rootUri, pattern));
      const schedule = () => this.scheduleRefresh(400);
      watcher.onDidChange(schedule);
      watcher.onDidCreate(schedule);
      watcher.onDidDelete(schedule);
      this.watchers.push(watcher);
    }
  }

  private disposeWatchers(): void {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers = [];
  }

  private scheduleRefresh(delay = 300): void {
    if (!this.panel || !this.panel.visible || !this.initialized) {
      return;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.busyCount === 0) {
        void this.refresh();
      }
    }, delay);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = new GitLogController(context);
  context.subscriptions.push(controller);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new GitContentProvider())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('pycharmGit.openLog', (repoRoot?: string) => controller.open(repoRoot)),
    vscode.commands.registerCommand('pycharmGit.refresh', () => controller.runCommand('refresh')),
    vscode.commands.registerCommand('pycharmGit.fetch', () => controller.runCommand('fetch')),
    vscode.commands.registerCommand('pycharmGit.pull', () => controller.runCommand('pull')),
    vscode.commands.registerCommand('pycharmGit.push', () => controller.runCommand('push')),
    vscode.commands.registerCommand('pycharmGit.newBranch', () => controller.newBranchFromCommand()),
    vscode.commands.registerCommand('pycharmGit.checkoutBranch', () => controller.checkoutBranchCommand()),
    vscode.commands.registerCommand('pycharmGit.showOutput', () => controller.showOutput())
  );
}

export function deactivate(): void {
  // handled by disposables
}
