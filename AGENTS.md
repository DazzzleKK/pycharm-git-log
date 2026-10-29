# AGENTS.md — pycharm-git-log

This file tells an AI coding agent how to work in this repository. Read it before
changing code.

## What this project is

A VS Code extension that reproduces PyCharm's **Git tool window**: a branch tree,
commit log with a graph, commit details and a file diff, plus checkout, merge,
rebase, cherry-pick, reset, revert, tags and fetch/pull/push.

The extension is TypeScript for the extension host, plus a vanilla JavaScript
webview. It talks to the real `git` CLI; it does not bundle a Git library.

## Requirements

- Node.js 20 or newer (build only).
- VS Code 1.90 or newer.
- Git 2.30 or newer on `PATH`.

## Layout

```
src/extension.ts       controller, commands, webview lifecycle, diff provider
src/git.ts             git CLI wrapper, parsing, operations
src/html.ts            webview HTML shell and CSP nonce
media/main.css         VS Code-themed webview styles
media/main.js          branch tree, commit table, details, menus, toasts
media/graph.js         commit graph lane layout
media/codicons/        vendored VS Code codicon font
media/screenshot.png   demo screenshot (synthetic repository)
test/integration.cjs   integration test against a temporary repo
test/graph-check.cjs   randomized graph layout checks
.esbuild.mjs           production/development bundler
dist/                  generated; never edit or commit
pycharm-git-log.vsix   generated package; never commit
```

## Build and test

```bash
npm ci
npm run check       # tsc --noEmit
npm run build       # esbuild -> dist/extension.js
npm test            # build + integration test (temporary git repo)
npm run test:graph  # graph layout checks
npm run package     # check + production build + vsce package
```

For development, open the folder in VS Code and press `F5`; `.vscode/launch.json`
starts the Extension Development Host. `npm run watch` rebuilds on change.

## Architecture rules

- `src/git.ts` is the only place that runs Git. Use `execFile`, never a shell.
  Keep `windowsHide`, a bounded `maxBuffer`, and `GIT_TERMINAL_PROMPT=0` unless a
  command deliberately needs credentials.
- Validate revisions and paths before passing them to Git. Branch names, refs and
  commit hashes come from the webview and must not be treated as trusted.
- The webview is plain browser code. It must not use Node APIs or `require`.
- Do not build HTML by concatenating user data. Use `textContent` in the webview;
  escape anything inserted into `html.ts`.
- Keep the CSP nonce mechanism in `html.ts`; do not add inline event handlers.
- The webview talks to the host through `acquireVsCodeApi().postMessage`. Keep
  message shapes consistent between `media/main.js` and `src/extension.ts`.
- Long Git operations belong in the controller, not in the webview. Show errors
  as notices; confirm hard reset, force delete and other destructive actions.
- Use VS Code theme variables (`--vscode-*`) instead of fixed colors.
- Persist view state with `vscode.getState/setState`; do not write extension
  settings from the webview.
- Keep multi-root repository selection working: pass the repository root through
  every command and diff request.

## Data flow

```
webview (media/main.js)
  postMessage({ type: "ready" | "refresh" | "selectRef" | "details" |
                "diff" | "action" | "copy" })
        |
        v
src/extension.ts  ->  src/git.ts  ->  git CLI
        |
        v
webview.postMessage({ type: "state" | "details" | "diff" | "notice" | ... })
```

A new message type requires changes in both halves and a manual test. Keep the
`state` object shape compatible with the existing renderer:

- `repos`, `repo`, `ref`, `label`, `refKind`;
- `branches`, `commits`, `limit`, `hasMore`;
- `current`, `detached`, `headSha`, `ahead`, `behind`;
- `empty`, `showGraph`, `dateStyle`.

## Safety and testing

- Never run destructive Git commands against a user's repository. Tests create a
  temporary repository (see `test/integration.cjs`).
- Do not commit `node_modules/`, `dist/`, `*.vsix`, `.vscode-test/` or logs.
- Do not commit real internal repository screenshots or credentials. The demo
  screenshot must use a synthetic repository.
- Before a release run `npm run check`, `npm test`, `npm run test:graph` and
  `npm run package`.

## Git UI mirror

The webview files (`media/main.js`, `media/main.css`, `media/graph.js`) are the
upstream of the standalone DSH plugin `dsh-code-git-workbench`. If you fix a Git
UI bug here, port the same fix there and test both. Do not add a runtime
dependency between the two repositories.

## Release checklist

- Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
- Run the full test suite.
- Package the VSIX; attach it to a GitHub Release (do not commit it).
- Update README if commands, settings or installation changed.
