// SCIT storm tracks from the Level III NST product, and the right-click-hold radar menu.
var Scit = (function () {
  var L3 = 'https://unidata-nexrad-level3.s3.amazonaws.com';
  var S = { on: false, keys: [], listedAt: 0, listSite: null, listDay: null, cache: {}, current: null, busy: false };
  function pad(n) { return String(n).padStart(2, '0'); }
  function keyTime(k) { var m = /_(\d{4})_(\d\d)_(\d\d)_(\d\d)_(\d\d)_(\d\d)$/.exec(k); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null; }
  function targetTime() {
    var p = App.panels[App.active];
    return p && p.frame ? p.frame.time : (latestDataTime() || Date.now());
  }
  async function list(site, t) {
    var id = site.slice(1), d = new Date(t), keys = [];
    var days = [d, new Date(t - 86400000)];
    for (var i = 0; i < days.length; i++) {
      var x = days[i], prefix = id + '_NST_' + x.getUTCFullYear() + '_' + pad(x.getUTCMonth() + 1) + '_' + pad(x.getUTCDate()) + '_';
      var r = await fetch(L3 + '/?list-type=2&prefix=' + prefix, { cache: 'no-store' });
      var doc = new DOMParser().parseFromString(await r.text(), 'application/xml');
      Array.prototype.forEach.call(doc.getElementsByTagName('Key'), function (n) { keys.push(n.textContent); });
      if (i === 0 && d.getUTCHours() > 1) break;
    }
    return keys.map(function (k) { return { key: k, time: keyTime(k) }; }).filter(function (k) { return k.time; }).sort(function (a, b) { return a.time - b.time; });
  }
  async function sync() {
    if (!(S.on || srvShown()) || S.busy || !App.radar) return;
    S.busy = true;
    try {
      var t = targetTime(), site = App.radar.site, day = new Date(t).toISOString().slice(0, 10);
      var stale = S.listSite !== site || S.listDay !== day || (!App.archiveEnd && Date.now() - S.listedAt > 60000);
      if (stale) { S.keys = await list(site, t); S.listSite = site; S.listDay = day; S.listedAt = Date.now(); }
      var pick = null;
      S.keys.forEach(function (k) { if (k.time <= t + 120000) pick = k; });
      if (pick && t - pick.time > 20 * 60000) pick = null;
      if (!pick) { S.current = null; }
      else if (S.cache[pick.key]) S.current = S.cache[pick.key];
      else {
        var r = await fetch(L3 + '/' + pick.key);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var d = Level3.parseNST(new Uint8Array(await r.arrayBuffer()));
        d.key = pick.key;
        S.cache[pick.key] = d; S.current = d;
      }
      if (srvShown()) App.panels.forEach(function (p) { if (p.product === 'SRV') refreshPanel(p); });
    if (!$('srvbox').hidden) SrvBox.fill();
    $('btn-scit').title = S.current ? 'SCIT from ' + fmtZ(S.current.time) + ' (' + S.current.storms.length + ' cells)' : 'No SCIT product near this scan';
    } catch (e) { console.warn('SCIT', e); toast('SCIT tracks unavailable: ' + e.message); }
    S.busy = false;
    App.panels.forEach(drawOverlay);
    if ((S.on || srvShown()) && S.current && S.current.key && targetTime() - S.current.time > 6 * 60000 && !App.archiveEnd) setTimeout(sync, 60000);
  }
  function srvShown() { return App.panels.some(function (p) { return p.product === 'SRV'; }); }
  function toggle() {
    S.on = !S.on; App.scitOn = S.on;
    $('btn-scit').classList.toggle('on', S.on);
    if (S.on) { sync(); toast('SCIT tracks on (Level III NST, matched to the displayed scan)'); }
    App.panels.forEach(drawOverlay);
  }
  function draw(p, ctx) {
    var d = S.on && S.current; if (!d) return;
    var map = p.map, ref = { lat: d.lat, lon: d.lon };
    function P(xy) { var g = Geo.fromXY(ref, xy[0] * 1000, xy[1] * 1000); return map.project([g.lon, g.lat]); }
    ctx.font = '700 11px ui-monospace, Menlo, monospace'; ctx.textBaseline = 'middle';
    d.storms.forEach(function (s) {
      var c = P(s.pos);
      if (s.past.length) {
        ctx.strokeStyle = 'rgba(176,190,204,.85)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(c.x, c.y);
        s.past.forEach(function (q) { var pq = P(q); ctx.lineTo(pq.x, pq.y); }); ctx.stroke();
        s.past.forEach(function (q) { var pq = P(q); ctx.fillStyle = '#b0becc'; ctx.beginPath(); ctx.arc(pq.x, pq.y, 2.2, 0, 7); ctx.fill(); });
      }
      if (s.fcst.length) {
        ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(c.x, c.y);
        s.fcst.forEach(function (q) { var pq = P(q); ctx.lineTo(pq.x, pq.y); }); ctx.stroke();
        s.fcst.forEach(function (q) { var pq = P(q); ctx.beginPath(); ctx.moveTo(pq.x - 4, pq.y); ctx.lineTo(pq.x + 4, pq.y); ctx.moveTo(pq.x, pq.y - 4); ctx.lineTo(pq.x, pq.y + 4); ctx.stroke(); });
      }
      ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(c.x, c.y, 5, 0, 7); ctx.stroke();
      ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 2; ctx.stroke();
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.9)'; ctx.strokeText(s.id, c.x + 7, c.y - 8); ctx.fillStyle = '#22d3ee'; ctx.fillText(s.id, c.x + 7, c.y - 8);
    });
  }
  // mean SCIT motion (from current position to the first forecast position, 15 min ahead)
  function meanMotion() {
    var d = S.current; if (!d) return null;
    var u = 0, v = 0, n = 0;
    d.storms.forEach(function (s) { if (s.fcst.length) { u += (s.fcst[0][0] - s.pos[0]) * 1000 / 900; v += (s.fcst[0][1] - s.pos[1]) * 1000 / 900; n++; } });
    if (!n) return null; u /= n; v /= n;
    return { from: (Math.atan2(u, v) * 180 / Math.PI + 180 + 360) % 360, kt: Math.hypot(u, v) * 1.943844 };
  }
  // SCIT storm motion for SRV: the NST storm-average motion, else the SCIT adaptation default, else the mean of cell forecasts
  function motion() {
    var d = S.current; if (!d) return null;
    if (d.avg && d.avg.kt > 0) return { from: d.avg.from, kt: d.avg.kt, src: 'SCIT avg' };
    if (d.dflt) return { from: d.dflt.from, kt: d.dflt.kt, src: 'SCIT default' };
    var m = meanMotion(); return m ? { from: m.from, kt: m.kt, src: 'SCIT mean' } : null;
  }
  function pick(p, pt) {
    var d = S.on && S.current; if (!d) return null;
    var ref = { lat: d.lat, lon: d.lon }, best = null, bd = 12;
    d.storms.forEach(function (s) { var g = Geo.fromXY(ref, s.pos[0] * 1000, s.pos[1] * 1000), q = p.map.project([g.lon, g.lat]), dd = Math.hypot(q.x - pt.x, q.y - pt.y); if (dd < bd) { bd = dd; best = s; } });
    return best ? { storm: best, data: d } : null;
  }
  return { toggle: toggle, sync: sync, draw: draw, meanMotion: meanMotion, motion: motion, pick: pick, _S: S };
})();

var RadarMenu = (function () {
  var held = null, holdTimer = null, byHold = false;
  function sites() { return Object.keys(RADARS).filter(function (s) { return /^(K|P|R|TJUA)/.test(s); }); }
  function fill(lat, lon, q) {
    var host = $('rm-list'); host.innerHTML = '';
    var list = sites().map(function (s) { return { s: s, d: Geo.dist(lat, lon, RADARS[s][0], RADARS[s][1]) }; });
    if (q) list = list.filter(function (x) { return x.s.indexOf(q) >= 0; });
    list.sort(function (a, b) { return a.d - b.d; });
    list.slice(0, 14).forEach(function (x, i) {
      var b = document.createElement('button'); b.type = 'button'; b.dataset.site = x.s;
      b.className = (App.site === x.s ? 'cur' : '') + (i === 0 && q ? ' hot' : '');
      b.innerHTML = '<b>' + x.s + '</b><span>' + Math.round(x.d / 1852) + ' nm</span>';
      host.appendChild(b);
    });
  }
  function open(cx, cy, lat, lon) {
    var m = $('radarmenu'), host = $('maps').getBoundingClientRect();
    m.dataset.lat = lat; m.dataset.lon = lon;
    $('rm-search').value = '';
    fill(lat, lon, '');
    m.hidden = false; $('cursorbox').hidden = true;
    var x = cx - host.left - 20, y = cy - host.top - 20;
    m.style.left = Math.max(4, Math.min(x, host.width - m.offsetWidth - 4)) + 'px';
    m.style.top = Math.max(4, Math.min(y, host.height - m.offsetHeight - 4)) + 'px';
  }
  function close() { $('radarmenu').hidden = true; byHold = false; }
  function choose(site) {
    close();
    if (!site) return;
    $('site').value = site;
    try { localStorage.setItem('spcwarn.site', site); } catch (e) {}
    if (App.archiveEnd) Scans.refresh(site, App.archiveEnd, true); // same archive case time on the new radar
    else loadSite(site, null);
  }
  function attach(panel) {
    var el = panel.map.getCanvasContainer();
    if (el.dataset.rm) return; el.dataset.rm = '1';
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    el.addEventListener('mousedown', function (e) {
      if (e.button !== 2) return;
      var ll = panel.map.unproject([e.offsetX, e.offsetY]);
      held = { x: e.clientX, y: e.clientY };
      clearTimeout(holdTimer);
      holdTimer = setTimeout(function () { byHold = true; open(held.x, held.y, ll.lat, ll.lng); }, 220);
    });
  }
  function init() {
    window.addEventListener('mouseup', function (e) {
      if (e.button !== 2) return;
      clearTimeout(holdTimer);
      if (byHold) {
        var b = e.target.closest && e.target.closest('#rm-list button');
        if (b) choose(b.dataset.site); else byHold = false; // released elsewhere: keep menu open for a normal click
      } else if (held && $('radarmenu').hidden) { // quick tap: toggle the cursor readout
        App.readout = !App.readout; toast('Cursor readout ' + (App.readout ? 'on' : 'off')); updateReadout();
      }
      held = null;
    });
    $('rm-list').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) choose(b.dataset.site); });
    $('rm-list').addEventListener('mouseover', function (e) {
      document.querySelectorAll('#rm-list button.hot').forEach(function (b) { b.classList.remove('hot'); });
      var b = e.target.closest('button'); if (b) b.classList.add('hot');
    });
    $('rm-search').addEventListener('input', function () { var m = $('radarmenu'); fill(+m.dataset.lat, +m.dataset.lon, this.value.trim().toUpperCase()); });
    $('rm-search').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { var b = document.querySelector('#rm-list button'); choose(b && b.dataset.site); }
      if (e.key === 'Escape') close();
      e.stopPropagation();
    });
    document.addEventListener('mousedown', function (e) { if (!$('radarmenu').hidden && !e.target.closest('#radarmenu') && e.button === 0) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('radarmenu').hidden) close(); });
  }
  return { init: init, attach: attach, open: open, close: close };
})();

// NOAA/CIMSS ProbSevere objects (MRMS GeoJSON on AWS), matched to the displayed scan time.
var PSev = (function () {
  var B = 'https://noaa-mrms-pds.s3.amazonaws.com';
  var S = { on: false, keys: [], day: null, listedAt: 0, cache: {}, current: null, busy: false };
  function keyTime(k) { var m = /_(\d{8})_(\d{6})\.json$/.exec(k); if (!m) return null; var d = m[1], t = m[2]; return Date.UTC(+d.substr(0, 4), +d.substr(4, 2) - 1, +d.substr(6, 2), +t.substr(0, 2), +t.substr(2, 2), +t.substr(4, 2)); }
  function target() { var p = App.panels[App.active]; return p && p.frame ? p.frame.time : (latestDataTime() || Date.now()); }
  function color(p) {
    return p >= 90 ? '#ff2bd6' : p >= 70 ? '#ff3030' : p >= 50 ? '#ff8c1a' : p >= 30 ? '#ffd21a' : p >= 10 ? '#7ee05a' : '#5b6b7a';
  }
  async function list(t) {
    var d = new Date(t), day = d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
    var keys = [], token = null;
    do {
      var r = await fetch(B + '/?list-type=2&prefix=ProbSevere/' + day + '/' + (token ? '&continuation-token=' + encodeURIComponent(token) : ''), { cache: 'no-store' });
      var doc = new DOMParser().parseFromString(await r.text(), 'application/xml');
      Array.prototype.forEach.call(doc.getElementsByTagName('Key'), function (n) { keys.push(n.textContent); });
      var nt = doc.getElementsByTagName('NextContinuationToken')[0]; token = nt ? nt.textContent : null;
    } while (token);
    S.day = day;
    return keys.map(function (k) { return { key: k, time: keyTime(k) }; }).filter(function (k) { return k.time; });
  }
  async function sync() {
    if (!S.on || S.busy) return;
    S.busy = true;
    try {
      var t = target(), d = new Date(t), day = d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
      if (S.day !== day || (!App.archiveEnd && Date.now() - S.listedAt > 60000)) { S.keys = await list(t); S.listedAt = Date.now(); }
      var pick = null; S.keys.forEach(function (k) { if (k.time <= t + 60000) pick = k; });
      if (pick && t - pick.time > 10 * 60000) pick = null;
      if (!pick) S.current = null;
      else if (S.cache[pick.key]) S.current = S.cache[pick.key];
      else {
        var r = await fetch(B + '/' + pick.key); if (!r.ok) throw new Error('HTTP ' + r.status);
        var j = await r.json();
        var objs = (j.features || []).map(function (f) {
          var p = f.properties || {}, md = f.models || {};
          var ring = f.geometry && f.geometry.coordinates && f.geometry.coordinates[0] || [];
          var bb = [180, 90, -180, -90]; ring.forEach(function (c) { bb[0] = Math.min(bb[0], c[0]); bb[1] = Math.min(bb[1], c[1]); bb[2] = Math.max(bb[2], c[0]); bb[3] = Math.max(bb[3], c[1]); });
          function lines(m) { var o = md[m] || {}, out = []; for (var i = 1; i <= 20; i++) { var k = 'LINE' + String(i).padStart(2, '0'); if (o[k]) out.push(o[k]); } return out; }
          return { id: p.ID, ring: ring, bb: bb, ps: +(p.ProbSevere || p.PS || (md.probsevere || {}).PROB || 0), tor: +(p.ProbTor || (md.probtor || {}).PROB || 0),
            hail: +(p.ProbHail || (md.probhail || {}).PROB || 0), wind: +(p.ProbWind || (md.probwind || {}).PROB || 0), mesh: p.MESH, lines: lines('probsevere'), torLines: lines('probtor') };
        });
        S.cache[pick.key] = { time: pick.time, objs: objs };
        var ks = Object.keys(S.cache); if (ks.length > 30) delete S.cache[ks[0]];
        S.current = S.cache[pick.key];
      }
      $('btn-psev').title = S.current ? 'ProbSevere ' + fmtZ(S.current.time) + ', ' + S.current.objs.length + ' objects' : 'No ProbSevere file near this scan';
    } catch (e) { console.warn('ProbSevere', e); toast('ProbSevere unavailable: ' + e.message); }
    S.busy = false;
    App.panels.forEach(drawOverlay);
  }
  function toggle() {
    S.on = !S.on; $('btn-psev').classList.toggle('on', S.on);
    if (S.on) { sync(); toast('ProbSevere objects on (MRMS, matched to the displayed scan)'); }
    App.panels.forEach(drawOverlay);
  }
  function inRing(lat, lon, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var a = ring[i], b = ring[j];
      if ((a[1] > lat) !== (b[1] > lat) && lon < (b[0] - a[0]) * (lat - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }
  // object containing (or nearest within 10 km of) a point; used for hover and the handoff note
  function at(lat, lon, anyTime) {
    var cur = S.current; if (!cur || (!S.on && !anyTime)) return null;
    var best = null, bd = 10000;
    cur.objs.forEach(function (o) {
      o._inside = false;
      if (lon < o.bb[0] - 0.15 || lon > o.bb[2] + 0.15 || lat < o.bb[1] - 0.1 || lat > o.bb[3] + 0.1) return;
      if (inRing(lat, lon, o.ring)) { best = o; bd = 0; o._inside = true; return; }
      if (bd > 0) o.ring.forEach(function (c) { var d = Geo.dist(lat, lon, c[1], c[0]); if (d < bd) { bd = d; best = o; } });
    });
    return best;
  }
  function draw(p, ctx) {
    var cur = S.on && S.current; if (!cur) return;
    var map = p.map, b = map.getBounds();
    ctx.font = '700 10.5px ui-monospace, Menlo, monospace'; ctx.textBaseline = 'middle';
    cur.objs.forEach(function (o) {
      if (o.bb[2] < b.getWest() || o.bb[0] > b.getEast() || o.bb[3] < b.getSouth() || o.bb[1] > b.getNorth()) return;
      ctx.beginPath();
      o.ring.forEach(function (c, i) { var q = map.project(c); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
      ctx.closePath();
      ctx.strokeStyle = color(o.ps); ctx.lineWidth = o.ps >= 50 ? 2.2 : 1.3; ctx.setLineDash(o.ps < 10 ? [2, 3] : []); ctx.stroke(); ctx.setLineDash([]);
      if (o.ps >= 20 || o.tor >= 10) {
        var top = o.ring.reduce(function (a, c) { return c[1] > a[1] ? c : a; }, o.ring[0]), q = map.project(top);
        var s = 'PS' + o.ps + (o.tor >= 5 ? ' T' + o.tor : '');
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.9)'; ctx.strokeText(s, q.x - 12, q.y - 8); ctx.fillStyle = color(o.ps); ctx.fillText(s, q.x - 12, q.y - 8);
      }
    });
  }
  return { toggle: toggle, sync: sync, draw: draw, at: at, on: function () { return S.on; }, current: function () { return S.current; }, _S: S };
})();
