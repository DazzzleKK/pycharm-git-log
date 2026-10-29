/* Integration test: runs the real extension bundle against a fake `vscode` API
 * and a real temporary git repository. */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pcgit-int-'));
const repoDir = path.join(fixtureRoot, 'repo');
fs.mkdirSync(repoDir);

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test User',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test User',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(args) {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', env: gitEnv });
}

function commitFile(name, text, message) {
  fs.writeFileSync(path.join(repoDir, name), text);
  git(['add', '.']);
  git(['commit', '-m', message]);
}

git(['init', '-b', 'main']);
git(['config', 'user.name', 'Test User']);
git(['config', 'user.email', 'test@example.com']);
commitFile('a.txt', 'a1\n', 'initial commit');
commitFile('b.txt', 'b1\n', 'second commit');
git(['checkout', '-b', 'feature/login']);
commitFile('c.txt', 'c1\n', 'feature: login screen');
git(['checkout', 'main']);
git(['checkout', '-b', 'side']);
commitFile('d.txt', 'd1\n', 'side: d file');
git(['checkout', 'main']);
commitFile('e.txt', 'e1\n', 'main: e file');

/* ------------------------------------------------------------------ vscode */

const messages = [];
const executed = [];
const notices = [];
const commands = new Map();
const providers = new Map();
const panels = [];
const stateStore = new Map();
let inputQueue = [];
let quickPickQueue = [];

class Event {
  constructor() {
    this.listeners = [];
  }
  event = (listener) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(value) {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
  dispose() {}
}

class Uri {
  constructor(scheme, fsPath, query) {
    this.scheme = scheme;
    this.path = fsPath;
    this.fsPath = fsPath;
    this.query = query || '';
    this.authority = '';
    this.fragment = '';
  }
  static file(fsPath) {
    return new Uri('file', fsPath, '');
  }
  static joinPath(base, ...parts) {
    return new Uri(base.scheme, path.join(base.path, ...parts), '');
  }
  static parse(value) {
    return new Uri('file', value, '');
  }
  with(change) {
    return new Uri(
      change.scheme !== undefined ? change.scheme : this.scheme,
      change.path !== undefined ? change.path : this.path,
      change.query !== undefined ? change.query : this.query
    );
  }
  toString() {
    return this.scheme + ':' + this.path + (this.query ? '?' + this.query : '');
  }
}

function disposable() {
  return { dispose() {} };
}

class FakePanel {
  constructor(viewType, title) {
    this.viewType = viewType;
    this.title = title;
    this.visible = true;
    this.iconPath = undefined;
    this.disposed = false;
    this.messageListeners = [];
    this.disposeListeners = [];
    this.webview = {
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (uri) => ({ toString: () => 'https://webview.local' + uri.path }),
      onDidReceiveMessage: (listener) => {
        this.messageListeners.push(listener);
        return disposable();
      },
      postMessage: async (message) => {
        messages.push(message);
        return true;
      },
    };
  }
  reveal() {}
  dispose() {
    this.disposed = true;
    for (const listener of this.disposeListeners) {
      listener();
    }
  }
  onDidDispose(listener) {
    this.disposeListeners.push(listener);
    return disposable();
  }
  onDidChangeViewState() {
    return disposable();
  }
  send(message) {
    for (const listener of this.messageListeners) {
      listener(message);
    }
  }
}

const vscode = {
  Uri,
  EventEmitter: class {
    constructor() {
      this.event = () => disposable();
    }
  },
  Disposable: { from: () => disposable() },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, One: 1 },
  RelativePattern: class {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  },
  MarkdownString: class {
    constructor(value) {
      this.value = value;
    }
  },
  window: {
    activeTextEditor: undefined,
    createStatusBarItem() {
      return {
        id: 'status',
        text: '',
        tooltip: undefined,
        command: undefined,
        name: '',
        show() {},
        hide() {},
        dispose() {},
      };
    },
    createOutputChannel(name) {
      return {
        name,
        lines: [],
        appendLine(line) {
          this.lines.push(line);
        },
        append(line) {
          this.lines.push(line);
        },
        show() {},
        dispose() {},
      };
    },
    createWebviewPanel(viewType, title) {
      const panel = new FakePanel(viewType, title);
      panels.push(panel);
      return panel;
    },
    showErrorMessage(message) {
      notices.push({ level: 'error', message });
      return Promise.resolve(undefined);
    },
    showWarningMessage(message) {
      notices.push({ level: 'warning', message });
      return Promise.resolve(undefined);
    },
    showInformationMessage(message) {
      notices.push({ level: 'info', message });
      return Promise.resolve(undefined);
    },
    showInputBox() {
      return Promise.resolve(inputQueue.shift());
    },
    showQuickPick() {
      return Promise.resolve(quickPickQueue.shift());
    },
    setStatusBarMessage() {},
    onDidChangeWindowState() {
      return disposable();
    },
  },
  workspace: {
    workspaceFolders: [{ uri: Uri.file(repoDir), name: 'repo', index: 0 }],
    getConfiguration() {
      const values = {
        maxCommits: 100,
        dateStyle: 'absolute',
        confirmDestructive: true,
        autoRefreshOnFocus: false,
        showGraph: true,
        remoteName: '',
      };
      return {
        get(key, fallback) {
          return values[key] !== undefined ? values[key] : fallback;
        },
        update() {
          return Promise.resolve();
        },
      };
    },
    onDidChangeConfiguration() {
      return disposable();
    },
    onDidChangeWorkspaceFolders() {
      return disposable();
    },
    createFileSystemWatcher() {
      return {
        onDidChange: () => disposable(),
        onDidCreate: () => disposable(),
        onDidDelete: () => disposable(),
        dispose() {},
      };
    },
    registerTextDocumentContentProvider(scheme, provider) {
      providers.set(scheme, provider);
      return disposable();
    },
  },
  commands: {
    registerCommand(id, handler) {
      commands.set(id, handler);
      return disposable();
    },
    executeCommand(id, ...args) {
      executed.push({ id, args });
      return Promise.resolve();
    },
  },
  env: {
    clipboard: {
      writeText(value) {
        executed.push({ id: 'clipboard', args: [value] });
        return Promise.resolve();
      },
    },
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return vscode;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const context = {
  subscriptions: [],
  extensionUri: Uri.file(path.resolve(__dirname, '..')),
  extensionPath: path.resolve(__dirname, '..'),
  workspaceState: {
    get(key, fallback) {
      return stateStore.has(key) ? stateStore.get(key) : fallback;
    },
    update(key, value) {
      stateStore.set(key, value);
      return Promise.resolve();
    },
  },
  globalState: {
    get(key, fallback) {
      return fallback;
    },
    update() {
      return Promise.resolve();
    },
  },
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, label, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) {
      return value;
    }
    await delay(20);
  }
  throw new Error('Timed out waiting for ' + label);
}

function lastState() {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === 'state') {
      return messages[i].state;
    }
  }
  return null;
}

function send(panel, message) {
  panel.send(message);
}

async function waitState(predicate, label) {
  return waitFor(() => {
    const state = lastState();
    return state && predicate(state) ? state : null;
  }, label);
}

async function main() {
  const extension = require('../dist/extension.js');
  extension.activate(context);

  const openLog = commands.get('pycharmGit.openLog');
  assert.ok(openLog, 'openLog command registered');

  console.log('· opening log panel');
  await openLog();
  assert.equal(panels.length, 1, 'one webview panel');
  const panel = panels[0];
  assert.ok(panel.webview.html.includes('<!DOCTYPE html>'), 'html set');
  assert.ok(panel.webview.html.includes('main.js'), 'assets referenced');

  let state = await waitState((s) => s.ref === 'main' && s.commits.length === 3, 'initial main state');
  assert.equal(state.current, 'main');
  assert.equal(state.branches.filter((b) => !b.isRemote).length, 3);
  assert.ok(state.commits[0].refs.some((ref) => ref.kind === 'head'));

  console.log('· select feature branch');
  send(panel, { type: 'selectRef', ref: 'feature/login' });
  state = await waitState((s) => s.ref === 'feature/login' && s.commits.length === 3, 'feature state');
  assert.equal(state.label, 'feature/login');

  console.log('· commit details');
  const featureCommit = state.commits[0];
  messages.length = 0;
  send(panel, { type: 'details', hash: featureCommit.hash });
  const details = await waitFor(() => messages.find((m) => m.type === 'details'), 'details message');
  assert.equal(details.hash, featureCommit.hash);
  assert.ok(details.files.some((file) => file.path === 'c.txt' && file.status === 'A'));

  console.log('· file diff');
  executed.length = 0;
  send(panel, {
    type: 'diff',
    hash: details.hash,
    parent: details.parents[0],
    path: 'c.txt',
    status: 'A',
  });
  const diffCall = await waitFor(() => executed.find((call) => call.id === 'vscode.diff'), 'diff command');
  const provider = providers.get('pycharm-git');
  assert.ok(provider, 'content provider registered');
  const leftContent = await provider.provideTextDocumentContent(diffCall.args[0]);
  const rightContent = await provider.provideTextDocumentContent(diffCall.args[1]);
  assert.equal(leftContent, '', 'left side of added file is empty');
  assert.ok(rightContent.includes('c1'), 'right side contains file content');

  console.log('· checkout branch');
  send(panel, { type: 'action', action: 'checkoutBranch', ref: 'feature/login', remote: false });
  await waitFor(() => git(['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'feature/login', 'git checkout');
  await waitState((s) => s.current === 'feature/login', 'state after checkout');

  console.log('· checkout main back');
  send(panel, { type: 'action', action: 'checkoutBranch', ref: 'main', remote: false });
  await waitState((s) => s.current === 'main', 'state back on main');

  console.log('· merge side into main');
  messages.length = 0;
  send(panel, { type: 'action', action: 'merge', ref: 'side' });
  const mergeNotice = await waitFor(
    () => messages.find((m) => m.type === 'notice' && m.kind === 'success'),
    'merge notice'
  );
  assert.ok(mergeNotice.text.toLowerCase().includes('merged'), 'merge notice text');
  state = await waitState((s) => s.commits[0].subject.startsWith("Merge branch 'side'"), 'merge commit in log');

  console.log('· cherry-pick feature commit onto main');
  send(panel, { type: 'selectRef', ref: 'feature/login' });
  state = await waitState((s) => s.ref === 'feature/login', 'feature state again');
  const toPick = state.commits[0];
  send(panel, { type: 'selectRef', ref: 'main' });
  await waitState((s) => s.ref === 'main', 'main state');
  messages.length = 0;
  send(panel, { type: 'action', action: 'cherryPick', hash: toPick.hash });
  await waitFor(
    () => messages.find((m) => m.type === 'notice' && m.kind === 'success' && /cherry-picked/i.test(m.text)),
    'cherry-pick notice'
  );
  const log = git(['log', '--pretty=%s', '-1']).trim();
  assert.equal(log, 'feature: login screen');

  console.log('· persist selection');
  assert.ok(stateStore.get('pycharmGit.state'), 'workspace state saved');

  console.log('\nIntegration checks passed.');
  console.log('Fixture repo:', repoDir);
}

main().catch((error) => {
  console.error('\nINTEGRATION TEST FAILED');
  console.error(error);
  process.exitCode = 1;
});
