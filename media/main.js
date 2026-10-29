/* global PyCharmGraph */
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  var persisted = vscode.getState() || {};

  var ROW_H = 24;
  var LANE_W = 14;
  var PAD_X = 10;

  var state = null;
  var selectedHash = null;
  var detailsCache = new Map();
  var requestedDetails = new Set();
  var branchFilter = '';
  var commitFilter = '';
  var collapsed = Object.assign({ local: false, remote: false }, persisted.collapsed || {});
  var detailsVisible =
    persisted.detailsVisible === undefined
      ? window.innerWidth >= 980
      : persisted.detailsVisible !== false;
  var widths = {
    branches: persisted.branchesWidth || 220,
    details: persisted.detailsWidth || 320,
  };
  var lastRef = null;
  var filteredCommits = [];
  var rowByHash = new Map();
  var menuOpen = false;
  var busy = false;
  var noRepoText = '';

  var absFmt = new Intl.DateTimeFormat(undefined, {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  var fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'medium' });

  /* ------------------------------------------------------------------ util */

  function $(id) {
    return document.getElementById(id);
  }

  function h(tag, className, text) {
    var node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined && text !== null) {
      node.textContent = String(text);
    }
    return node;
  }

  function iconEl(name, extra) {
    var node = document.createElement('i');
    node.className = 'codicon codicon-' + name + (extra ? ' ' + extra : '');
    node.setAttribute('aria-hidden', 'true');
    return node;
  }

  function icon(name, extra) {
    return '<i class="codicon codicon-' + name + (extra ? ' ' + extra : '') + '" aria-hidden="true"></i>';
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function persist() {
    vscode.setState({
      collapsed: collapsed,
      detailsVisible: detailsVisible,
      branchesWidth: widths.branches,
      detailsWidth: widths.details,
    });
  }

  function sendAction(action, payload) {
    vscode.postMessage(Object.assign({ type: 'action', action: action }, payload || {}));
  }

  function copyText(text) {
    if (text) {
      vscode.postMessage({ type: 'copy', text: String(text) });
    }
  }

  function formatDate(seconds) {
    if (!seconds) {
      return '';
    }
    var date = new Date(seconds * 1000);
    if (state && state.dateStyle === 'relative') {
      return relativeTime(date);
    }
    return absFmt.format(date);
  }

  function relativeTime(date) {
    var diff = (Date.now() - date.getTime()) / 1000;
    if (diff < 60) {
      return 'just now';
    }
    var units = [
      [31536000, 'year'],
      [2592000, 'month'],
      [604800, 'week'],
      [86400, 'day'],
      [3600, 'hour'],
      [60, 'minute'],
    ];
    for (var i = 0; i < units.length; i++) {
      var size = units[i][0];
      if (diff >= size) {
        var count = Math.floor(diff / size);
        return count + ' ' + units[i][1] + (count > 1 ? 's' : '') + ' ago';
      }
    }
    return 'just now';
  }

  function toast(kind, text) {
    var container = $('toasts');
    var node = h('div', 'toast ' + (kind || 'info'));
    node.innerHTML = icon(kind === 'error' ? 'error' : kind === 'success' ? 'check' : 'info');
    node.appendChild(h('span', null, text));
    container.appendChild(node);
    while (container.children.length > 4) {
      container.removeChild(container.firstChild);
    }
    setTimeout(function () {
      node.style.opacity = '0';
      node.style.transition = 'opacity .2s';
      setTimeout(function () {
        if (node.parentNode) {
          node.parentNode.removeChild(node);
        }
      }, 220);
    }, 5000);
  }

  /* ---------------------------------------------------------------- boot */

  function boot() {
    if (persisted.branchesWidth) {
      document.documentElement.style.setProperty('--branches-w', widths.branches + 'px');
    }
    if (persisted.detailsWidth) {
      document.documentElement.style.setProperty('--details-w', widths.details + 'px');
    }
    applyDetailsVisibility();
    applyColumnLayout();

    $('btn-refresh').addEventListener('click', function () {
      vscode.postMessage({ type: 'refresh' });
    });
    $('btn-fetch').addEventListener('click', function () {
      sendAction('fetch');
    });
    $('btn-pull').addEventListener('click', function () {
      sendAction('pull');
    });
    $('btn-push').addEventListener('click', function () {
      sendAction('push');
    });
    $('btn-new-branch').addEventListener('click', function () {
      sendAction('newBranch');
    });
    $('btn-settings').addEventListener('click', function () {
      vscode.postMessage({ type: 'settings' });
    });
    $('btn-close').addEventListener('click', function () {
      vscode.postMessage({ type: 'close' });
    });
    $('btn-details').addEventListener('click', toggleDetails);
    $('btn-collapse-branches').addEventListener('click', function () {
      collapsed.local = true;
      collapsed.remote = true;
      persist();
      renderBranches();
    });
    $('btn-load-more').addEventListener('click', function () {
      vscode.postMessage({ type: 'loadMore' });
    });
    $('repo-select').addEventListener('change', function (event) {
      vscode.postMessage({ type: 'selectRepo', repo: event.target.value });
    });
    $('branch-chip').addEventListener('click', function () {
      if (state && state.current && !state.detached) {
        vscode.postMessage({ type: 'selectRef', ref: state.current });
      }
    });

    $('branch-filter').addEventListener('input', function (event) {
      branchFilter = event.target.value.trim().toLowerCase();
      renderBranches();
    });
    $('commit-filter').addEventListener('input', function (event) {
      commitFilter = event.target.value.trim().toLowerCase();
      renderCommits();
    });

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', function (event) {
      if (menuOpen && event.target === $('menu-layer')) {
        hideMenu();
      }
    });
    window.addEventListener('resize', function () {
      hideMenu();
      applyColumnLayout();
    });
    window.addEventListener('message', onMessage);
    setupSplitters();

    if (typeof ResizeObserver !== 'undefined') {
      var observer = new ResizeObserver(function () {
        applyColumnLayout();
      });
      observer.observe($('commits-pane'));
    }

    vscode.postMessage({ type: 'ready' });
  }

  function applyColumnLayout() {
    var pane = $('commits-pane');
    if (!pane) {
      return;
    }
    var width = pane.clientWidth;
    var showAuthor = width >= 680;
    var showDate = width >= 470;
    var showHash = width >= 760;
    pane.classList.toggle('no-author', !showAuthor);
    pane.classList.toggle('no-date', !showDate);
    pane.classList.toggle('no-hash', !showHash);
    pane.style.setProperty('--author-w', showAuthor ? '148px' : '0px');
    pane.style.setProperty('--date-w', showDate ? '124px' : '0px');
    pane.style.setProperty('--hash-w', showHash ? '68px' : '0px');
  }

  function setupSplitters() {
    makeSplitter($('splitter-branches'), function (event) {
      var pane = $('branches-pane');
      var left = pane.getBoundingClientRect().left;
      widths.branches = Math.max(160, Math.min(480, event.clientX - left));
      document.documentElement.style.setProperty('--branches-w', widths.branches + 'px');
    });
    makeSplitter($('splitter-details'), function (event) {
      var pane = $('details-pane');
      var right = pane.getBoundingClientRect().right;
      widths.details = Math.max(240, Math.min(680, right - event.clientX));
      document.documentElement.style.setProperty('--details-w', widths.details + 'px');
    });
  }

  function makeSplitter(element, onMove) {
    element.addEventListener('mousedown', function (event) {
      event.preventDefault();
      document.body.classList.add('resizing');
      var move = function (moveEvent) {
        onMove(moveEvent);
      };
      var up = function () {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.classList.remove('resizing');
        persist();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  function toggleDetails() {
    detailsVisible = !detailsVisible;
    applyDetailsVisibility();
    persist();
  }

  function applyDetailsVisibility() {
    $('app').classList.toggle('details-hidden', !detailsVisible);
    $('btn-details').classList.toggle('active', detailsVisible);
  }

  /* -------------------------------------------------------------- messages */

  function onMessage(event) {
    var message = event.data;
    switch (message.type) {
      case 'state':
        noRepoText = '';
        applyState(message.state);
        break;
      case 'details':
        onDetails(message);
        break;
      case 'busy':
        setBusy(!!message.value, message.label);
        break;
      case 'refreshing':
        setRefreshing(!!message.value);
        break;
      case 'notice':
        toast(message.kind || 'info', message.text);
        break;
      case 'emptystate':
        state = null;
        selectedHash = null;
        noRepoText = message.text || 'No Git repository found.';
        renderToolbar();
        renderBranches();
        renderCommits();
        renderDetails();
        break;
      default:
        break;
    }
  }

  function applyState(next) {
    var previous = state;
    state = next;

    if (previous && previous.repo !== next.repo) {
      detailsCache.clear();
      requestedDetails.clear();
      selectedHash = null;
    }

    var refChanged = !previous || previous.ref !== next.ref || previous.repo !== next.repo;
    var stillThere = selectedHash && next.commits.some(function (commit) {
      return commit.hash === selectedHash;
    });
    if (!next.commits.length) {
      selectedHash = null;
    } else if (refChanged || !stillThere) {
      selectedHash = next.commits[0].hash;
    }

    renderToolbar();
    renderBranches();
    renderCommits();
    renderDetails();
    renderStatus();
    if (selectedHash) {
      requestDetails(selectedHash);
    }
  }

  function setBusy(value, label) {
    busy = value;
    var pill = $('busy-pill');
    pill.hidden = !value;
    pill.replaceChildren();
    if (value) {
      pill.appendChild(iconEl('sync', 'codicon-modifier-spin'));
      pill.appendChild(h('span', null, label || 'Working...'));
    }
    var buttons = document.querySelectorAll('.toolbar .icon-btn');
    for (var i = 0; i < buttons.length; i++) {
      var id = buttons[i].id;
      if (id !== 'btn-settings' && id !== 'btn-close' && id !== 'btn-details') {
        buttons[i].disabled = value;
      }
    }
    var branchButtons = document.querySelectorAll('.pane-actions .icon-btn');
    for (var j = 0; j < branchButtons.length; j++) {
      branchButtons[j].disabled = value;
    }
  }

  function setRefreshing(value) {
    var button = $('btn-refresh');
    button.classList.toggle('active', value);
    var glyph = button.querySelector('.codicon');
    if (glyph) {
      glyph.classList.toggle('codicon-modifier-spin', value);
    }
    $('progress').hidden = !value;
  }

  /* -------------------------------------------------------------- toolbar */

  function renderToolbar() {
    var label = '—';
    var aheadBehind = $('ahead-behind');
    aheadBehind.replaceChildren();

    if (state) {
      if (state.detached) {
        label = 'HEAD detached';
      } else if (state.current) {
        label = state.current;
      }
      if (state.ahead) {
        var up = h('span', 'up', '↑' + state.ahead);
        up.title = state.ahead + ' commit(s) to push';
        aheadBehind.appendChild(up);
      }
      if (state.behind) {
        var down = h('span', 'down', '↓' + state.behind);
        down.title = state.behind + ' commit(s) to pull';
        aheadBehind.appendChild(down);
      }
    }
    $('current-branch-label').textContent = label;
    $('branch-chip').title = state
      ? 'Current branch: ' + (state.current || 'HEAD detached') + '\n' + state.repo
      : 'Current branch';

    var select = $('repo-select');
    select.replaceChildren();
    if (state && state.repos.length > 1) {
      state.repos.forEach(function (repo) {
        var option = document.createElement('option');
        option.value = repo.root;
        option.textContent = repo.name + (repo.current ? ' — ' + repo.current : '');
        option.selected = repo.root === state.repo;
        select.appendChild(option);
      });
      select.hidden = false;
    } else {
      select.hidden = true;
    }
  }

  function renderStatus() {
    var left = $('status-left');
    var right = $('status-right');
    if (!state) {
      left.textContent = '';
      right.textContent = '';
      return;
    }
    var total = state.commits.length;
    var suffix = state.hasMore ? '+' : '';
    left.textContent = state.repo;
    left.title = state.repo;
    right.textContent =
      total + suffix + ' commit' + (total === 1 ? '' : 's') +
      ' · ' + state.branches.length + ' branch' + (state.branches.length === 1 ? '' : 'es') +
      (state.limit ? ' · limit ' + state.limit : '');
  }

  /* ------------------------------------------------------------- branches */

  function renderBranches() {
    var tree = $('branch-tree');
    var foot = $('branches-foot');
    tree.replaceChildren();

    if (!state) {
      tree.appendChild(h('div', 'details-loading', noRepoText || 'Loading branches...'));
      foot.textContent = '';
      return;
    }

    var branches = state.branches;
    var local = branches.filter(function (branch) {
      return !branch.isRemote;
    });
    var remote = branches.filter(function (branch) {
      return branch.isRemote;
    });

    if (!branchFilter) {
      tree.appendChild(allBranchesRow());
    }

    tree.appendChild(branchGroup('Local', local, 'local'));
    tree.appendChild(branchGroup('Remote', remote, 'remote'));

    if (branchFilter && !branches.some(matchesBranch)) {
      tree.appendChild(h('div', 'details-loading', 'No branches match the filter'));
    }

    foot.textContent = local.length + ' local · ' + remote.length + ' remote';
  }

  function matchesBranch(branch) {
    if (!branchFilter) {
      return true;
    }
    return (
      branch.name.toLowerCase().indexOf(branchFilter) >= 0 ||
      (branch.upstream && branch.upstream.toLowerCase().indexOf(branchFilter) >= 0)
    );
  }

  function allBranchesRow() {
    var row = h('div', 'branch-row all-row' + (state && state.ref === 'ALL' ? ' selected' : ''));
    row.appendChild(iconEl('layers', 'branch-icon'));
    row.appendChild(h('span', 'branch-name', 'All branches'));
    row.title = 'Show commits from every branch';
    row.addEventListener('click', function () {
      vscode.postMessage({ type: 'selectRef', ref: 'ALL' });
    });
    return row;
  }

  function branchGroup(title, branches, key) {
    var group = h('div', 'branch-group');
    var visible = branches.filter(matchesBranch);
    var header = h('div', 'group-row' + (collapsed[key] && !branchFilter ? ' collapsed' : ''));
    header.appendChild(iconEl('chevron-down', 'chevron'));
    header.appendChild(h('span', null, title));
    header.appendChild(h('span', 'group-count', String(branches.length)));
    if (!branchFilter) {
      header.addEventListener('click', function () {
        collapsed[key] = !collapsed[key];
        persist();
        renderBranches();
      });
    }
    group.appendChild(header);

    if (!collapsed[key] || branchFilter) {
      if (!visible.length) {
        group.appendChild(h('div', 'details-loading', branchFilter ? 'No matches' : 'None'));
      }
      visible.forEach(function (branch) {
        group.appendChild(branchRow(branch));
      });
    }
    return group;
  }

  function branchRow(branch) {
    var selected = state && state.ref === branch.name;
    var row = h(
      'div',
      'branch-row' + (branch.current ? ' current' : '') + (branch.isRemote ? ' remote' : '') + (selected ? ' selected' : '')
    );
    row.setAttribute('role', 'treeitem');
    row.dataset.ref = branch.name;
    row.appendChild(iconEl(branch.isRemote ? 'cloud' : 'git-branch', 'branch-icon'));
    row.appendChild(h('span', 'branch-name', branch.name));
    if (branch.current) {
      row.appendChild(iconEl('check', 'branch-check'));
    }
    if (branch.ahead || branch.behind) {
      var track = h('span', 'branch-track');
      if (branch.ahead) {
        track.appendChild(h('span', 'up', '↑' + branch.ahead));
      }
      if (branch.behind) {
        track.appendChild(h('span', 'down', '↓' + branch.behind));
      }
      row.appendChild(track);
    }
    if (branch.gone) {
      row.appendChild(iconEl('warning', 'branch-gone'));
    }
    row.title =
      branch.name +
      (branch.upstream ? '\nupstream: ' + branch.upstream + (branch.gone ? ' (gone)' : '') : '\nno upstream') +
      (branch.subject ? '\n' + branch.subject : '') +
      (branch.isRemote ? '\nremote branch' : '');

    row.addEventListener('click', function () {
      vscode.postMessage({ type: 'selectRef', ref: branch.name });
    });
    row.addEventListener('dblclick', function () {
      sendAction('checkoutBranch', { ref: branch.name, remote: branch.isRemote });
    });
    row.addEventListener('contextmenu', function (event) {
      event.preventDefault();
      event.stopPropagation();
      branchMenu(branch, event.clientX, event.clientY);
    });
    return row;
  }

  /* -------------------------------------------------------------- commits */

  function renderCommits() {
    var list = $('commit-list');
    var scroller = $('commit-scroll');
    var empty = $('empty-state');
    var previousScroll = scroller.scrollTop;
    list.replaceChildren();
    rowByHash.clear();
    filteredCommits = [];

    if (!state) {
      showEmpty(noRepoText || 'Loading...');
      return;
    }

    var all = state.commits;
    filteredCommits = all.filter(matchesCommit);

    $('ref-name').textContent = state.label;
    $('ref-name').title = state.label;
    var meta = filteredCommits.length + (state.hasMore ? '+' : '') + ' commits';
    if (commitFilter) {
      meta += ' (filtered from ' + all.length + ')';
    }
    if (state.detached) {
      meta += ' · detached HEAD';
    }
    $('ref-meta').textContent = meta;

    var graph = null;
    if (state.showGraph && filteredCommits.length) {
      graph = PyCharmGraph.computeGraph(filteredCommits, { rowH: ROW_H, laneW: LANE_W, padX: PAD_X });
      var width = Math.max(24, graph.width);
      $('commits-pane').style.setProperty('--graph-w', width + 'px');
    } else {
      $('commits-pane').style.setProperty('--graph-w', '16px');
    }

    var fragment = document.createDocumentFragment();
    filteredCommits.forEach(function (commit, index) {
      fragment.appendChild(commitRow(commit, graph ? graph.rows[index] : null, graph ? graph.width : 16));
    });
    list.appendChild(fragment);

    if (state.empty) {
      showEmpty('This repository has no commits yet.', 'Create a first commit, then refresh.');
    } else if (!filteredCommits.length && commitFilter) {
      showEmpty('No commits match the filter.');
    } else if (!filteredCommits.length) {
      showEmpty('No commits to show.');
    } else {
      empty.hidden = true;
      list.hidden = false;
    }

    $('load-more').hidden = !state.hasMore;
    $('btn-load-more').textContent = 'Load more commits (showing ' + all.length + ')';
    applyColumnLayout();

    var refChanged = state.ref !== lastRef;
    lastRef = state.ref;
    scroller.scrollTop = refChanged ? 0 : previousScroll;
  }

  function matchesCommit(commit) {
    if (!commitFilter) {
      return true;
    }
    var haystack = (
      commit.subject +
      ' ' +
      commit.author +
      ' ' +
      commit.email +
      ' ' +
      commit.hash +
      ' ' +
      commit.refs.map(function (ref) {
        return ref.name;
      }).join(' ')
    ).toLowerCase();
    return haystack.indexOf(commitFilter) >= 0;
  }

  function showEmpty(text, hint) {
    var empty = $('empty-state');
    empty.hidden = false;
    empty.replaceChildren(iconEl('git-commit'), h('div', null, text));
    if (hint) {
      empty.appendChild(h('div', 'hint', hint));
    }
    $('commit-list').hidden = true;
  }

  function commitRow(commit, graphRow, graphWidth) {
    var row = h('div', 'commit-row');
    row.dataset.hash = commit.hash;
    row.setAttribute('role', 'option');

    var graphCell = h('div', 'cell-graph');
    if (graphRow) {
      graphCell.appendChild(graphSvg(graphRow, graphWidth));
    }
    row.appendChild(graphCell);

    var subject = h('div', 'cell-subject');
    var subjectText = h('span', 'subject-text', commit.subject || '(no message)');
    subjectText.title = commit.subject || '';
    subject.appendChild(subjectText);
    var badges = h('span', 'badges');
    var maxBadges = 2;
    commit.refs.slice(0, maxBadges).forEach(function (ref) {
      badges.appendChild(badgeElement(ref));
    });
    if (commit.refs.length > maxBadges) {
      var more = h('span', 'badge badge-more', '+' + (commit.refs.length - maxBadges));
      more.title = commit.refs
        .slice(maxBadges)
        .map(function (ref) {
          return ref.name;
        })
        .join('\n');
      badges.appendChild(more);
    }
    if (badges.children.length) {
      subject.appendChild(badges);
    }
    row.appendChild(subject);

    var author = h('div', 'cell-author', commit.author);
    author.title = commit.author + ' <' + commit.email + '>';
    row.appendChild(author);

    var date = h('div', 'cell-date', formatDate(commit.authorTime));
    date.title = fullFmt.format(new Date(commit.authorTime * 1000));
    row.appendChild(date);

    var hash = h('div', 'cell-hash', commit.short);
    hash.title = commit.hash;
    row.appendChild(hash);

    if (commit.hash === selectedHash) {
      row.classList.add('selected');
    }
    rowByHash.set(commit.hash, row);

    row.addEventListener('click', function () {
      selectCommit(commit.hash);
    });
    row.addEventListener('dblclick', function () {
      if (!detailsVisible) {
        toggleDetails();
        return;
      }
      var details = detailsCache.get(commit.hash);
      if (details && details.files && details.files.length) {
        openDiff(details.files[0], details, false);
      }
    });
    row.addEventListener('contextmenu', function (event) {
      event.preventDefault();
      event.stopPropagation();
      commitMenu(commit, event.clientX, event.clientY);
    });
    return row;
  }

  function graphSvg(info, width) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(info.rowH));
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + info.rowH);
    svg.setAttribute('focusable', 'false');

    info.shapes.forEach(function (shape) {
      var node;
      if (shape.type === 'line') {
        node = document.createElementNS(NS, 'line');
        node.setAttribute('x1', String(shape.x1));
        node.setAttribute('y1', String(shape.y1));
        node.setAttribute('x2', String(shape.x2));
        node.setAttribute('y2', String(shape.y2));
      } else {
        node = document.createElementNS(NS, 'path');
        var dy = shape.y2 - shape.y1;
        node.setAttribute(
          'd',
          'M ' + shape.x1 + ' ' + shape.y1 +
            ' C ' + shape.x1 + ' ' + (shape.y1 + dy * 0.55) +
            ', ' + shape.x2 + ' ' + (shape.y2 - dy * 0.55) +
            ', ' + shape.x2 + ' ' + shape.y2
        );
      }
      node.setAttribute('stroke', shape.color);
      node.setAttribute('stroke-width', '1.8');
      node.setAttribute('fill', 'none');
      node.setAttribute('stroke-linecap', 'round');
      svg.appendChild(node);
    });

    var circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('cx', String(info.node.x));
    circle.setAttribute('cy', String(info.node.y));
    circle.setAttribute('r', String(info.radius));
    circle.setAttribute('fill', info.node.color);
    circle.style.stroke = 'var(--bg)';
    circle.setAttribute('stroke-width', '1.5');
    svg.appendChild(circle);
    return svg;
  }

  function badgeElement(ref) {
    var badge = h('span', 'badge badge-' + ref.kind, ref.name);
    badge.title = ref.kind === 'head' ? 'HEAD' : ref.kind + ': ' + ref.name;
    if (ref.current) {
      badge.classList.add('badge-current');
    }
    return badge;
  }

  function selectCommit(hash, options) {
    options = options || {};
    if (!hash || !rowByHash.has(hash)) {
      return;
    }
    selectedHash = hash;
    rowByHash.forEach(function (row, key) {
      row.classList.toggle('selected', key === hash);
    });
    renderDetails();
    requestDetails(hash);
    var row = rowByHash.get(hash);
    if (row && options.scroll) {
      row.scrollIntoView({ block: 'nearest' });
    }
    if (options.focus) {
      $('commit-list').focus();
    }
  }

  function moveSelection(delta, event) {
    if (!filteredCommits.length) {
      return;
    }
    var index = filteredCommits.findIndex(function (commit) {
      return commit.hash === selectedHash;
    });
    if (index < 0) {
      index = 0;
    }
    var next = Math.max(0, Math.min(filteredCommits.length - 1, index + delta));
    if (event) {
      event.preventDefault();
    }
    selectCommit(filteredCommits[next].hash, { scroll: true, focus: true });
  }

  function requestDetails(hash) {
    if (!hash || detailsCache.has(hash) || requestedDetails.has(hash)) {
      return;
    }
    requestedDetails.add(hash);
    vscode.postMessage({ type: 'details', hash: hash });
    setTimeout(function () {
      requestedDetails.delete(hash);
    }, 4000);
  }

  function onDetails(message) {
    var details = {
      hash: message.hash,
      body: message.body,
      files: message.files || [],
      parents: message.parents || [],
      subject: message.subject,
      author: message.author,
      email: message.email,
      authorTime: message.authorTime,
      refs: message.refs || [],
    };
    detailsCache.set(message.hash, details);
    requestedDetails.delete(message.hash);
    if (message.hash === selectedHash) {
      renderDetails();
    }
  }

  /* -------------------------------------------------------------- details */

  function renderDetails() {
    var placeholder = $('details-placeholder');
    var body = $('details-body');
    var commit = null;
    if (state && selectedHash) {
      commit = state.commits.find(function (item) {
        return item.hash === selectedHash;
      }) || null;
    }
    if (!commit) {
      placeholder.hidden = false;
      body.hidden = true;
      body.replaceChildren();
      return;
    }

    var details = detailsCache.get(commit.hash) || null;
    placeholder.hidden = true;
    body.hidden = false;
    body.replaceChildren();

    var header = h('div', 'details-header');
    header.appendChild(h('div', 'details-subject', commit.subject || '(no message)'));
    var refs = h('div', 'details-refs');
    commit.refs.forEach(function (ref) {
      refs.appendChild(badgeElement(ref));
    });
    if (refs.children.length) {
      header.appendChild(refs);
    }

    var actions = h('div', 'details-actions');
    [
      { act: 'checkoutRevision', glyph: 'git-commit', title: 'Checkout revision' },
      { act: 'newBranch', glyph: 'git-branch', title: 'New branch from this commit' },
      { act: 'cherryPick', glyph: 'git-compare', title: 'Cherry-pick this commit' },
      { act: 'mergeCommit', glyph: 'git-merge', title: 'Merge into current branch' },
      { act: 'reset', glyph: 'discard', title: 'Reset current branch to this commit' },
      { act: 'revert', glyph: 'history', title: 'Revert this commit' },
      { act: 'createTag', glyph: 'tag', title: 'Create tag here' },
    ].forEach(function (definition) {
      var button = h('button', 'icon-btn');
      button.type = 'button';
      button.title = definition.title;
      button.appendChild(iconEl(definition.glyph));
      button.addEventListener('click', function () {
        sendAction(definition.act, { hash: commit.hash });
      });
      actions.appendChild(button);
    });
    header.appendChild(actions);
    body.appendChild(header);

    var meta = h('div', 'details-meta');
    meta.appendChild(metaRow('account', commit.author, commit.email, null));
    var fullDate = fullFmt.format(new Date(commit.authorTime * 1000));
    meta.appendChild(metaRow('calendar', fullDate, relativeTime(new Date(commit.authorTime * 1000)), fullDate));

    if (commit.parents.length) {
      var parentRow = h('div', 'meta-row');
      parentRow.appendChild(iconEl('git-commit'));
      parentRow.appendChild(h('span', 'meta-secondary', commit.parents.length > 1 ? 'Parents' : 'Parent'));
      commit.parents.forEach(function (parent) {
        var chip = h('code', 'parent-chip', parent.slice(0, 8));
        chip.title = parent + (rowByHash.has(parent) ? '\nClick to select' : '');
        if (rowByHash.has(parent)) {
          chip.style.cursor = 'pointer';
          chip.addEventListener('click', function () {
            selectCommit(parent, { scroll: true });
          });
        }
        parentRow.appendChild(chip);
      });
      meta.appendChild(parentRow);
    }

    var hashRow = h('div', 'meta-row hash-row');
    hashRow.appendChild(iconEl('git-commit'));
    var code = h('code', null, commit.hash.slice(0, 12));
    code.title = 'Click to copy\n' + commit.hash;
    code.addEventListener('click', function () {
      copyText(commit.hash);
      toast('info', 'Hash copied');
    });
    hashRow.appendChild(code);
    var copy = h('button', 'icon-btn copy-btn');
    copy.type = 'button';
    copy.title = 'Copy hash';
    copy.appendChild(iconEl('copy'));
    copy.addEventListener('click', function () {
      copyText(commit.hash);
      toast('info', 'Hash copied');
    });
    hashRow.appendChild(copy);
    meta.appendChild(hashRow);
    body.appendChild(meta);

    var messageText = (details && details.body) || '';
    var subjectText = commit.subject || '';
    if (messageText.indexOf(subjectText) === 0) {
      messageText = messageText.slice(subjectText.length);
    }
    messageText = messageText.replace(/^\s+/, '').trim();
    if (messageText) {
      body.appendChild(h('div', 'details-message', messageText));
    }

    if (!details) {
      var loading = h('div', 'details-loading');
      loading.appendChild(iconEl('sync', 'codicon-modifier-spin'));
      loading.appendChild(h('span', null, 'Loading changes...'));
      body.appendChild(loading);
      return;
    }

    var adds = 0;
    var dels = 0;
    details.files.forEach(function (file) {
      adds += file.adds;
      dels += file.dels;
    });

    var filesHeader = h('div', 'files-header');
    filesHeader.appendChild(h('span', null, 'Files · ' + details.files.length));
    var stats = h('span', 'files-stats');
    stats.appendChild(h('span', 'add', '+' + adds));
    stats.appendChild(h('span', null, ' '));
    stats.appendChild(h('span', 'del', '−' + dels));
    filesHeader.appendChild(stats);
    body.appendChild(filesHeader);

    var list = h('div', 'files-list');
    if (!details.files.length) {
      list.appendChild(h('div', 'details-loading', 'No file changes'));
    }
    details.files.forEach(function (file) {
      list.appendChild(fileRow(file, details));
    });
    body.appendChild(list);
  }

  function metaRow(glyph, value, secondary, title) {
    var row = h('div', 'meta-row');
    row.appendChild(iconEl(glyph));
    row.appendChild(h('span', 'meta-value', value));
    if (secondary) {
      row.appendChild(h('span', 'meta-secondary', secondary));
    }
    if (title) {
      row.title = title;
    }
    return row;
  }

  function fileRow(file, details) {
    var row = h('div', 'file-row');
    row.tabIndex = 0;
    row.appendChild(h('span', 'file-status status-' + file.status, file.status));

    var dot = file.path.lastIndexOf('/');
    var dir = dot >= 0 ? file.path.slice(0, dot + 1) : '';
    var name = dot >= 0 ? file.path.slice(dot + 1) : file.path;
    var path = h('span', 'file-path');
    if (dir) {
      path.appendChild(h('span', 'file-dir', dir));
    }
    path.appendChild(h('span', 'file-name', name));
    path.title = file.path + (file.oldPath ? ' (renamed from ' + file.oldPath + ')' : '');
    row.appendChild(path);

    if (file.binary) {
      row.appendChild(h('span', 'file-binary', 'binary'));
    } else {
      var stats = h('span', 'file-stats');
      if (file.adds) {
        stats.appendChild(h('span', 'add', '+' + file.adds));
      }
      if (file.dels) {
        stats.appendChild(h('span', 'del', '−' + file.dels));
      }
      row.appendChild(stats);
    }

    row.addEventListener('click', function () {
      openDiff(file, details, false);
    });
    row.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        openDiff(file, details, false);
      }
    });
    row.addEventListener('contextmenu', function (event) {
      event.preventDefault();
      fileMenu(file, details, event.clientX, event.clientY);
    });
    return row;
  }

  function openDiff(file, details, workingTree) {
    vscode.postMessage({
      type: 'diff',
      hash: details.hash || selectedHash,
      parent: details.parents && details.parents.length ? details.parents[0] : null,
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      workingTree: !!workingTree,
    });
  }

  function openSelectedDiff() {
    if (!detailsVisible) {
      toggleDetails();
      return;
    }
    var details = selectedHash ? detailsCache.get(selectedHash) : null;
    if (details && details.files.length) {
      openDiff(details.files[0], details, false);
    }
  }

  /* ---------------------------------------------------------------- menus */

  function showMenu(items, x, y) {
    var layer = $('menu-layer');
    var menu = $('ctx-menu');
    menu.replaceChildren();

    items.forEach(function (item) {
      if (!item || item.sep) {
        menu.appendChild(h('div', 'menu-sep'));
        return;
      }
      var button = h('button', 'menu-item' + (item.danger ? ' danger' : ''));
      button.type = 'button';
      button.disabled = !!item.disabled;
      button.appendChild(item.icon ? iconEl(item.icon) : h('span', 'menu-icon'));
      button.appendChild(h('span', 'menu-label', item.label));
      if (item.hint) {
        button.appendChild(h('span', 'menu-hint', item.hint));
      }
      button.addEventListener('click', function () {
        hideMenu();
        item.run();
      });
      menu.appendChild(button);
    });

    layer.hidden = false;
    menuOpen = true;
    var rect = menu.getBoundingClientRect();
    var left = Math.min(x, window.innerWidth - rect.width - 8);
    var top = Math.min(y, window.innerHeight - rect.height - 8);
    menu.style.left = Math.max(4, left) + 'px';
    menu.style.top = Math.max(4, top) + 'px';
  }

  function hideMenu() {
    $('menu-layer').hidden = true;
    menuOpen = false;
  }

  function commitMenu(commit, x, y) {
    var hasBranch = state && !!state.current;
    showMenu(
      [
        {
          label: 'Checkout Revision',
          icon: 'git-commit',
          run: function () {
            sendAction('checkoutRevision', { hash: commit.hash });
          },
        },
        {
          label: 'New Branch from Here...',
          icon: 'git-branch',
          run: function () {
            sendAction('newBranch', { ref: commit.hash });
          },
        },
        { sep: true },
        {
          label: 'Cherry-Pick',
          icon: 'git-compare',
          run: function () {
            sendAction('cherryPick', { hash: commit.hash });
          },
        },
        {
          label: 'Merge into Current',
          icon: 'git-merge',
          disabled: !hasBranch,
          run: function () {
            sendAction('mergeCommit', { hash: commit.hash });
          },
        },
        {
          label: 'Rebase Current onto Here',
          icon: 'arrow-swap',
          disabled: !hasBranch,
          run: function () {
            sendAction('rebaseOntoCommit', { hash: commit.hash });
          },
        },
        { sep: true },
        {
          label: 'Reset Current Branch to Here...',
          icon: 'discard',
          danger: true,
          disabled: !hasBranch,
          run: function () {
            sendAction('reset', { hash: commit.hash });
          },
        },
        {
          label: 'Revert Commit',
          icon: 'history',
          run: function () {
            sendAction('revert', { hash: commit.hash });
          },
        },
        { sep: true },
        {
          label: 'Create Tag...',
          icon: 'tag',
          run: function () {
            sendAction('createTag', { hash: commit.hash });
          },
        },
        {
          label: 'Copy Hash',
          icon: 'copy',
          hint: commit.short,
          run: function () {
            copyText(commit.hash);
          },
        },
        {
          label: 'Copy Commit Message',
          icon: 'copy',
          run: function () {
            copyText(commit.subject);
          },
        },
      ],
      x,
      y
    );
  }

  function branchMenu(branch, x, y) {
    var current = state && state.current;
    var isCurrent = !!branch.current;
    var items = [];

    items.push({
      label: isCurrent ? 'Checkout (current)' : 'Checkout',
      icon: 'git-branch',
      disabled: isCurrent,
      run: function () {
        sendAction('checkoutBranch', { ref: branch.name, remote: branch.isRemote });
      },
    });
    if (!branch.isRemote) {
      items.push({
        label: "Checkout and Rebase onto '" + (current || 'HEAD') + "'",
        icon: 'arrow-swap',
        disabled: isCurrent || !current,
        run: function () {
          sendAction('checkoutAndRebase', { ref: branch.name });
        },
      });
    }
    items.push({ sep: true });
    items.push({
      label: "New Branch from '" + branch.name + "'...",
      icon: 'git-branch',
      run: function () {
        sendAction('newBranch', { ref: branch.name });
      },
    });
    items.push({
      label: "Merge '" + branch.name + "' into Current",
      icon: 'git-merge',
      disabled: isCurrent || !current,
      run: function () {
        sendAction('merge', { ref: branch.name });
      },
    });
    items.push({
      label: "Rebase Current onto '" + branch.name + "'",
      icon: 'arrow-swap',
      disabled: isCurrent || !current,
      run: function () {
        sendAction('rebase', { ref: branch.name });
      },
    });
    items.push({ sep: true });
    items.push({
      label: 'Compare with Current',
      icon: 'git-compare',
      disabled: !current,
      run: function () {
        sendAction('compare', { ref: branch.name });
      },
    });
    items.push({ sep: true });

    if (!branch.isRemote) {
      items.push({
        label: "Push '" + branch.name + "'",
        icon: 'repo-push',
        run: function () {
          sendAction('push', { ref: branch.name });
        },
      });
      items.push({
        label: 'Rename...',
        icon: 'edit',
        run: function () {
          sendAction('renameBranch', { ref: branch.name });
        },
      });
      items.push({
        label: 'Delete',
        icon: 'trash',
        danger: true,
        disabled: isCurrent,
        run: function () {
          sendAction('deleteBranch', { ref: branch.name });
        },
      });
      items.push({ sep: true });
    }

    items.push({
      label: 'Create Tag...',
      icon: 'tag',
      run: function () {
        sendAction('createTagFromBranch', { ref: branch.name });
      },
    });
    items.push({
      label: 'Copy Branch Name',
      icon: 'copy',
      run: function () {
        copyText(branch.name);
      },
    });

    showMenu(items, x, y);
  }

  function fileMenu(file, details, x, y) {
    showMenu(
      [
        {
          label: 'Open Diff',
          icon: 'diff',
          run: function () {
            openDiff(file, details, false);
          },
        },
        {
          label: 'Compare with Working Tree',
          icon: 'file',
          disabled: file.status === 'D' || file.binary,
          run: function () {
            openDiff(file, details, true);
          },
        },
        { sep: true },
        {
          label: 'Copy Path',
          icon: 'copy',
          run: function () {
            copyText(file.path);
          },
        },
        {
          label: 'Copy Hash:Path',
          icon: 'copy',
          run: function () {
            copyText((details.hash || selectedHash) + ':' + file.path);
          },
        },
      ],
      x,
      y
    );
  }

  /* ------------------------------------------------------------- keyboard */

  function onKeyDown(event) {
    if (menuOpen && event.key !== 'Escape') {
      return;
    }
    if (event.key === 'Escape') {
      if (menuOpen) {
        hideMenu();
        event.preventDefault();
        return;
      }
      if (document.activeElement === $('commit-filter') || document.activeElement === $('branch-filter')) {
        document.activeElement.blur();
        return;
      }
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      $('commit-filter').focus();
      $('commit-filter').select();
      return;
    }

    if (event.key === 'F5') {
      event.preventDefault();
      vscode.postMessage({ type: 'refresh' });
      return;
    }

    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      if (event.key === 'Enter' && document.activeElement === $('branch-filter')) {
        var first = state && state.branches.filter(matchesBranch)[0];
        if (first) {
          vscode.postMessage({ type: 'selectRef', ref: first.name });
          $('branch-filter').blur();
        }
      }
      return;
    }

    if (event.key === 'ArrowDown') {
      moveSelection(1, event);
    } else if (event.key === 'ArrowUp') {
      moveSelection(-1, event);
    } else if (event.key === 'PageDown') {
      moveSelection(20, event);
    } else if (event.key === 'PageUp') {
      moveSelection(-20, event);
    } else if (event.key === 'Home') {
      if (filteredCommits.length) {
        selectCommit(filteredCommits[0].hash, { scroll: true });
        event.preventDefault();
      }
    } else if (event.key === 'End') {
      if (filteredCommits.length) {
        selectCommit(filteredCommits[filteredCommits.length - 1].hash, { scroll: true });
        event.preventDefault();
      }
    } else if (event.key === 'Enter') {
      openSelectedDiff();
      event.preventDefault();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
      if (!String(window.getSelection() || '')) {
        copyText(selectedHash);
      }
    }
  }

  boot();
})();
