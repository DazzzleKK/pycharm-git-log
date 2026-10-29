import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

export function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const media = (...parts: string[]) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', ...parts)).toString();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${media('codicons', 'codicon.css')}" />
<link rel="stylesheet" href="${media('main.css')}" />
<title>Git</title>
</head>
<body>
<div class="app" id="app">
  <header class="toolbar">
    <div class="toolbar-group">
      <button class="icon-btn" id="btn-refresh" title="Refresh (F5)">
        <i class="codicon codicon-refresh"></i>
      </button>
      <span class="toolbar-sep"></span>
      <button class="icon-btn" id="btn-fetch" title="Fetch all remotes">
        <i class="codicon codicon-repo-fetch"></i>
      </button>
      <button class="icon-btn" id="btn-pull" title="Pull current branch">
        <i class="codicon codicon-repo-pull"></i>
      </button>
      <button class="icon-btn" id="btn-push" title="Push current branch">
        <i class="codicon codicon-repo-push"></i>
      </button>
      <span class="toolbar-sep"></span>
      <button class="icon-btn" id="btn-new-branch" title="New branch from HEAD">
        <i class="codicon codicon-git-branch"></i><i class="codicon codicon-add badge-add"></i>
      </button>
    </div>

    <div class="branch-chip" id="branch-chip" title="Current branch">
      <i class="codicon codicon-git-branch"></i>
      <span class="branch-chip-label" id="current-branch-label">—</span>
      <span class="ahead-behind" id="ahead-behind"></span>
    </div>

    <div class="toolbar-spacer"></div>

    <div class="toolbar-group">
      <select class="repo-select" id="repo-select" title="Repository" hidden></select>
      <button class="icon-btn" id="btn-details" title="Toggle commit details">
        <i class="codicon codicon-layout-sidebar-right"></i>
      </button>
      <button class="icon-btn" id="btn-settings" title="Extension settings">
        <i class="codicon codicon-settings-gear"></i>
      </button>
      <button class="icon-btn" id="btn-close" title="Close Git Log (Ctrl+W)">
        <i class="codicon codicon-close"></i>
      </button>
    </div>
  </header>

  <div class="layout">
    <aside class="branches-pane" id="branches-pane">
      <div class="pane-head">
        <span class="pane-title">Branches</span>
        <div class="pane-actions">
          <button class="icon-btn small" id="btn-collapse-branches" title="Collapse all">
            <i class="codicon codicon-collapse-all"></i>
          </button>
        </div>
      </div>
      <div class="filter-row">
        <i class="codicon codicon-search filter-icon"></i>
        <input type="text" class="filter-input" id="branch-filter" placeholder="Filter branches" spellcheck="false" autocomplete="off" />
      </div>
      <div class="branch-tree" id="branch-tree" role="tree" aria-label="Branches"></div>
      <div class="pane-foot" id="branches-foot"></div>
    </aside>

    <div class="splitter" id="splitter-branches" role="separator" aria-orientation="vertical" tabindex="-1"></div>

    <section class="commits-pane" id="commits-pane">
      <div class="commits-head">
        <div class="ref-block">
          <span class="ref-name" id="ref-name">main</span>
          <span class="ref-meta" id="ref-meta"></span>
        </div>
        <div class="filter-row commits-filter">
          <i class="codicon codicon-search filter-icon"></i>
          <input type="text" class="filter-input" id="commit-filter" placeholder="Filter commits" spellcheck="false" autocomplete="off" />
        </div>
      </div>

      <div class="commit-scroll" id="commit-scroll">
        <div class="table-head" id="table-head">
          <div class="cell-graph"></div>
          <div class="cell-subject">Subject</div>
          <div class="cell-author">Author</div>
          <div class="cell-date">Date</div>
          <div class="cell-hash">Hash</div>
        </div>
        <div class="commit-list" id="commit-list" tabindex="0" role="listbox" aria-label="Commits"></div>
        <div class="empty-state" id="empty-state" hidden></div>
        <div class="load-more" id="load-more" hidden>
          <button class="btn" id="btn-load-more">Load more commits</button>
        </div>
      </div>
    </section>

    <div class="splitter" id="splitter-details" role="separator" aria-orientation="vertical" tabindex="-1"></div>

    <aside class="details-pane" id="details-pane">
      <div class="details-placeholder" id="details-placeholder">
        <i class="codicon codicon-git-commit"></i>
        <span>Select a commit to see details</span>
      </div>
      <div class="details-body" id="details-body" hidden></div>
    </aside>
  </div>

  <footer class="statusbar">
    <span class="status-left" id="status-left"></span>
    <span class="status-right" id="status-right"></span>
  </footer>

  <div class="progress" id="progress" hidden></div>
  <div class="busy-pill" id="busy-pill" hidden></div>
  <div class="toasts" id="toasts"></div>
  <div class="menu-layer" id="menu-layer" hidden>
    <div class="ctx-menu" id="ctx-menu" role="menu"></div>
  </div>
</div>

<script nonce="${nonce}" src="${media('graph.js')}"></script>
<script nonce="${nonce}" src="${media('main.js')}"></script>
</body>
</html>`;
}
