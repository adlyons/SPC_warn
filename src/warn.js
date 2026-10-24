// Storm tracking (cell + line), pathcast, recommended polygon, and the recommendation dialog.
var Warn = (function () {
  var W = { mode: null, phase: null, pts: [], line: [], lineT: null, past: null, motion: null, t1: null, T0: null,
    polygon: null, drag: null, issued: [], log: [], tracks: [], trackOnly: false, followId: null, followForm: null, open: false, diag: null, edited: false, seq: 0 };
  // Convective mode scheme of Smith et al. (2012) as used by Lyons et al. (SPC tornado mode climatology):
  // five categories with their sub-modes, plus RM/LM motion and mesocyclone strength for supercells.
  var CATS = [['SUP', 'Supercell'], ['MSUP', 'Marginal supercell'], ['QLCS', 'QLCS'], ['HYB', 'Supercell/QLCS hybrid'], ['DIS', 'Disorganized']];
  var CELL_SUBS = [['DC', 'Discrete cell'], ['CC', 'Cell in cluster'], ['CL', 'Cell in line']];
  var SUBS = { SUP: CELL_SUBS, MSUP: CELL_SUBS, QLCS: [['LINE', 'Line'], ['BOW', 'Bow echo']], HYB: [], DIS: [['DC', 'Discrete cell'], ['CC', 'Cell in cluster'], ['CLU', 'Cluster']] };
  function modeLabel(f) {
    var c = CATS.filter(function (x) { return x[0] === f.cat; })[0]; if (!c) return null;
    var sb = (SUBS[f.cat] || []).filter(function (x) { return x[0] === f.sub; })[0];
    var s = c[1] + (sb ? ', ' + sb[1].toLowerCase() : '');
    if ((f.cat === 'SUP' || f.cat === 'MSUP') && f.move) s = (f.move === 'LM' ? 'Left-moving ' : 'Right-moving ') + s.charAt(0).toLowerCase() + s.slice(1);
    if (f.cat === 'SUP' && f.meso) s += ' (' + f.meso + ' mesocyclone)';
    if (f.tc) s += ', tropical cyclone';
    return s;
  }
  var HAIL = [[0, 'None'], [0.75, 'Penny (0.75)'], [1.0, 'Quarter (1.00)'], [1.25, 'Half dollar (1.25)'], [1.5, 'Ping pong (1.50)'], [1.75, 'Golf ball (1.75)'],
    [2.0, 'Hen egg (2.00)'], [2.5, 'Tennis ball (2.50)'], [2.75, 'Baseball (2.75)'], [3.0, 'Tea cup (3.00)'], [4.0, 'Grapefruit (4.00)'], [4.5, 'Softball (4.50)']];
  var HAIL_WORD = { 0.75: 'Penny size', 1: 'Quarter size', 1.25: 'Half dollar size', 1.5: 'Ping pong ball size', 1.75: 'Golf ball size', 2: 'Hen egg size', 2.5: 'Tennis ball size', 2.75: 'Baseball size', 3: 'Tea cup size', 4: 'Grapefruit size', 4.5: 'Softball size' };
  var WIND = [0, 60, 70, 80, 90, 100];
  var KT = 1.943844, MPH = 2.236936;
  var COMPASS = ['north', 'north-northeast', 'northeast', 'east-northeast', 'east', 'east-southeast', 'southeast', 'south-southeast', 'south', 'south-southwest', 'southwest', 'west-southwest', 'west', 'west-northwest', 'northwest', 'north-northwest'];
  var SHORT = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  function $(id) { return document.getElementById(id); }
  function compass(deg, short) { var i = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16; return short ? SHORT[i] : COMPASS[i]; }

  function prompt(msg) { var el = $('prompt'); el.innerHTML = msg || ''; el.hidden = !msg; }
  function activeFrameTime() {
    var p = App.panels[App.active]; return p && p.frame ? p.frame.time : null;
  }
  function stepBackTo(t) {
    var p = App.panels[App.active]; var fr = frames(p.product, App.tilt); if (fr.length < 2) return false;
    var best = null, bd = Infinity;
    fr.forEach(function (f) { if (f.time < t - 60000) { var d = Math.abs(f.time - t); if (d < bd) { bd = d; best = f; } } });
    if (!best) return false;
    App.cursor = best.time; refreshAll(); return true;
  }

  function start(mode, trackOnly, followId) {
    if (!App.volumes.length) { toast('Wait for radar data to load first'); return; }
    if (W.open) closeDialog();
    W.trackOnly = !!trackOnly;
    W.followId = followId || null; if (!followId) W.followForm = null;
    W.mode = mode; W.pts = []; W.line = []; W.line2 = []; W.past = null; W.motion = null; W.polygon = null; W.edited = false;
    App.cursor = null; if (App.loopTimer) toggleLoop(); refreshAll();
    W.phase = mode === 'cell' ? 'cell' : 'line';
    prompt((W.trackOnly ? '<b>Storm track only (no polygon).</b> ' : W.followId ? '<b>Re-track ' + W.followId + '.</b> ' : '') + (mode === 'cell' ? '<b>Cell track.</b> Click the storm on the current scan.' :
      '<b>Line track.</b> Click points along the line on the current scan, then press <kbd>Enter</kbd>.'));
    redraw();
  }
  function cancel() {
    if (W.open) { closeDialog(); return; }
    if (W.phase) { W.phase = null; W.mode = null; W.pts = []; W.line = []; prompt(''); App.cursor = null; refreshAll(); redraw(); return; }
    $('help').hidden = true;
  }
  function clear() { W.phase = null; W.mode = null; W.pts = []; W.line = []; W.polygon = null; W.motion = null; W.tracks = []; prompt(''); if (W.open) closeDialog(); redraw(); toast('Tracks and polygon cleared'); }
  function clearTracks() { W.tracks = []; redraw(); toast('Your storm tracks were cleared'); if (App.panels.some(function (p) { return p.product === 'SRV'; })) refreshAll(); }
  // Saved track under the mouse (its current position or any pathcast point), for Shift-click to polygon.
  function pickTrack(panel, pt) {
    var tnow = issueTime(), best = -1, bd = 14;
    W.tracks.forEach(function (tr, i) {
      for (var k = 0; k <= 4; k++) trackAt(tnow + k * 15 * 60000, tr).forEach(function (p) {
        var q = panel.map.project([p.lon, p.lat]), d = Math.hypot(q.x - pt.x, q.y - pt.y); if (d < bd) { bd = d; best = i; }
      });
    });
    return best;
  }
  // Build a recommendation polygon from a SCIT cell: current NST position and its 15-minute forecast position.
  function fromScit(s, d) {
    if (!s.fcst.length) { toast('SCIT cell ' + s.id + ' has no forecast track'); return; }
    if (W.open) closeDialog();
    var ref = { lat: d.lat, lon: d.lon }, pos = Geo.fromXY(ref, s.pos[0] * 1000, s.pos[1] * 1000);
    var u = (s.fcst[0][0] - s.pos[0]) * 1000 / 900, v = (s.fcst[0][1] - s.pos[1]) * 1000 / 900;
    W.mode = 'cell'; W.phase = null; W.trackOnly = false; W.followId = null; W.followForm = null; W.line = []; W.line2 = []; W.past = null;
    W.pts = [{ lat: pos.lat, lon: pos.lon, t: d.time }];
    W.motion = { from: (Math.atan2(u, v) * 180 / Math.PI + 180 + 360) % 360, kt: Math.hypot(u, v) * KT }; W.t1 = d.time; W.scitId = s.id;
    W.T0 = issueTime(); computeDiag();
    build(recommend(autoMode(), W.diag.vrot).duration);
    openDialog(true);
    toast('Polygon built from SCIT cell ' + s.id + ' (' + Math.round(W.motion.from) + '°/' + Math.round(W.motion.kt) + ' kt). Edit motion or corners as needed.');
  }
  // Turn a saved manual (G) track into a recommendation; defaults to the most recent one.
  function warnFromTrack(idx) {
    if (idx == null) idx = W.tracks.length - 1;
    var tr = W.tracks[idx]; if (!tr) return false;
    if (W.open) closeDialog();
    W.phase = null; W.trackOnly = false; W.followId = null; W.followForm = null; W.scitId = null;
    W.mode = tr.mode; W.pts = tr.pts.slice(); W.line = tr.line.slice(); W.line2 = (tr.line2 || []).slice(); W.lineT = tr.lineT; W.past = tr.past; W.motion = { from: tr.motion.from, kt: tr.motion.kt }; W.t1 = tr.t1;
    W.tracks.splice(idx, 1);
    W.T0 = issueTime(); computeDiag();
    build(recommend(autoMode(), W.diag.vrot).duration);
    openDialog(true);
    return true;
  }

  function onClick(panel, e) {
    if (!W.phase || W.drag != null) return;
    var t = activeFrameTime(); if (t == null) { toast('No scan shown in this panel'); return; }
    var pt = { lat: e.lngLat.lat, lon: e.lngLat.lng, t: t };
    if (W.phase === 'cell') {
      W.pts = W.pts.filter(function (q) { return Math.abs(q.t - t) > 30000; });
      W.pts.push(pt); W.pts.sort(function (a, b) { return a.t - b.t; });
      if (W.pts.length === 1) {
        var back = stepBackTo(t - 15 * 60000);
        prompt(back ? '<b>Cell track.</b> Now click the same storm on this earlier scan. Use <kbd>←</kbd> <kbd>→</kbd> to pick another scan.' :
          '<b>Cell track.</b> Only one scan is loaded so far. Step back with <kbd>←</kbd> when older scans arrive, then click the storm.');
      } else if (!e.originalEvent.shiftKey) finish();
      else prompt('<b>Cell track.</b> ' + W.pts.length + ' positions. Shift-click to add more, <kbd>Enter</kbd> to finish.');
    } else if (W.phase === 'line') {
      if (W.line.length && Math.abs(W.lineT - t) > 30000) { toast('Click all points of the current line on the same scan'); return; }
      W.lineT = t; W.line.push(pt);
      prompt('<b>Line track, line 1 of 2 (now).</b> ' + W.line.length + ' point' + (W.line.length > 1 ? 's' : '') + '. Keep tracing the leading edge, <kbd>Enter</kbd> when done.');
    } else if (W.phase === 'linepast') {
      if (Math.abs(t - W.lineT) < 60000) { toast('Step back to an earlier scan with ← first'); return; }
      if (W.line2.length && Math.abs(W.line2T - t) > 30000) { toast('Click all points of the earlier line on the same scan'); return; }
      W.line2T = t; W.line2.push(pt);
      prompt('<b>Line track, line 2 of 2 (earlier scan).</b> ' + W.line2.length + ' point' + (W.line2.length > 1 ? 's' : '') + '. Trace the same leading edge, <kbd>Enter</kbd> when done.');
    }
    redraw();
  }
  function enter() {
    if (W.phase === 'line') {
      if (W.line.length < 2) { toast('Click at least two points along the line'); return; }
      W.phase = 'linepast'; W.line2 = [];
      var back = stepBackTo(W.lineT - 15 * 60000);
      prompt('<b>Line track, line 2 of 2.</b> Trace the same leading edge on this earlier scan, then <kbd>Enter</kbd>.' + (back ? '' : ' Step back with <kbd>←</kbd> first.'));
      redraw();
    } else if (W.phase === 'linepast') {
      if (W.line2.length < 2) { toast('Trace at least two points of the earlier line'); return; }
      finish();
    } else if (W.phase === 'cell' && W.pts.length >= 2) finish();
    else if (W.polygon && !W.open) openDialog();
  }
  function lineCenter() {
    var la = 0, lo = 0; W.line.forEach(function (p) { la += p.lat; lo += p.lon; });
    return { lat: la / W.line.length, lon: lo / W.line.length };
  }
  function finish() {
    var vx, vy, ref;
    if (W.mode === 'cell') {
      ref = W.pts[W.pts.length - 1];
      var n = W.pts.length, mt = 0, mx = 0, my = 0, xy = W.pts.map(function (p) { return Geo.toXY(ref, p.lat, p.lon); });
      W.pts.forEach(function (p, i) { mt += p.t / 1000; mx += xy[i][0]; my += xy[i][1]; });
      mt /= n; mx /= n; my /= n;
      var stt = 0, stx = 0, sty = 0;
      W.pts.forEach(function (p, i) { var dt = p.t / 1000 - mt; stt += dt * dt; stx += dt * (xy[i][0] - mx); sty += dt * (xy[i][1] - my); });
      vx = stx / stt; vy = sty / stt; W.t1 = ref.t;
    } else {
      // motion = mean displacement of each current-line vertex from the nearest point on the earlier line
      ref = lineCenter();
      var old = W.line2.map(function (p) { return Geo.toXY(ref, p.lat, p.lon); }), sx = 0, sy = 0, dt2 = (W.lineT - W.line2T) / 1000;
      W.line.forEach(function (p) {
        var q = Geo.toXY(ref, p.lat, p.lon), best = null, bd = Infinity;
        for (var i = 0; i < old.length - 1; i++) {
          var a = old[i], b = old[i + 1], ex = b[0] - a[0], ey = b[1] - a[1], L2 = ex * ex + ey * ey || 1;
          var tt = Math.max(0, Math.min(1, ((q[0] - a[0]) * ex + (q[1] - a[1]) * ey) / L2)), nx = a[0] + tt * ex, ny = a[1] + tt * ey, dd = Math.hypot(q[0] - nx, q[1] - ny);
          if (dd < bd) { bd = dd; best = [q[0] - nx, q[1] - ny]; }
        }
        sx += best[0]; sy += best[1];
      });
      vx = sx / W.line.length / dt2; vy = sy / W.line.length / dt2; W.t1 = W.lineT;
      W.past = { lat: lineCenter2(W.line2).lat, lon: lineCenter2(W.line2).lon, t: W.line2T };
    }
    var spd = Math.sqrt(vx * vx + vy * vy);
    W.motion = { from: (Math.atan2(vx, vy) * 180 / Math.PI + 180 + 360) % 360, kt: spd * KT };
    W.phase = null; prompt('');
    App.cursor = null; refreshAll();
    if (W.trackOnly) {
      W.tracks.push({ mode: W.mode, pts: W.pts.slice(), line: W.line.slice(), line2: (W.line2 || []).slice(), lineT: W.lineT, past: W.past, motion: W.motion, t1: W.t1 });
      W.mode = null; W.pts = []; W.line = []; W.past = null; W.motion = null; W.trackOnly = false;
      var tr = W.tracks[W.tracks.length - 1];
      toast('Track saved: from ' + Math.round(tr.motion.from) + '° at ' + Math.round(tr.motion.kt) + ' kt. Shift-click it (or press D) to make a recommendation polygon from it. Shift+X clears tracks.');
      redraw(); return;
    }
    W.T0 = issueTime();
    computeDiag();
    var r = recommend(autoMode(), W.diag.vrot);
    build(r.duration);
    openDialog(true);
  }
  function issueTime() {
    var lt = latestDataTime();
    return Date.now() - lt < 30 * 60000 ? Date.now() : lt;
  }
  function vel(tr) { // m/s vector toward
    tr = tr || W;
    var to = (tr.motion.from + 180) * Math.PI / 180, s = tr.motion.kt / KT;
    return [Math.sin(to) * s, Math.cos(to) * s];
  }
  // Track geometry at time t (ms): list of points
  function trackAt(t, tr) {
    tr = tr || W;
    var v = vel(tr), dt = (t - tr.t1) / 1000;
    var base = tr.mode === 'cell' ? [tr.pts[tr.pts.length - 1]] : tr.line;
    return base.map(function (p) { var q = Geo.toXY(p, p.lat, p.lon); return Geo.fromXY(p, q[0] + v[0] * dt, q[1] + v[1] * dt); });
  }
  function hull(pts) {
    pts = pts.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
    var lo = [], up = [];
    pts.forEach(function (p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); });
    for (var i = pts.length - 1; i >= 0; i--) { var p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    up.pop(); lo.pop(); return lo.concat(up);
  }
  function build(durMin) {
    W.dur = durMin || W.dur || 45;
    var origin = trackAt(W.T0), ref = origin[0], v = vel(), sp = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    var u = sp > 0.5 ? [v[0] / sp, v[1] / sp] : [0, 1], n = [-u[1], u[0]], D = W.dur * 60, L = sp * D;
    var pts = [];
    if (W.mode === 'cell') {
      var w0 = 6000, w1 = w0 + Math.max(L, 8000) * Math.tan(16 * Math.PI / 180) + 2000;
      var b = [-u[0] * 5000, -u[1] * 5000], f = [v[0] * D + u[0] * 6000, v[1] * D + u[1] * 6000];
      pts = [[b[0] + n[0] * w0, b[1] + n[1] * w0], [f[0] + n[0] * w1, f[1] + n[1] * w1], [f[0] - n[0] * w1, f[1] - n[1] * w1], [b[0] - n[0] * w0, b[1] - n[1] * w0]];
    } else {
      var xy = origin.map(function (p) { return Geo.toXY(ref, p.lat, p.lon); });
      var a0 = xy[0], a1 = xy[xy.length - 1], el = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]) || 1, e = [(a1[0] - a0[0]) / el, (a1[1] - a0[1]) / el];
      var flare = L * Math.tan(12 * Math.PI / 180) + 4000;
      xy.forEach(function (p) {
        pts.push([p[0] - u[0] * 6000, p[1] - u[1] * 6000]);
        pts.push([p[0] + v[0] * D + u[0] * 6000, p[1] + v[1] * D + u[1] * 6000]);
      });
      pts.push([a0[0] - e[0] * 4000 - u[0] * 6000, a0[1] - e[1] * 4000 - u[1] * 6000]);
      pts.push([a1[0] + e[0] * 4000 - u[0] * 6000, a1[1] + e[1] * 4000 - u[1] * 6000]);
      pts.push([a0[0] + v[0] * D - e[0] * flare, a0[1] + v[1] * D - e[1] * flare]);
      pts.push([a1[0] + v[0] * D + e[0] * flare, a1[1] + v[1] * D + e[1] * flare]);
      pts = hull(pts);
    }
    W.polygon = pts.slice(0, 20).map(function (p) { return Geo.fromXY(ref, p[0], p[1]); });
    W.edited = false;
    redraw();
  }

  // ---------- diagnostics ----------
  function lowestFrame(prod) {
    var ts = tilts();
    for (var i = 0; i < ts.length; i++) { var fr = frames(prod, ts[i]); if (fr.length) return fr[fr.length - 1]; }
    return null;
  }
  function computeDiag() {
    var refF = lowestFrame('REF'), velF = lowestFrame('VEL'), d = { maxRef: null, vrot: null, maxVel: null, range: null, beam: null, rotAt: null };
    function posAt(f) { return f ? trackAt(f.time) : []; }
    posAt(refF).forEach(function (p) { var s = scanArea(refF, p.lat, p.lon, 8000); if (s && (d.maxRef == null || s.max > d.maxRef)) d.maxRef = s.max; });
    posAt(velF).forEach(function (p) {
      var s = scanArea(velF, p.lat, p.lon, 7000);
      if (s && s.max > 0 && s.min < 0) {
        var vr = (s.max - s.min) / 2;
        if (d.vrot == null || vr > d.vrot) { d.vrot = vr; d.rotAt = { lat: (s.maxAt.lat + s.minAt.lat) / 2, lon: (s.maxAt.lon + s.minAt.lon) / 2 }; }
      }
      var s2 = scanArea(velF, p.lat, p.lon, 10000);
      if (s2) d.maxVel = Math.max(d.maxVel || 0, Math.abs(s2.max), Math.abs(s2.min));
    });
    var o = trackAt(W.T0)[0];
    if (App.radar && o) {
      var rm = Geo.dist(App.radar.lat, App.radar.lon, o.lat, o.lon);
      d.range = rm / 1852;
      var el = velF ? velF.sweep.elev : 0.5;
      d.beam = beamHeightFt(rm / Math.cos(el * Math.PI / 180), el);
      d.beamArl = d.beam - App.radar.height * 3.28084;
    }
    d.refTime = refF && refF.time; d.velTime = velF && velF.time;
    W.diag = d;
  }
  function autoMode() { // placeholder first guess until automated mode classification is wired in
    var d = W.diag || {}, v = d.vrot || 0, ref = d.maxRef || 0;
    if (W.mode === 'line') return v >= 25 ? { cat: 'HYB', sub: '' } : { cat: 'QLCS', sub: 'LINE' };
    if (v >= 20 && ref >= 50) return { cat: 'SUP', sub: 'DC' };
    if (v >= 12 && ref >= 45) return { cat: 'MSUP', sub: 'DC' };
    return { cat: 'DIS', sub: ref >= 55 ? 'CC' : 'DC' };
  }

  // ---------- recommendation engine (placeholder rules; swap for the real storm-mode / VROT guidance) ----------
  function recommend(mode, vrot) {
    var d = W.diag || {}, ref = d.maxRef || 0, mv = d.maxVel || 0, why = [];
    var cat = mode.cat, supercell = cat === 'SUP', qlcs = cat === 'QLCS' || cat === 'HYB', bow = cat === 'QLCS' && mode.sub === 'BOW';
    var hail = ref >= 70 ? 2.75 : ref >= 65 ? 1.75 : ref >= 60 ? 1.25 : ref >= 55 ? 1.0 : ref >= 50 ? 0.75 : 0;
    if (supercell && hail > 0 && hail < 1.75) { hail = hail < 1 ? 1.0 : hail < 1.25 ? 1.25 : 1.75; why.push('Supercell mode bumps hail one size.'); }
    if (qlcs && hail > 1.0) hail = 1.0;
    if (ref) why.push('Max reflectivity near storm ' + Math.round(ref) + ' dBZ → ' + (hail ? hail.toFixed(2) + ' in hail' : 'no hail tag') + '.');
    var wind = qlcs ? 70 : 60;
    if (mv >= 70) wind = 80; else if (mv >= 55) wind = Math.max(wind, 70);
    if (mv) why.push('Max low-level velocity within 10 km ' + Math.round(mv) + ' kt → ' + wind + ' mph gusts.');
    if (bow && wind < 70) { wind = 70; why.push('Bow echo → at least 70 mph gusts.'); }
    var tor = false, torPossible = false, torDmg = '', range = d.range || 0;
    if (vrot != null && !isNaN(vrot)) {
      var adj = range > 60 ? -5 : 0; // farther ranges sample broader, weaker rotation
      var TT = { SUP: [40, 30], MSUP: [45, 30], QLCS: [35, 25], HYB: [35, 25], DIS: [50, 35] }[cat] || [45, 30];
      var tTor = TT[0], tPoss = TT[1];
      if (supercell && mode.meso === 'strong') { tTor -= 5; why.push('Strong mesocyclone lowers the tornado VROT threshold by 5 kt.'); }
      if (vrot >= tTor + adj) { tor = true; why.push('VROT ' + Math.round(vrot) + ' kt ≥ ' + (tTor + adj) + ' kt for this mode → Tornado Warning.'); }
      else if (vrot >= tPoss + adj) { torPossible = true; why.push('VROT ' + Math.round(vrot) + ' kt → add TORNADO...POSSIBLE.'); }
      if (tor && vrot >= 55) { torDmg = 'CONSIDERABLE'; why.push('VROT ≥ 55 kt → considerable tornado damage threat.'); }
    }
    var svrDmg = hail >= 2.75 || wind >= 80 ? 'DESTRUCTIVE' : hail >= 1.75 || wind >= 70 ? 'CONSIDERABLE' : '';
    var type = tor ? 'TOR' : 'SVR';
    if (!tor && ref < 50 && mv < 50) why.push('Radar signal is marginal for severe criteria. Check before issuing.');
    var duration = tor ? (qlcs ? 30 : 45) : (W.mode === 'line' ? 60 : 45);
    return { type: type, hail: hail, wind: wind, torPossible: torPossible, torDmg: torDmg, svrDmg: svrDmg, duration: duration, why: why };
  }

  // ---------- dialog ----------
  function buildDialogDom() {
    var m = $('f-mode');
    CATS.forEach(function (x) { var l = document.createElement('label'); l.className = 'chip'; l.innerHTML = '<input type="radio" name="smode" value="' + x[0] + '"><span>' + x[1] + '</span>'; m.appendChild(l); });
    var h = $('f-hail'); HAIL.forEach(function (x) { var o = document.createElement('option'); o.value = x[0]; o.textContent = x[1]; h.appendChild(o); });
    var w = $('f-wind'); WIND.forEach(function (x) { var o = document.createElement('option'); o.value = x; o.textContent = x ? x + ' mph' : 'None'; w.appendChild(o); });
    var dlg = $('warn');
    dlg.addEventListener('input', onDialogInput);
    dlg.addEventListener('change', onDialogInput);
    $('btn-issue').addEventListener('click', issue);
    $('btn-close').addEventListener('click', closeDialog);
    $('btn-apply').addEventListener('click', function () { dlg.querySelectorAll('[data-user]').forEach(function (e) { delete e.dataset.user; }); applyRec(true); });
    $('btn-copy').addEventListener('click', function () {
      var t = $('w-text').textContent;
      (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { toast('Product text copied'); }, function () {
        var r = document.createRange(); r.selectNodeContents($('w-text')); var s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Text selected, press Ctrl+C');
      });
    });
    $('btn-retrack').addEventListener('click', function () { var m = W.mode; closeDialog(); start(m); });
  }
  function renderSubs(cat, sel) {
    var host = $('f-sub'); host.innerHTML = '';
    (SUBS[cat] || []).forEach(function (x, i) {
      var l = document.createElement('label'); l.className = 'chip';
      l.innerHTML = '<input type="radio" name="ssub" value="' + x[0] + '"' + ((sel ? sel === x[0] : i === 0) ? ' checked' : '') + '><span>' + x[1] + '</span>';
      host.appendChild(l);
    });
    $('f-subwrap').hidden = !(SUBS[cat] || []).length;
    $('f-supwrap').hidden = !(cat === 'SUP' || cat === 'MSUP');
    $('f-mesowrap').hidden = cat !== 'SUP';
  }
  function setForm(f) {
    function mark(id) { var e = $(id); if (e) e.dataset.user = '1'; }
    setRadio('wtype', f.type); mark('f-type');
    if (f.cat) { setRadio('smode', f.cat); renderSubs(f.cat, f.sub); mark('f-mode'); }
    if (f.move) setRadio('smove', f.move);
    $('f-meso').value = f.meso || ''; $('f-tc').checked = !!f.tc;
    [['f-hail', String(f.hail)], ['f-hailsrc', f.hailsrc], ['f-wind', String(f.wind)], ['f-windsrc', f.windsrc], ['f-svrdmg', f.svrdmg], ['f-torsrc', f.torsrc], ['f-tordmg', f.tordmg]].forEach(function (x) { if (x[1] != null) { $(x[0]).value = x[1]; mark(x[0]); } });
    $('f-torposs').checked = !!f.torposs; mark('f-torposs');
    if (f.vrot !== '' && f.vrot != null) $('f-vrot').value = f.vrot;
    syncTypeVisibility(); applyRec(false);
  }
  function getVal(name) {
    var el = document.querySelector('#warn [name="' + name + '"]:checked'); return el ? el.value : null;
  }
  function setRadio(name, val) { document.querySelectorAll('#warn [name="' + name + '"]').forEach(function (e) { e.checked = e.value === String(val); }); }
  function isUser(id) { var e = $(id); return e && e.dataset.user === '1'; }
  function onDialogInput(e) {
    var t = e.target, id = t.id || ('r-' + t.name);
    if (e.isTrusted) { if (t.id) t.dataset.user = '1'; else { var g = $({ smode: 'f-mode', ssub: 'f-sub', smove: 'f-move' }[t.name] || ('f-' + t.name)); if (g) g.dataset.user = '1'; } }
    if (t.name === 'smode') renderSubs(getVal('smode'), null);
    if (t.id === 'f-dir' || t.id === 'f-spd' || t.id === 'f-dur') {
      var dir = parseFloat($('f-dir').value), spd = parseFloat($('f-spd').value);
      if (!isNaN(dir) && !isNaN(spd)) { W.motion = { from: dir, kt: spd }; build(parseInt($('f-dur').value, 10)); computeDiag(); }
    }
    if (t.name === 'smode' || t.name === 'ssub' || t.id === 'f-vrot' || t.id === 'f-meso') applyRec(false);
    syncTypeVisibility();
    updateText();
  }
  function currentRec() {
    var v = parseFloat($('f-vrot').value);
    return recommend(getVal('smode') ? { cat: getVal('smode'), sub: getVal('ssub'), meso: $('f-meso').value } : autoMode(), isNaN(v) ? null : v);
  }
  function applyRec(all) {
    var r = currentRec();
    if (all || !isUser('f-type')) setRadio('wtype', r.type);
    if (all || !isUser('f-hail')) $('f-hail').value = String(r.hail);
    if (all || !isUser('f-wind')) $('f-wind').value = String(r.wind);
    if (all || !isUser('f-torposs')) $('f-torposs').checked = r.torPossible;
    if (all || !isUser('f-svrdmg')) $('f-svrdmg').value = r.svrDmg;
    if (all || !isUser('f-tordmg')) $('f-tordmg').value = r.torDmg;
    if (all) { $('f-dur').value = String(r.duration); build(r.duration); }
    var box = $('rec');
    box.innerHTML = '<div class="rechead">Recommended: <b class="t-' + r.type + '">' + (r.type === 'TOR' ? 'Tornado Warning' : 'Severe Thunderstorm Warning') + '</b>' +
      (r.type === 'SVR' && r.torPossible ? ' · <b>TORNADO POSSIBLE</b>' : '') + (r.svrDmg && r.type === 'SVR' ? ' · ' + r.svrDmg : '') + (r.torDmg && r.type === 'TOR' ? ' · ' + r.torDmg : '') +
      ' · ' + r.duration + ' min</div><ul>' + r.why.map(function (w) { return '<li>' + w + '</li>'; }).join('') + '</ul>';
    syncTypeVisibility();
    updateText();
  }
  function syncTypeVisibility() {
    var tor = getVal('wtype') === 'TOR';
    document.querySelectorAll('.svr-only').forEach(function (e) { e.hidden = tor; });
    document.querySelectorAll('.tor-only').forEach(function (e) { e.hidden = !tor; });
    $('warn').dataset.type = tor ? 'TOR' : 'SVR';
  }
  function openDialog(fresh) {
    if (!W.polygon) { if (!fresh && warnFromTrack()) return; toast('Track a storm first: T for a cell, L for a line, or Shift-click a SCIT cell'); return; }
    W.open = true; $('warn').hidden = false;
    if (fresh) {
      $('warn').querySelectorAll('[data-user]').forEach(function (e) { delete e.dataset.user; });
      $('f-dir').value = Math.round(W.motion.from); $('f-spd').value = Math.round(W.motion.kt);
      var am = autoMode(); setRadio('smode', am.cat); renderSubs(am.cat, am.sub); setRadio('smove', 'RM'); $('f-meso').value = ''; $('f-tc').checked = false;
      $('f-vrot').value = W.diag.vrot != null ? Math.round(W.diag.vrot) : '';
      $('f-hailsrc').value = 'RADAR INDICATED'; $('f-windsrc').value = 'RADAR INDICATED'; $('f-torsrc').value = 'RADAR INDICATED';
      applyRec(true);
      if (W.followForm) setForm(W.followForm);
    }
    $('w-title').textContent = W.followId ? 'Update ' + W.followId : 'Recommendation';
    $('btn-issue').firstChild.textContent = W.followId ? 'Issue update' : 'Issue';
    var d = W.diag || {};
    $('diag').innerHTML = [
      ['Motion', Math.round(W.motion.from) + '° at ' + Math.round(W.motion.kt) + ' kt'],
      ['Max REF', d.maxRef != null ? Math.round(d.maxRef) + ' dBZ' : '—'],
      ['Auto VROT', d.vrot != null ? Math.round(d.vrot) + ' kt' : '—'],
      ['Max |V|', d.maxVel != null ? Math.round(d.maxVel) + ' kt' : '—'],
      ['Range', d.range != null ? d.range.toFixed(0) + ' nm' : '—'],
      ['Beam ht', d.beam != null ? (d.beam / 1000).toFixed(1) + ' kft' : '—']
    ].map(function (x) { return '<div><span>' + x[0] + '</span><b>' + x[1] + '</b></div>'; }).join('');
    updateText(); redraw();
  }
  function closeDialog() { W.open = false; $('warn').hidden = true; redraw(); }
  function dialogKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeDialog(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); issue(); }
  }

  // ---------- product text ----------
  function localTime(t, withDay) {
    var d = new Date(t);
    var s = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).replace(':', '').replace(/\s+/g, ' ');
    if (withDay) s += ' ' + d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).replace(/,/g, '');
    return s;
  }
  function pip(pt, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var a = poly[i], b = poly[j];
      if ((a.lat > pt.lat) !== (b.lat > pt.lat) && pt.lon < (b.lon - a.lon) * (pt.lat - a.lat) / (b.lat - a.lat) + a.lon) inside = !inside;
    }
    return inside;
  }
  function bbox(poly) {
    var b = [180, 90, -180, -90]; poly.forEach(function (p) { b[0] = Math.min(b[0], p.lon); b[1] = Math.min(b[1], p.lat); b[2] = Math.max(b[2], p.lon); b[3] = Math.max(b[3], p.lat); });
    return b;
  }
  function counties(poly) {
    var bb = bbox(poly), out = [];
    GEO.cpoly.counties.forEach(function (c) {
      var hit = false;
      c[2].forEach(function (ring) {
        if (hit) return;
        for (var i = 0; i < ring.length && !hit; i += 2) { var q = ring[i]; if (q[0] >= bb[0] && q[0] <= bb[2] && q[1] >= bb[1] && q[1] <= bb[3] && pip({ lat: q[1], lon: q[0] }, poly)) hit = true; }
        if (!hit) poly.forEach(function (p) { if (!hit && pipRing(p, ring)) hit = true; });
      });
      if (hit) out.push(c[1] + ' County in ' + (GEO.cpoly.states[c[0].slice(0, 2)] || ''));
    });
    return out;
  }
  function pipRing(p, ring) { return pip(p, ring.map(function (q) { return { lat: q[1], lon: q[0] }; })); }
  function nearestPlace(pt) {
    var best = null, bd = Infinity;
    PLACES.forEach(function (c) { if (Math.abs(c[2] - pt.lat) > 0.6 || Math.abs(c[3] - pt.lon) > 0.8) return; var d = Geo.dist(pt.lat, pt.lon, c[2], c[3]); if (d < bd) { bd = d; best = c; } });
    if (!best) return 'near ' + pt.lat.toFixed(2) + ', ' + Math.abs(pt.lon).toFixed(2) + 'W';
    var mi = bd / 1609.34;
    if (mi < 2.5) return 'over ' + best[0];
    return 'near ' + best[0] + ', or ' + Math.round(mi) + ' miles ' + compass(Geo.bearing(best[2], best[3], pt.lat, pt.lon)) + ' of ' + best[0];
  }
  function pathcastPlaces() {
    if (!W.polygon) return [];
    var bb = bbox(W.polygon), origin = trackAt(W.T0), v = vel(), sp = Math.hypot(v[0], v[1]) || 0.1, u = [v[0] / sp, v[1] / sp], out = [];
    PLACES.forEach(function (c) {
      if (c[3] < bb[0] || c[3] > bb[2] || c[2] < bb[1] || c[2] > bb[3]) return;
      var pt = { lat: c[2], lon: c[3] }; if (!pip(pt, W.polygon)) return;
      var s = Infinity;
      origin.forEach(function (o) { var q = Geo.toXY(o, pt.lat, pt.lon); var along = q[0] * u[0] + q[1] * u[1], lat = Math.abs(q[0] * u[1] - q[1] * u[0]); if (lat < 25000 || origin.length === 1) s = Math.min(s, along); });
      if (s === Infinity) { var q0 = Geo.toXY(origin[0], pt.lat, pt.lon); s = q0[0] * u[0] + q0[1] * u[1]; }
      out.push({ name: c[0], st: c[1], eta: W.T0 + Math.max(0, s / sp) * 1000 });
    });
    out.sort(function (a, b) { return a.eta - b.eta; });
    return out;
  }
  function form() {
    return { type: getVal('wtype') || 'SVR', cat: getVal('smode'), sub: getVal('ssub') || '', move: getVal('smove'), meso: $('f-meso').value, tc: $('f-tc').checked, dur: parseInt($('f-dur').value, 10) || 45,
      hail: parseFloat($('f-hail').value) || 0, hailsrc: $('f-hailsrc').value, wind: parseInt($('f-wind').value, 10) || 0, windsrc: $('f-windsrc').value,
      torposs: $('f-torposs').checked, svrdmg: $('f-svrdmg').value, torsrc: $('f-torsrc').value, tordmg: $('f-tordmg').value,
      vrot: $('f-vrot').value };
  }
  function productText(f) {
    var T0 = W.T0, end = T0 + f.dur * 60000, tor = f.type === 'TOR';
    var origin = trackAt(T0), o = W.mode === 'cell' ? origin[0] : lineCenter2(origin);
    var noun = tor ? (f.torsrc === 'OBSERVED' ? 'a confirmed tornado' : 'a severe thunderstorm capable of producing a tornado')
      : (W.mode === 'line' ? 'a line of severe thunderstorms' : 'a severe thunderstorm');
    var moving = 'moving ' + compass(W.motion.from + 180) + ' at ' + Math.round(W.motion.kt * 1.15078) + ' mph';
    var where = W.mode === 'line' ? 'extending from ' + nearestPlace(origin[0]).replace(/^(near|over) /, '') + ' to ' + nearestPlace(origin[origin.length - 1]).replace(/^(near|over) /, '') : 'located ' + nearestPlace(o);
    var hazard = [];
    if (tor) hazard.push('Tornado' + (f.hail ? ' and ' + (HAIL_WORD[f.hail] || f.hail + ' inch').toLowerCase() + ' hail' : ''));
    else {
      if (f.wind) hazard.push(f.wind + ' mph wind gusts');
      if (f.hail) hazard.push((HAIL_WORD[f.hail] || f.hail + ' inch') + ' hail');
    }
    var src = tor ? (f.torsrc === 'OBSERVED' ? 'Weather spotters confirmed tornado.' : 'Radar indicated rotation.')
      : (f.hailsrc === 'OBSERVED' || f.windsrc === 'OBSERVED' ? 'Public reports.' : 'Radar indicated.');
    var impact = tor ? (f.tordmg === 'CATASTROPHIC' ? 'You are in a life-threatening situation. Mass devastation is highly likely.' :
      f.tordmg === 'CONSIDERABLE' ? 'Considerable damage to homes, businesses, and vehicles is likely and complete destruction is possible.' :
      'Flying debris will be dangerous to those caught without shelter. Mobile homes will be damaged or destroyed. Damage to roofs, windows, and vehicles will occur. Tree damage is likely.')
      : (f.svrdmg === 'DESTRUCTIVE' ? 'Wind damage will be extensive. Large hail will destroy roofs and windows and injure people outdoors.' :
        f.hail >= 1.75 ? 'People and animals outdoors will be injured. Expect hail damage to roofs, siding, windows, and vehicles.' :
        f.wind >= 70 ? 'Expect considerable damage to roofs, siding, and trees.' : 'Hail damage to vehicles is expected. Expect wind damage to roofs, siding, and trees.');
    var cs = counties(W.polygon), pc = pathcastPlaces();
    var L = [];
    L.push(tor ? 'Tornado Warning' : 'Severe Thunderstorm Warning');
    L.push('National Weather Service (draft from ' + (App.radar ? App.radar.site : '') + ')');
    L.push(localTime(T0, true).toUpperCase());
    L.push('');
    L.push('The National Weather Service has issued a');
    L.push('');
    L.push('* ' + (tor ? 'Tornado Warning' : 'Severe Thunderstorm Warning') + ' for...');
    (cs.length ? cs : ['(no counties found)']).forEach(function (c) { L.push('  ' + c + '...'); });
    L.push('');
    L.push('* Until ' + localTime(end) + '.');
    L.push('');
    L.push('* At ' + localTime(T0) + ', ' + noun + ' was ' + where + ', ' + moving + '.');
    L.push('');
    L.push('  HAZARD...' + (hazard.join(' and ') || 'Severe thunderstorm') + '.');
    L.push('');
    L.push('  SOURCE...' + src);
    L.push('');
    L.push('  IMPACT...' + impact);
    L.push('');
    if (pc.length) {
      L.push('* Locations impacted include...');
      var byTime = [];
      pc.slice(0, 40).forEach(function (p) {
        var lab = localTime(Math.ceil(p.eta / 300000) * 300000), last = byTime[byTime.length - 1];
        if (last && last.t === lab) last.n.push(p.name); else byTime.push({ t: lab, n: [p.name] });
      });
      byTime.forEach(function (g) { L.push('  ' + g.n.join(', ') + ' around ' + g.t + '.'); });
      if (pc.length > 40) L.push('  Other locations impacted include ' + pc.slice(40, 60).map(function (p) { return p.name; }).join(', ') + '.');
      L.push('');
    }
    if (f.type === 'SVR' && f.torposs) { L.push('Tornadoes are possible with this storm. If a tornado warning is issued, take shelter immediately.'); L.push(''); }
    L.push('LAT...LON ' + W.polygon.map(function (p) { return Math.round(p.lat * 100) + ' ' + Math.round(Math.abs(p.lon) * 100); }).join(' '));
    var tz = new Date(T0);
    L.push('TIME...MOT...LOC ' + String(tz.getUTCHours()).padStart(2, '0') + String(tz.getUTCMinutes()).padStart(2, '0') + 'Z ' +
      String(Math.round(W.motion.from)).padStart(3, '0') + 'DEG ' + Math.round(W.motion.kt) + 'KT ' + origin.map(function (p) { return Math.round(p.lat * 100) + ' ' + Math.round(Math.abs(p.lon) * 100); }).join(' '));
    L.push('');
    if (tor) {
      L.push('TORNADO...' + (f.torsrc === 'OBSERVED' ? 'OBSERVED' : 'RADAR INDICATED'));
      if (f.tordmg) L.push('TORNADO DAMAGE THREAT...' + f.tordmg);
      L.push('MAX HAIL SIZE...' + f.hail.toFixed(2) + ' IN');
    } else {
      if (f.torposs) L.push('TORNADO...POSSIBLE');
      if (f.svrdmg) L.push('THUNDERSTORM DAMAGE THREAT...' + f.svrdmg);
      L.push('MAX HAIL SIZE...' + f.hail.toFixed(2) + ' IN');
      L.push('HAIL THREAT...' + f.hailsrc);
      L.push('MAX WIND GUST...' + (f.wind || 50) + ' MPH');
      L.push('WIND THREAT...' + f.windsrc);
    }
    L.push('');
    L.push('$$  (storm mode: ' + (modeLabel(f) || '—') + (f.vrot ? '; VROT ' + f.vrot + ' kt' : '') + ')');
    return L.join('\n');
  }
  function lineCenter2(pts) { var la = 0, lo = 0; pts.forEach(function (p) { la += p.lat; lo += p.lon; }); return { lat: la / pts.length, lon: lo / pts.length }; }
  function updateText() { if (W.open && W.polygon) $('w-text').textContent = productText(form()); }

  function iso(t) { return t ? new Date(t).toISOString() : null; }
  function zt(t) { var d = new Date(t); return String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0') + 'Z'; }
  function cwaAt(lat, lon) {
    for (var i = 0; i < GEO.cwa.length; i++) { var c = GEO.cwa[i]; for (var k = 0; k < c[3].length; k++) if (pipRing({ lat: lat, lon: lon }, c[3][k])) return c[0]; }
    return null;
  }
  function cwasFor(poly) {
    var set = {}, bb = bbox(poly);
    poly.forEach(function (p) { var w = cwaAt(p.lat, p.lon); if (w) set[w] = 1; });
    GEO.cwa.forEach(function (c) {
      c[3].forEach(function (ring) { for (var i = 0; i < ring.length; i += 3) { var q = ring[i]; if (q[0] >= bb[0] && q[0] <= bb[2] && q[1] >= bb[1] && q[1] <= bb[3] && pip({ lat: q[1], lon: q[0] }, poly)) { set[c[0]] = 1; return; } } });
    });
    return Object.keys(set);
  }
  function tagList(f) {
    var tor = f.type === 'TOR', t = [];
    if (tor) { t.push('TORNADO...' + f.torsrc); if (f.tordmg) t.push('TORNADO DAMAGE THREAT...' + f.tordmg); t.push('MAX HAIL SIZE...' + f.hail.toFixed(2) + ' IN'); }
    else {
      if (f.torposs) t.push('TORNADO...POSSIBLE');
      if (f.svrdmg) t.push('THUNDERSTORM DAMAGE THREAT...' + f.svrdmg);
      t.push('MAX HAIL SIZE...' + f.hail.toFixed(2) + ' IN (' + f.hailsrc + ')');
      t.push('MAX WIND GUST...' + (f.wind || 50) + ' MPH (' + f.windsrc + ')');
    }
    return t;
  }
  // Short structured note the SPC forecaster passes to the WFO warning desk.
  function handoffText(f, id) {
    var tor = f.type === 'TOR', T0 = W.T0, end = T0 + f.dur * 60000, origin = trackAt(T0);
    var o = W.mode === 'cell' ? origin[0] : lineCenter2(origin), d = W.diag || {}, site = App.radar ? App.radar.site : '';
    var wfos = cwasFor(W.polygon), ps = PSev.at(o.lat, o.lon, true);
    var L = [];
    L.push('SPC RECOMMENDATION: ' + (tor ? 'TORNADO WARNING' : 'SEVERE THUNDERSTORM WARNING') + (id ? '  [' + id + ']' : ''));
    L.push('To: WFO ' + (wfos.join(', ') || cwaAt(o.lat, o.lon) || 'unknown') + '   From: SPC   Radar: ' + site);
    var rng = App.radar ? Geo.dist(App.radar.lat, App.radar.lon, o.lat, o.lon) / 1852 : null, az = App.radar ? Geo.bearing(App.radar.lat, App.radar.lon, o.lat, o.lon) : null;
    L.push('Storm: ' + (W.mode === 'line' ? 'line, center ' : '') + nearestPlace(o).replace(/^(near|over) /, '') + ' (' + o.lat.toFixed(2) + ', ' + o.lon.toFixed(2) + ')' + (rng != null ? ', ' + Math.round(rng) + ' nm ' + compass(az, true) + ' of ' + site : ''));
    L.push('Valid: ' + zt(T0) + '-' + zt(end) + ' (' + localTime(T0) + ' to ' + localTime(end) + '), ' + f.dur + ' min');
    L.push('Motion: ' + String(Math.round(W.motion.from)).padStart(3, '0') + '/' + Math.round(W.motion.kt) + ' kt (toward ' + compass(W.motion.from + 180) + ' at ' + Math.round(W.motion.kt * 1.15078) + ' mph)');
    L.push('Mode: ' + (modeLabel(f) || 'not set'));
    var basis = [];
    if (f.vrot !== '') basis.push('VROT ' + f.vrot + ' kt' + (d.beamArl != null ? ' at ' + (d.beamArl / 1000).toFixed(1) + ' kft ARL' : ''));
    else if (d.vrot != null) basis.push('auto VROT ' + Math.round(d.vrot) + ' kt (' + (App.dealias ? 'dealiased' : 'raw') + ')' + (d.beamArl != null ? ' at ' + (d.beamArl / 1000).toFixed(1) + ' kft ARL' : ''));
    if (d.maxRef != null) basis.push('max REF ' + Math.round(d.maxRef) + ' dBZ');
    if (d.maxVel != null) basis.push('max |V| ' + Math.round(d.maxVel) + ' kt');
    if (ps) basis.push('ProbSevere ' + ps.ps + '% (Tor ' + ps.tor + '%, Hail ' + ps.hail + '%, Wind ' + ps.wind + '%)');
    L.push('Basis: ' + (basis.join('; ') || 'forecaster judgment'));
    L.push('Tags: ' + tagList(f).join('; '));
    L.push('Counties: ' + (counties(W.polygon).map(function (c) { return c.replace(' County in ', ' '); }).join('; ') || 'none found'));
    L.push('LAT...LON ' + W.polygon.map(function (p) { return Math.round(p.lat * 100) + ' ' + Math.round(Math.abs(p.lon) * 100); }).join(' '));
    return L.join('\n');
  }
  function updateText() {
    if (!(W.open && W.polygon)) return;
    var f = form();
    $('w-text').textContent = productText(f);
    $('w-handoff').textContent = handoffText(f, W.followId);
  }
  function wrap(ft) {
    var p = ft.properties;
    return { feature: ft, type: p.phenomena === 'TO' ? 'TOR' : 'SVR', issued: Date.parse(p.issued), expires: Date.parse(p.expires), status: p.status || 'active', text: p.text,
      polygon: ft.geometry.coordinates[0].slice(0, -1).map(function (c) { return { lon: c[0], lat: c[1] }; }),
      title: (p.phenomena === 'TO' ? 'Tornado' : 'Severe T-storm') + (p.damage_threat ? ' · ' + p.damage_threat : '') };
  }
  function rebuild() { W.issued = W.log.map(wrap); saveLog(); renderIssued(); redraw(); }
  function nextId(f) {
    var site = App.radar ? App.radar.site : 'XXXX', yr = new Date(W.T0).getUTCFullYear(), n = 1;
    W.log.forEach(function (ft) { var m = /-(\d{4})$/.exec(ft.properties.id); if (m) n = Math.max(n, +m[1] + 1); });
    return site + '-' + (f.type === 'TOR' ? 'TO' : 'SV') + '-' + yr + '-' + String(n).padStart(4, '0');
  }
  function issue() {
    if (!W.polygon) return;
    var f = form(), text = productText(f), now = Date.now();
    var w = { type: f.type, polygon: W.polygon.slice(), issued: W.T0, expires: W.T0 + f.dur * 60000, text: text };
    var follow = W.followId ? W.log.filter(function (ft) { return ft.properties.id === W.followId; })[0] : null;
    var id = follow ? follow.properties.id : nextId(f);
    var ft = toFeature(w, f, now, id), p = ft.properties;
    if (follow) {
      var old = follow.properties;
      p.issued = old.issued; p.valid_from = old.valid_from; p.created_at = old.created_at;
      p.handoff = 'SPC UPDATE (CONTINUE, re-tracked ' + zt(W.T0) + ')\n' + handoffText(f, id);
      p.history = (old.history || []).concat([{ action: 'CON', time: iso(W.T0), created_at: iso(now), expires: p.expires, note: p.handoff }]);
      W.log[W.log.indexOf(follow)] = ft;
    } else {
      p.handoff = handoffText(f, id);
      p.history = [{ action: 'NEW', time: iso(W.T0), created_at: iso(now), expires: p.expires, note: p.handoff }];
      W.log.push(ft);
    }
    closeDialog();
    W.polygon = null; W.pts = []; W.line = []; W.mode = null; W.motion = null; W.followId = null; W.followForm = null;
    rebuild();
    toast((follow ? 'Update to ' + id : (f.type === 'TOR' ? 'Tornado' : 'Severe Thunderstorm') + ' recommendation ' + id) + ' issued until ' + localTime(Date.parse(p.expires)) + '. Click its card for the handoff note.');
  }
  // GeoJSON feature carrying everything about the warning decision.
  function toFeature(w, f, now, id) {
    var ring = w.polygon.map(function (p) { return [+p.lon.toFixed(4), +p.lat.toFixed(4)]; });
    ring.push(ring[0].slice());
    var d = W.diag || {};
    var site = App.radar ? App.radar.site : null, origin = trackAt(W.T0), o = W.mode === 'cell' ? origin[0] : lineCenter2(origin);
    var ps = PSev.at(o.lat, o.lon, true);
    return {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {
        id: id,
        product: f.type === 'TOR' ? 'Tornado Warning' : 'Severe Thunderstorm Warning',
        phenomena: f.type === 'TOR' ? 'TO' : 'SV', significance: 'W', issuer: 'SPC recommendation',
        status: 'active',
        wfo: cwasFor(w.polygon),
        radar: site,
        issued: iso(w.issued), valid_from: iso(w.issued), expires: iso(w.expires), duration_min: f.dur,
        created_at: iso(now), data_mode: App.archiveEnd ? 'archive' : 'live',
        latest_scan_time: iso(latestDataTime()),
        track_type: W.mode,
        storm_motion: { from_deg: Math.round(W.motion.from), speed_kt: Math.round(W.motion.kt) },
        storm_location: origin.map(function (p) { return [+p.lon.toFixed(4), +p.lat.toFixed(4)]; }),
        earlier_line: W.mode === 'line' ? (W.line2 || []).map(function (p) { return { time: iso(p.t), lon: +p.lon.toFixed(4), lat: +p.lat.toFixed(4) }; }) : null,
        track_points: (W.mode === 'cell' ? W.pts : W.line).map(function (p) { return { time: iso(p.t), lon: +p.lon.toFixed(4), lat: +p.lat.toFixed(4) }; }),
        storm_mode: { category: f.cat, sub_mode: f.sub || null, motion: (f.cat === 'SUP' || f.cat === 'MSUP') ? f.move : null,
          mesocyclone_strength: f.cat === 'SUP' ? (f.meso || null) : null, tropical_cyclone: f.tc, label: modeLabel(f), scheme: 'Smith et al. 2012 / Lyons et al.' },
        vrot_kt: f.vrot !== '' ? +f.vrot : null, auto_vrot_kt: d.vrot != null ? Math.round(d.vrot) : null, velocity_dealiased: App.dealias,
        max_ref_dbz: d.maxRef != null ? d.maxRef : null, max_abs_vel_kt: d.maxVel != null ? Math.round(d.maxVel) : null,
        range_nm: d.range != null ? Math.round(d.range) : null, beam_height_ft_arl: d.beamArl != null ? Math.round(d.beamArl) : null,
        probsevere: ps ? { id: ps.id, prob_severe: ps.ps, prob_tor: ps.tor, prob_hail: ps.hail, prob_wind: ps.wind, mesh_in: ps.mesh != null ? +ps.mesh : null } : null,
        max_hail_in: f.hail, hail_threat: f.type === 'SVR' ? f.hailsrc : null,
        max_wind_mph: f.type === 'SVR' ? (f.wind || 50) : null, wind_threat: f.type === 'SVR' ? f.windsrc : null,
        tornado: f.type === 'TOR' ? f.torsrc : (f.torposs ? 'POSSIBLE' : null),
        damage_threat: (f.type === 'TOR' ? f.tordmg : f.svrdmg) || null,
        recommended: (function () { var r = currentRec(); return { type: r.type, max_hail_in: r.hail, max_wind_mph: r.wind, tornado_possible: r.torPossible, damage_threat: (r.type === 'TOR' ? r.torDmg : r.svrDmg) || null, duration_min: r.duration }; })(),
        polygon_edited: W.edited,
        counties: counties(w.polygon),
        locations: pathcastPlaces().slice(0, 60).map(function (p) { return { name: p.name, state: p.st, eta: iso(p.eta) }; }),
        form: f,
        text: w.text
      }
    };
  }
  function saveLog() { try { localStorage.setItem('spcwarn.log', JSON.stringify(W.log)); } catch (e) { toast('Could not save the recommendation log in this browser. Export it to keep it.'); } }
  function loadLog() {
    try { W.log = JSON.parse(localStorage.getItem('spcwarn.log') || '[]') || []; } catch (e) { W.log = []; }
    W.issued = W.log.map(wrap);
  }
  function exportGeoJSON() {
    if (!W.log.length) { toast('No recommendations issued yet'); return; }
    var ref = issueTime();
    var feats = W.log.map(function (ft) {
      var c = JSON.parse(JSON.stringify(ft)), p = c.properties;
      if (p.status === 'active' && Date.parse(p.expires) <= ref) p.status = 'expired';
      delete p.form;
      return c;
    });
    var fc = { type: 'FeatureCollection', name: 'spcwarn_recommendations', generated: new Date().toISOString(), features: feats };
    var blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
    var a = document.createElement('a'), d = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13) + 'Z';
    a.href = URL.createObjectURL(blob); a.download = 'spcwarn-recommendations-' + d + '.geojson';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    toast('Exported ' + W.log.length + ' recommendation' + (W.log.length > 1 ? 's' : '') + ' to GeoJSON');
  }
  function clearLog() {
    var b = $('btn-clearlog');
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Click again to clear'; setTimeout(function () { delete b.dataset.armed; b.textContent = 'Clear log'; }, 4000); return; }
    delete b.dataset.armed; b.textContent = 'Clear log';
    W.log = []; rebuild(); toast('Recommendation log cleared');
  }
  function renderIssued() {
    var host = $('issued'), now = Date.now();
    var ref = App.archiveEnd ? (latestDataTime() || now) : now;
    var active = W.issued.filter(function (w) { return w.status === 'active' && w.expires > ref && w.issued <= ref + 60000; });
    W.active = active;
    host.innerHTML = '';
    $('logcount').textContent = W.log.length;
    $('issued-wrap').hidden = !active.length;
    active.slice().reverse().forEach(function (w) {
      var b = document.createElement('button'); b.className = 'wcard t-' + w.type;
      var rem = Math.max(0, Math.round((w.expires - Math.max(ref, w.issued)) / 60000)), p = w.feature.properties;
      b.innerHTML = '<b>' + w.title + '</b><span>' + p.id + ' · ' + (p.wfo || []).join('/') + '</span><span>until ' + localTime(w.expires) + ' · ' + rem + ' min left' + ((p.history || []).length > 1 ? ' · ' + p.history[p.history.length - 1].action : '') + '</span>';
      b.addEventListener('click', function () { showDetail(p.id); });
      host.appendChild(b);
    });
  }
  // ---------- follow-ups (WarnGen style: CON / EXT / CAN / EXP) ----------
  function findFeature(id) { return W.log.filter(function (ft) { return ft.properties.id === id; })[0]; }
  function act(id, action, minutes) {
    var ft = findFeature(id); if (!ft) return;
    var p = ft.properties, t = issueTime(), now = Date.now(), note;
    var where = (p.counties || []).map(function (c) { return c.replace(' County in ', ' '); }).join('; ');
    if (action === 'EXT') {
      p.expires = iso(Math.max(Date.parse(p.expires), t) + minutes * 60000);
      p.duration_min = Math.round((Date.parse(p.expires) - Date.parse(p.issued)) / 60000);
      note = 'SPC UPDATE (EXTEND) [' + id + ']: ' + p.product + ' recommendation for ' + where + ' now valid until ' + zt(Date.parse(p.expires)) + ' (' + localTime(Date.parse(p.expires)) + '). Threat continues.';
    } else if (action === 'CAN') {
      p.status = 'cancelled'; p.expires = iso(t);
      note = 'SPC UPDATE (CANCEL) [' + id + ']: ' + p.product + ' recommendation for ' + where + ' cancelled at ' + zt(t) + '. The storm no longer supports this warning.';
    } else if (action === 'EXP') {
      p.status = 'expired';
      note = 'SPC UPDATE (EXPIRE) [' + id + ']: let the ' + p.product + ' for ' + where + ' expire at ' + zt(Date.parse(p.expires)) + '. No new recommendation.';
    }
    p.history = (p.history || []).concat([{ action: action, time: iso(t), created_at: iso(now), expires: p.expires, note: note }]);
    rebuild();
    showDetail(id);
    toast(action === 'EXT' ? 'Extended ' + minutes + ' min' : action === 'CAN' ? 'Cancelled' : 'Marked to expire');
  }
  function retrack(id) {
    var ft = findFeature(id); if (!ft) return;
    $('textview').hidden = true;
    var p = ft.properties;
    start(p.track_type === 'line' ? 'line' : 'cell', false, id);
    W.followForm = p.form || null;
  }
  function copy(text, label) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(label + ' copied'); }, function () { toast('Copy blocked by the browser. Select the text and press Ctrl+C.'); });
  }
  function showDetail(id) {
    var ft = findFeature(id); if (!ft) return;
    var p = ft.properties, last = (p.history || [])[p.history.length - 1], active = p.status === 'active';
    var card = $('detail');
    card.innerHTML = '<div class="dhead"><h2></h2><button type="button" data-a="close">Close</button></div>' +
      '<div class="dmeta"></div>' +
      '<div class="dbtns">' + (active ? '<button type="button" data-a="CON">Re-track / continue</button><button type="button" data-a="EXT15">Extend 15 min</button><button type="button" data-a="EXT30">Extend 30 min</button><button type="button" data-a="CAN">Cancel</button><button type="button" data-a="EXP">Let expire</button>' : '') +
      '<button type="button" data-a="copynote">Copy latest note</button><button type="button" data-a="copytext">Copy product text</button><button type="button" data-a="copygeo">Copy GeoJSON</button></div>' +
      '<h3>Latest note for the WFO desk</h3><pre class="note-pre"></pre><h3>History</h3><ol class="hist"></ol><h3>Product text</h3><pre class="text-pre"></pre>';
    card.querySelector('h2').textContent = p.product + ' · ' + p.id;
    card.querySelector('.dmeta').textContent = 'Status: ' + p.status + ' · WFO ' + (p.wfo || []).join(', ') + ' · issued ' + zt(Date.parse(p.issued)) + ' · expires ' + zt(Date.parse(p.expires)) + ' (' + localTime(Date.parse(p.expires)) + ')';
    card.querySelector('.note-pre').textContent = last ? last.note : p.handoff;
    card.querySelector('.text-pre').textContent = p.text;
    var ol = card.querySelector('.hist');
    (p.history || []).forEach(function (h) { var li = document.createElement('li'); li.textContent = h.action + ' at ' + zt(Date.parse(h.time)) + ', valid to ' + zt(Date.parse(h.expires)); ol.appendChild(li); });
    card.onclick = function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var a = b.dataset.a;
      if (a === 'close') $('textview').hidden = true;
      else if (a === 'CON') retrack(id);
      else if (a === 'EXT15') act(id, 'EXT', 15);
      else if (a === 'EXT30') act(id, 'EXT', 30);
      else if (a === 'CAN' || a === 'EXP') act(id, a);
      else if (a === 'copynote') copy(last ? last.note : p.handoff, 'Note');
      else if (a === 'copytext') copy(p.text, 'Product text');
      else if (a === 'copygeo') { var c = JSON.parse(JSON.stringify(ft)); delete c.properties.form; copy(JSON.stringify(c, null, 2), 'GeoJSON'); }
    };
    $('textview').hidden = false;
  }

  // ---------- map interaction for vertex editing ----------
  function nearestVertex(panel, e) {
    if (!W.polygon) return null;
    for (var i = 0; i < W.polygon.length; i++) {
      var q = panel.map.project([W.polygon[i].lon, W.polygon[i].lat]);
      if (Math.hypot(q.x - e.point.x, q.y - e.point.y) < 9) return i;
    }
    return null;
  }
  function onMouseDown(panel, e) {
    if (W.phase) return;
    var i = nearestVertex(panel, e);
    if (i != null) { W.drag = i; panel.map.dragPan.disable(); e.preventDefault(); }
  }
  function onMouseMove(panel, e) {
    if (W.drag != null) { W.polygon[W.drag] = { lat: e.lngLat.lat, lon: e.lngLat.lng }; W.edited = true; redraw(); return; }
    var c = panel.map.getCanvas();
    c.style.cursor = nearestVertex(panel, e) != null && !W.phase ? 'move' : '';
  }
  function onMouseUp(panel) {
    if (W.drag == null) return;
    setTimeout(function () { W.drag = null; }, 0);
    App.panels.forEach(function (p) { p.map.dragPan.enable(); });
    updateText();
  }

  // ---------- drawing ----------
  function redraw() { App.panels.forEach(function (p) { drawOverlay(p); }); }
  function fmtHM(t) { var d = new Date(t); return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M/, ''); }
  function draw(panel, ctx) {
    var map = panel.map;
    function P(p) { return map.project([p.lon, p.lat]); }
    function text(s, x, y) { ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.9)'; ctx.strokeText(s, x, y); ctx.fillStyle = '#fff'; ctx.fillText(s, x, y); }
    function path(pts, close) { ctx.beginPath(); pts.forEach(function (p, i) { var q = P(p); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); }); if (close) ctx.closePath(); }
    // issued warnings
    ctx.font = '600 11px ui-monospace, Menlo, monospace'; ctx.textBaseline = 'middle';
    // issued recommendations: always white, heavy outline, labelled with type and end time
    (W.active || []).forEach(function (w) {
      path(w.polygon, true); ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.lineWidth = 7; ctx.stroke();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 4; ctx.stroke();
      var top = w.polygon.reduce(function (a, b) { return b.lat > a.lat ? b : a; }), q = P(top);
      text((w.type === 'TOR' ? 'TOR' : 'SVR') + ' → ' + fmtHM(w.expires), q.x + 6, q.y - 10);
    });
    function dot(p, r, fill) { var q = P(p); ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, 7); ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke(); return q; }
    // track picks
    if (W.pts.length) {
      ctx.setLineDash([4, 4]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; path(W.pts); ctx.stroke(); ctx.setLineDash([]);
      W.pts.forEach(function (p) { var q = dot(p, 4, '#fff'); text(fmtZ(p.t).slice(0, 5) + 'Z', q.x + 7, q.y - 8); });
    }
    if (W.line.length) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; path(W.line); ctx.stroke();
      W.line.forEach(function (p) { dot(p, 3.5, '#fff'); });
      var lq = P(W.line[W.line.length - 1]); text(fmtZ(W.lineT).slice(0, 5) + 'Z', lq.x + 8, lq.y - 8);
    }
    if (W.line2 && W.line2.length) {
      ctx.setLineDash([7, 4]); ctx.strokeStyle = '#2ad4ff'; ctx.lineWidth = 2; path(W.line2); ctx.stroke(); ctx.setLineDash([]);
      W.line2.forEach(function (p) { dot(p, 3, '#2ad4ff'); });
      var l2 = P(W.line2[W.line2.length - 1]); text(fmtZ(W.line2T).slice(0, 5) + 'Z', l2.x + 8, l2.y - 8);
    }
    // pathcast
    if (W.motion && W.polygon) {
      var steps = Math.ceil(W.dur / 15);
      for (var k = 0; k <= steps; k++) {
        var t = W.T0 + Math.min(k * 15, W.dur) * 60000, pts = trackAt(t);
        ctx.strokeStyle = k === 0 ? '#fff' : 'rgba(255,255,255,.75)'; ctx.lineWidth = k === 0 ? 2 : 1;
        if (pts.length > 1) { path(pts); ctx.stroke(); }
        pts.forEach(function (p, i) { var q = dot(p, k === 0 ? 4.5 : 3, k === 0 ? '#fff' : '#cfd8e3'); if (i === 0 || i === pts.length - 1) text(fmtHM(t), q.x + 7, q.y + 9); });
      }
      var a = trackAt(W.T0), b = trackAt(W.T0 + W.dur * 60000);
      ctx.setLineDash([6, 4]); ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.lineWidth = 1;
      a.forEach(function (p, i) { if (W.mode === 'line' && i !== 0 && i !== a.length - 1) return; var q = P(p), r = P(b[i]); ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(r.x, r.y); ctx.stroke(); });
      ctx.setLineDash([]);
    }
    // saved manual tracks (no polygon): past picks, motion, 15-minute pathcast to 60 minutes
    var tnow = issueTime();
    W.tracks.forEach(function (tr) {
      var picks = tr.mode === 'cell' ? tr.pts : (tr.line2 || []);
      picks.forEach(function (p) { dot(p, 3, '#cfd8e3'); });
      if (tr.mode === 'cell' && tr.pts.length > 1) { ctx.setLineDash([3, 3]); ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1; path(tr.pts); ctx.stroke(); ctx.setLineDash([]); }
      for (var k = 0; k <= 4; k++) {
        var tt = tnow + k * 15 * 60000, ps = trackAt(tt, tr);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = k === 0 ? 2.5 : 1.2;
        if (ps.length > 1) { path(ps); ctx.stroke(); }
        ps.forEach(function (p, i) { var q = dot(p, k === 0 ? 5 : 3, '#fff'); if (i === ps.length - 1) text(fmtHM(tt), q.x + 7, q.y + 9); });
      }
      var a0 = trackAt(tnow, tr), a1 = trackAt(tnow + 3600000, tr);
      ctx.setLineDash([6, 4]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2;
      a0.forEach(function (p, i) { if (tr.mode === 'line' && i !== 0 && i !== a0.length - 1) return; var q = P(p), r = P(a1[i]); ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(r.x, r.y); ctx.stroke(); });
      ctx.setLineDash([]);
      var q0 = P(a0[0]); text(String(Math.round(tr.motion.from)).padStart(3, '0') + '/' + Math.round(tr.motion.kt) + 'kt', q0.x + 8, q0.y - 12);
    });
    if (W.diag && W.diag.rotAt && W.polygon) { var rq = P(W.diag.rotAt); ctx.strokeStyle = '#ff5cf0'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(rq.x, rq.y, 9, 0, 7); ctx.stroke(); }
    // recommended polygon (white)
    if (W.polygon) {
      path(W.polygon, true); ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.lineWidth = 7; ctx.stroke();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 4; ctx.setLineDash([12, 6]); ctx.stroke(); ctx.setLineDash([]);
      W.polygon.forEach(function (p) { var q = P(p); ctx.fillStyle = '#fff'; ctx.fillRect(q.x - 4, q.y - 4, 8, 8); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.strokeRect(q.x - 4, q.y - 4, 8, 8); });
    }
  }

  function init() {
    buildDialogDom();
    loadLog();
    $('btn-export').addEventListener('click', exportGeoJSON);
    $('btn-clearlog').addEventListener('click', clearLog);
    renderIssued();
    $('textview').addEventListener('click', function (e) { if (e.target.id === 'textview') $('textview').hidden = true; });
    $('btn-copyhand').addEventListener('click', function () { copy($('w-handoff').textContent, 'Handoff note'); });
    setInterval(renderIssued, 30000);
  }
  return { init: init, start: start, cancel: cancel, clear: clear, enter: enter, onClick: onClick, onMouseDown: onMouseDown, onMouseMove: onMouseMove,
    onMouseUp: onMouseUp, draw: draw, clearTracks: clearTracks, fromScit: fromScit, pickTrack: pickTrack, fromTrack: warnFromTrack, phase: function () { return W.phase; }, openDialog: function () { openDialog(false); }, dialogOpen: function () { return W.open; }, dialogKey: dialogKey, renderIssued: renderIssued, exportGeoJSON: exportGeoJSON, _W: W };
})();
