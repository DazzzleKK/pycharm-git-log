/*
 * Commit graph lane layout.
 *
 * Input: commits in log order (newest first, topo order), each {hash, parents[]}.
 * Output: one row per commit with absolute geometry inside a row of height rowH:
 *   { lane, color, wasActive, node: {x, y, color}, shapes: [...] }
 *
 * The algorithm keeps a fixed lane per pending parent commit, so an edge is
 * always a vertical line in the target lane plus a short S-curve at the row
 * where it leaves its node. This is the same model used by PyCharm / GitKraken.
 */
(function (global) {
  'use strict';

  var PALETTE = [
    '#4f9cf7',
    '#d9a343',
    '#5cb85c',
    '#c678dd',
    '#e06c75',
    '#56b6c2',
    '#d19a66',
    '#9ecbff',
    '#b5cea8',
    '#f0a3c0',
  ];

  function computeGraph(commits, options) {
    options = options || {};
    var rowH = options.rowH || 24;
    var laneW = options.laneW || 14;
    var padX = options.padX == null ? 10 : options.padX;
    var radius = options.radius || 3.4;

    var lanes = []; // lane index -> pending commit hash (or null)
    var laneColor = [];
    var rows = [];
    var colorIndex = 0;
    var maxLanes = 1;

    function nextColor(except) {
      var color = PALETTE[0];
      var guard = 0;
      do {
        color = PALETTE[colorIndex % PALETTE.length];
        colorIndex++;
        guard++;
      } while (PALETTE.length > 1 && color === except && guard < PALETTE.length + 2);
      return color;
    }

    function freeLane() {
      var index = lanes.indexOf(null);
      return index >= 0 ? index : lanes.length;
    }

    function trim() {
      while (lanes.length && lanes[lanes.length - 1] === null) {
        lanes.pop();
        laneColor.pop();
      }
    }

    for (var i = 0; i < commits.length; i++) {
      var commit = commits[i];
      var lane = lanes.indexOf(commit.hash);
      var wasActive = lane >= 0;

      if (!wasActive) {
        lane = freeLane();
        lanes[lane] = commit.hash;
        laneColor[lane] = nextColor(null);
      }

      var color = laneColor[lane];
      var verticals = [];
      for (var l = 0; l < lanes.length; l++) {
        if (l !== lane && lanes[l] !== null && lanes[l] !== undefined) {
          verticals.push({ lane: l, color: laneColor[l] });
        }
      }

      // This commit's row consumes the lane; parents re-book it below.
      lanes[lane] = null;

      var edges = [];
      var parents = commit.parents || [];
      for (var p = 0; p < parents.length; p++) {
        var parent = parents[p];
        if (!parent) {
          continue;
        }
        var existing = lanes.indexOf(parent);
        if (existing >= 0 && existing !== lane) {
          // Another child already booked this parent; join that line instead
          // of drawing a duplicate lane.
          edges.push({ from: lane, to: existing, color: laneColor[existing] });
          continue;
        }
        if (p === 0) {
          lanes[lane] = parent;
          edges.push({ from: lane, to: lane, color: color });
        } else {
          var target = freeLane();
          lanes[target] = parent;
          laneColor[target] = nextColor(color);
          edges.push({ from: lane, to: target, color: laneColor[target] });
        }
      }

      trim();
      maxLanes = Math.max(maxLanes, lanes.length, lane + 1);
      rows.push({
        lane: lane,
        color: color,
        wasActive: wasActive,
        verticals: verticals,
        edges: edges,
      });
    }

    var width = padX * 2 + Math.max(0, maxLanes - 1) * laneW;

    for (var r = 0; r < rows.length; r++) {
      var info = rows[r];
      var nodeX = padX + info.lane * laneW;
      var nodeY = rowH / 2;
      var shapes = [];

      for (var v = 0; v < info.verticals.length; v++) {
        var vertical = info.verticals[v];
        var x = padX + vertical.lane * laneW;
        shapes.push({ type: 'line', x1: x, y1: 0, x2: x, y2: rowH, color: vertical.color });
      }

      if (info.wasActive) {
        shapes.push({ type: 'line', x1: nodeX, y1: 0, x2: nodeX, y2: nodeY, color: info.color });
      }

      for (var e = 0; e < info.edges.length; e++) {
        var edge = info.edges[e];
        var targetX = padX + edge.to * laneW;
        if (targetX === nodeX) {
          shapes.push({ type: 'line', x1: nodeX, y1: nodeY, x2: nodeX, y2: rowH, color: edge.color });
        } else {
          shapes.push({ type: 'curve', x1: nodeX, y1: nodeY, x2: targetX, y2: rowH, color: edge.color });
        }
      }

      info.node = { x: nodeX, y: nodeY, color: info.color };
      info.shapes = shapes;
      info.width = width;
      info.rowH = rowH;
      info.radius = radius;
    }

    return { rows: rows, width: width, maxLanes: maxLanes, rowH: rowH };
  }

  global.PyCharmGraph = { computeGraph: computeGraph };
})(typeof window !== 'undefined' ? window : globalThis);
