// Main application: volumes, panels, maps, hotkeys and the live update loop.
var App = {
  site: 'KTLX', radar: null, volumes: [], version: 0, gen: 0,
  layout: 1, panels: [], active: 0, tilt: 0.5, cursor: null, loopTimer: null,
  maxVols: 8, readout: true, archiveEnd: null, basemap: false, counties: true, cwas: true, dealias: true, mouse: null, syncing: false
};
var PRODUCT_KEYS = { r: 'REF', v: 'VEL', s: 'SRV', w: 'SW', z: 'ZDR', c: 'RHO', p: 'PHI' };
var SOURCE_MOMENT = { SRV: 'VEL' };
var LAYOUT_PRODUCTS = { 1: ['REF'], 2: ['REF', 'VEL'], 4: ['REF', 'VEL', 'RHO', 'ZDR'] };
var GEO = null, CITY_LABELS = null, PLACES = null;

function $(id) { return document.getElementById(id); }
function fmtZ(t) { var d = new Date(t); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ':' + String(d.getUTCSeconds()).padStart(2, '0') + 'Z'; }
function setStatus(msg, kind) { var el = $('status'); el.textContent = msg; el.dataset.kind = kind || ''; }
function toast(msg) { var el = $('toast'); el.textContent = msg; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(function () { el.hidden = true; }, 3500); }

// ---------- geometry helpers ----------
var Geo = {
  R: 6371000,
  dist: function (lat1, lon1, lat2, lon2) {
    var r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * Geo.R * Math.asin(Math.min(1, Math.sqrt(a)));
  },
  bearing: function (lat1, lon1, lat2, lon2) {
    var r = Math.PI / 180, dLon = (lon2 - lon1) * r;
    var y = Math.sin(dLon) * Math.cos(lat2 * r), x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dLon);
    return (Math.atan2(y, x) / r + 360) % 360;
  },
  // local tangent plane (meters) around a reference point
  toXY: function (ref, lat, lon) { return [(lon - ref.lon) * 111320 * Math.cos(ref.lat * Math.PI / 180), (lat - ref.lat) * 110540]; },
  fromXY: function (ref, x, y) { return { lat: ref.lat + y / 110540, lon: ref.lon + x / (111320 * Math.cos(ref.lat * Math.PI / 180)) }; }
};

// ---------- volumes & frames ----------
function addVolume(source, key, time) {
  var v = { id: source + ':' + key, key: key, source: source, time: time, meta: null, sweeps: {}, complete: false };
  App.volumes.push(v);
  App.volumes.sort(function (a, b) { return a.time - b.time; });
  return v;
}
function findVolumeNear(t, source) {
  for (var i = 0; i < App.volumes.length; i++) {
    var v = App.volumes[i];
    if ((!source || v.source === source) && Math.abs(v.time - t) < 90000) return v;
  }
  return null;
}
function mergeVolume(v, msg) {
  if (msg.error) { console.warn(msg.error); setStatus('Load error: ' + msg.error, 'error'); return; }
  if (msg.meta) {
    v.meta = msg.meta; v.complete = !!msg.meta.complete;
    if (msg.meta.volTime) v.time = msg.meta.volTime;
    if (msg.meta.lat != null && (!App.radar || App.radar.site !== msg.meta.site)) setRadar(msg.meta);
  }
  (msg.sweeps || []).forEach(function (s) { s.nominal = s.cutAngle != null && Math.abs(s.cutAngle - s.elev) < 0.3 ? Math.round(s.cutAngle * 10) / 10 : Data.nominal(s.elev + 0.04); s.vol = v; v.sweeps[s.elevNum] = s; });
  if (msg.sweeps && msg.sweeps.length) {
    App.version++;
    pruneVolumes();
    if (Date.now() - lastIssuedRefresh > 5000) { lastIssuedRefresh = Date.now(); Warn.renderIssued(); }
    scheduleRefresh();
  }
}
function pruneVolumes() {
  App.volumes.sort(function (a, b) { return a.time - b.time; });
  while (App.volumes.length > App.maxVols) App.volumes.shift();
}
function setRadar(meta) {
  var first = !App.radar;
  App.radar = { site: meta.site, lat: meta.lat, lon: meta.lon, height: meta.height };
  if (first) App.panels.forEach(function (p) { p.map.jumpTo({ center: [meta.lon, meta.lat] }); });
}
var frameCache = {};
function frames(product, tilt) {
  var key = product + '|' + tilt + '|' + App.version;
  if (frameCache[key]) return frameCache[key];
  var out = [], disp = product;
  product = SOURCE_MOMENT[product] || product;
  App.volumes.forEach(function (v) {
    var list = Object.keys(v.sweeps).map(function (k) { return v.sweeps[k]; })
      .filter(function (s) { return s.nominal === tilt && s.moments[product]; })
      .sort(function (a, b) { return a.elevNum - b.elevNum; });
    var groups = [];
    list.forEach(function (s) {
      var g = groups[groups.length - 1];
      if (g && s.elevNum - g.last.elevNum === 1 && Math.abs(s.time - g.last.time) < 150000) { g.items.push(s); g.last = s; }
      else groups.push({ items: [s], last: s });
    });
    groups.forEach(function (g, gi) {
      var best = g.items.reduce(function (a, b) {
        return b.moments[product].ngates * b.nrad > a.moments[product].ngates * a.nrad ? b : a;
      });
      out.push({ sweep: best, vol: v, time: best.time, supplemental: gi > 0, product: disp });
    });
  });
  out.sort(function (a, b) { return a.time - b.time; });
  if (Object.keys(frameCache).length > 40) frameCache = {};
  frameCache[key] = out;
  return out;
}
function tilts() {
  var set = {};
  App.volumes.forEach(function (v) { for (var k in v.sweeps) set[v.sweeps[k].nominal] = 1; });
  return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
}
function frameFor(panel) {
  var fr = frames(panel.product, App.tilt);
  if (!fr.length) return null;
  if (App.cursor == null) return fr[fr.length - 1];
  var best = fr[0], bd = Infinity;
  fr.forEach(function (f) { var d = Math.abs(f.time - App.cursor); if (d < bd) { bd = d; best = f; } });
  return best;
}
function latestDataTime() {
  var t = 0; App.volumes.forEach(function (v) { for (var k in v.sweeps) t = Math.max(t, v.sweeps[k].endTime); });
  return t;
}

// ---------- sampling ----------
function sampleFrame(frame, lat, lon) {
  if (!frame || !App.radar) return null;
  var m = momentOf(frame); if (!m) return null;
  var d = Geo.dist(App.radar.lat, App.radar.lon, lat, lon), az = Geo.bearing(App.radar.lat, App.radar.lon, lat, lon);
  var r = d / Math.cos(frame.sweep.elev * Math.PI / 180);
  var gate = Math.floor((r - m.first) / m.spacing + 0.5);
  if (gate < 0 || gate >= m.ngates) return null;
  var row = Math.floor(az / frame.sweep.res) % frame.sweep.rows;
  return Colors.value(frame.product, m, m.data[row * m.ngates + gate]);
}
function beamHeightFt(rangeM, elevDeg) {
  var ke = 4 / 3 * 6371000, e = elevDeg * Math.PI / 180;
  var h = Math.sqrt(rangeM * rangeM + ke * ke + 2 * rangeM * ke * Math.sin(e)) - ke;
  return (h + (App.radar ? App.radar.height : 0)) * 3.28084;
}
// Search a radius for extremes of a product in a frame. Returns {max, min, maxAt, minAt}.
function scanArea(frame, lat, lon, radiusM) {
  if (!frame || !App.radar) return null;
  var m = momentOf(frame), sw = frame.sweep; if (!m) return null;
  var d0 = Geo.dist(App.radar.lat, App.radar.lon, lat, lon), az0 = Geo.bearing(App.radar.lat, App.radar.lon, lat, lon);
  var cosE = Math.cos(sw.elev * Math.PI / 180);
  var dAz = Math.min(180, (radiusM / Math.max(d0, 1000)) * 180 / Math.PI + sw.res);
  var res = { max: -Infinity, min: Infinity, maxAt: null, minAt: null, n: 0 };
  var g0 = Math.max(0, Math.floor(((d0 - radiusM) / cosE - m.first) / m.spacing)), g1 = Math.min(m.ngates - 1, Math.ceil(((d0 + radiusM) / cosE - m.first) / m.spacing));
  for (var a = az0 - dAz; a <= az0 + dAz; a += sw.res) {
    var row = ((Math.floor(a / sw.res) % sw.rows) + sw.rows) % sw.rows, rowAz = (row + 0.5) * sw.res;
    for (var g = g0; g <= g1; g++) {
      var code = m.data[row * m.ngates + g]; if (code < 2) continue;
      var rr = (m.first + g * m.spacing) * cosE;
      var p = destPoint(App.radar.lat, App.radar.lon, rowAz, rr);
      if (Geo.dist(lat, lon, p.lat, p.lon) > radiusM) continue;
      var v = (code - m.offset) / m.scale * Colors.TABLES[frame.product].conv;
      res.n++;
      if (v > res.max) { res.max = v; res.maxAt = p; }
      if (v < res.min) { res.min = v; res.minAt = p; }
    }
  }
  return res.n ? res : null;
}
function destPoint(lat, lon, brg, dist) {
  var r = Math.PI / 180, d = dist / Geo.R, b = brg * r, la = lat * r, lo = lon * r;
  var la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  var lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return { lat: la2 / r, lon: lo2 / r };
}

// ---------- maps / panels ----------
function baseStyle() {
  var countyLines = { type: 'MultiLineString', coordinates: [] };
  GEO.cpoly.counties.forEach(function (c) { c[2].forEach(function (ring) { countyLines.coordinates.push(ring); }); });
  return {
    version: 8,
    sources: {
      basemap: { type: 'raster', tiles: ['https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', 'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 18 },
      counties: { type: 'geojson', data: countyLines },
      cwa: { type: 'geojson', data: { type: 'MultiLineString', coordinates: GEO.cwa.reduce(function (a, c) { return a.concat(c[3]); }, []) } },
      states: { type: 'geojson', data: { type: 'MultiLineString', coordinates: GEO.geo.states } },
      nation: { type: 'geojson', data: { type: 'MultiLineString', coordinates: GEO.geo.nation } }
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0c1117' } },
      { id: 'basemap', type: 'raster', source: 'basemap', layout: { visibility: App.basemap ? 'visible' : 'none' }, paint: { 'raster-opacity': 0.9 } },
      { id: 'counties', type: 'line', source: 'counties', minzoom: 5, layout: { visibility: App.counties ? 'visible' : 'none' }, paint: { 'line-color': '#4d5b6b', 'line-width': 0.6 } },
      { id: 'cwa', type: 'line', source: 'cwa', layout: { visibility: App.cwas ? 'visible' : 'none' }, paint: { 'line-color': '#ff3df2', 'line-width': 1.4, 'line-opacity': 0.9 } },
      { id: 'states', type: 'line', source: 'states', paint: { 'line-color': '#a9b6c4', 'line-width': 1.3 } },
      { id: 'nation', type: 'line', source: 'nation', paint: { 'line-color': '#c9d3dd', 'line-width': 1.6 } }
    ]
  };
}
function buildPanels() {
  var host = $('maps');
  var center = App.panels.length ? App.panels[0].map.getCenter() : (App.radar ? [App.radar.lon, App.radar.lat] : [RADARS[App.site][1], RADARS[App.site][0]]);
  var zoom = App.panels.length ? App.panels[0].map.getZoom() : 7.2;
  var prods = App.panels.map(function (p) { return p.product; });
  App.panels.forEach(function (p) { p.map.remove(); });
  host.innerHTML = '';
  host.dataset.layout = App.layout;
  App.panels = [];
  for (var i = 0; i < App.layout; i++) {
    var el = document.createElement('div'); el.className = 'panel'; el.dataset.idx = i;
    el.innerHTML = '<div class="map"></div><canvas class="overlay"></canvas>' +
      '<div class="phead"><span class="pprod"></span><span class="ptilt"></span><span class="ptime"></span><span class="ptag"></span></div>' +
      '<div class="pfoot"><span class="pval"></span><canvas class="legend" width="220" height="12"></canvas></div>';
    host.appendChild(el);
    var map = new maplibregl.Map({ container: el.querySelector('.map'), style: baseStyle(), center: center, zoom: zoom,
      attributionControl: false, dragRotate: false, pitchWithRotate: false, fadeDuration: 0, keyboard: false, doubleClickZoom: false, boxZoom: false });
    map.touchZoomRotate.disableRotation();
    var panel = { idx: i, el: el, map: map, product: prods[i] || LAYOUT_PRODUCTS[App.layout][i] || 'REF', layer: new RadarLayer('radar'),
      canvas: el.querySelector('.overlay'), frame: null };
    App.panels.push(panel);
    (function (panel) {
      var map = panel.map;
      map.on('load', function () { if (!map.getLayer('radar')) map.addLayer(panel.layer, 'counties'); refreshPanel(panel); });
      map.on('move', function () {
        if (App.syncing) return; App.syncing = true;
        var c = map.getCenter(), z = map.getZoom();
        App.panels.forEach(function (o) { if (o !== panel) o.map.jumpTo({ center: c, zoom: z }); });
        App.syncing = false;
      });
      map.on('render', function () { drawOverlay(panel); });
      RadarMenu.attach(panel);
      map.on('mousemove', function (e) { App.mouse = { lat: e.lngLat.lat, lon: e.lngLat.lng }; App.hoverPanel = panel; App.mousePt = e.point; App.mousePx = { x: e.originalEvent.clientX, y: e.originalEvent.clientY }; updateReadout(); Warn.onMouseMove(panel, e); });
      map.on('mousedown', function (e) { Warn.onMouseDown(panel, e); });
      map.on('mouseup', function (e) { Warn.onMouseUp(panel, e); });
      map.getCanvas().addEventListener('mouseleave', function () { App.mouse = null; updateReadout(); });
      map.on('click', function (e) {
        setActive(panel.idx);
        if (e.originalEvent.shiftKey && !Warn.phase()) { var sc = Scit.pick(panel, e.point); if (sc) { Warn.fromScit(sc.storm, sc.data); return; } }
        Warn.onClick(panel, e);
      });
      el.addEventListener('mousedown', function () { setActive(panel.idx); });
      new ResizeObserver(function () { sizeOverlay(panel); }).observe(el);
    })(panel);
  }
  if (App.active >= App.layout) App.active = 0;
  setActive(App.active);
}
function sizeOverlay(p) {
  var r = p.el.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  p.canvas.width = Math.round(r.width * dpr); p.canvas.height = Math.round(r.height * dpr);
  p.canvas.style.width = r.width + 'px'; p.canvas.style.height = r.height + 'px';
  p.map.resize(); drawOverlay(p);
}
function setActive(i) {
  App.active = i;
  App.panels.forEach(function (p) { p.el.classList.toggle('active', p.idx === i); });
  updateToolbar();
}
function setLayout(n) {
  if (App.layout === n) return;
  App.layout = n; buildPanels(); updateToolbar();
}
function setProduct(prod) {
  var p = App.panels[App.active]; if (!p) return;
  p.product = prod; refreshPanel(p); updateToolbar();
}
var refreshPending = false;
function scheduleRefresh() {
  if (refreshPending) return; refreshPending = true;
  requestAnimationFrame(function () { refreshPending = false; refreshAll(); });
}
function refreshAll() { App.panels.forEach(refreshPanel); updateToolbar(); Scit.sync(); PSev.sync(); }
var lastIssuedRefresh = 0;
function refreshPanel(p) {
  var f = frameFor(p);
  p.frame = f;
  if (f) p.layer.setFrame({ sweep: f.sweep, product: f.product, moment: momentOf(f), radar: App.radar });
  else p.layer.setFrame(null);
  var h = p.el;
  h.querySelector('.pprod').textContent = Colors.NAMES[p.product];
  h.querySelector('.ptilt').textContent = App.tilt.toFixed(1) + '°';
  h.querySelector('.ptime').textContent = f ? fmtZ(f.time) : 'no data at this tilt';
  var tag = '';
  if (f) {
    if (f.supplemental) tag = App.tilt <= 0.6 ? 'SAILS' : 'MRLE';
    if (f.vol.source === 'live' && !f.sweep.ended) tag += (tag ? ' · ' : '') + 'SCANNING';
  }
  if (f && (p.product === 'VEL' || p.product === 'SRV') && App.dealias) tag += (tag ? ' · ' : '') + 'DEALIASED';
  if (f && p.product === 'SRV') { var mo = Vel.motion(); tag += ' · ' + (mo ? String(Math.round(mo.from)).padStart(3, '0') + '/' + Math.round(mo.kt) + ' kt ' + mo.src : 'no motion, showing VEL'); }
  var tagEl = h.querySelector('.ptag'); tagEl.textContent = tag; tagEl.hidden = !tag;
  drawLegend(p);
  drawOverlay(p);
  if (p.map.loaded()) p.map.triggerRepaint();
}
function drawLegend(p) {
  var c = p.el.querySelector('.legend'), ctx = c.getContext('2d'), t = Colors.TABLES[p.product], s = t.stops;
  var lo = s[0][0], hi = s[s.length - 1][0];
  ctx.clearRect(0, 0, c.width, c.height);
  for (var x = 0; x < c.width; x++) {
    var v = lo + (hi - lo) * x / (c.width - 1), col = Colors.colorAt(p.product, v);
    ctx.fillStyle = col ? 'rgb(' + col.map(Math.round).join(',') + ')' : '#111'; ctx.fillRect(x, 0, 1, c.height);
  }
  c.title = lo + ' to ' + hi + ' ' + t.units;
}
function updateReadout() {
  App.panels.forEach(function (p) {
    var el = p.el.querySelector('.pval'), txt = '';
    if (App.mouse && p.frame) {
      var v = sampleFrame(p.frame, App.mouse.lat, App.mouse.lon), t = Colors.TABLES[p.product];
      txt = v == null ? '—' : v === 'RF' ? 'RF' : (p.product === 'RHO' ? v.toFixed(3) : p.product === 'ZDR' ? v.toFixed(1) : Math.round(v)) + ' ' + t.units;
    }
    el.textContent = txt;
    drawOverlay(p);
  });
  var box = $('cursorbox'), hp = App.hoverPanel;
  if (App.readout && App.mouse && App.radar && hp && hp.frame && $('radarmenu').hidden) {
    var dm = Geo.dist(App.radar.lat, App.radar.lon, App.mouse.lat, App.mouse.lon), azm = Geo.bearing(App.radar.lat, App.radar.lon, App.mouse.lat, App.mouse.lon);
    var el = hp.frame.sweep.elev, slant = dm / Math.cos(el * Math.PI / 180);
    var arl = beamHeightFt(slant, el) - App.radar.height * 3.28084;
    var vv = sampleFrame(hp.frame, App.mouse.lat, App.mouse.lon), tt = Colors.TABLES[hp.product];
    var vs = vv == null ? 'no data' : vv === 'RF' ? 'range folded' : (hp.product === 'RHO' ? vv.toFixed(3) : hp.product === 'ZDR' ? vv.toFixed(1) : vv.toFixed(hp.product === 'REF' ? 1 : 0)) + ' ' + tt.units;
    box.innerHTML = '<b>' + vs + '</b>\n' + String(Math.round(azm)).padStart(3, '0') + '° ' + (dm / 1852).toFixed(1) + ' nm (' + (dm / 1000).toFixed(1) + ' km)\n' +
      'Hgt ' + Math.round(arl / 10) * 10 + ' ft ARL (' + (arl * 0.3048 / 1000).toFixed(2) + ' km)\n' + App.mouse.lat.toFixed(4) + ', ' + App.mouse.lon.toFixed(4);
    var po = PSev.on() && PSev.at(App.mouse.lat, App.mouse.lon);
    if (po && po._inside) box.innerHTML += '\n\n<b>ProbSevere ' + po.ps + '%</b>  Tor ' + po.tor + '%  Hail ' + po.hail + '%  Wind ' + po.wind + '%\n' + po.lines.slice(1, 7).join('\n');
    var sc = Scit._S.on && App.mousePt && Scit.pick(hp, App.mousePt);
    if (sc) box.innerHTML += '\n\nSCIT ' + sc.storm.id + ': Shift-click for a polygon';
    var host = $('maps').getBoundingClientRect(), mx = App.mousePx.x - host.left, my = App.mousePx.y - host.top;
    box.hidden = false;
    var bw = box.offsetWidth, bh = box.offsetHeight;
    box.style.left = (mx + 16 + bw > host.width ? mx - bw - 12 : mx + 16) + 'px';
    box.style.top = (my + 16 + bh > host.height ? my - bh - 12 : my + 16) + 'px';
  } else box.hidden = true;
  var r = $('readout');
  if (App.mouse && App.radar) {
    var d = Geo.dist(App.radar.lat, App.radar.lon, App.mouse.lat, App.mouse.lon), az = Geo.bearing(App.radar.lat, App.radar.lon, App.mouse.lat, App.mouse.lon);
    var f = App.panels[App.active] && App.panels[App.active].frame;
    r.textContent = App.mouse.lat.toFixed(4) + ', ' + App.mouse.lon.toFixed(4) + '  ·  ' + String(Math.round(az)).padStart(3, '0') + '° ' + (d / 1852).toFixed(1) + ' nm' +
      (f ? '  ·  beam ' + Math.round((beamHeightFt(d / Math.cos(f.sweep.elev * Math.PI / 180), f.sweep.elev) - App.radar.height * 3.28084) / 10) * 10 + ' ft ARL, ' + Math.round(beamHeightFt(d / Math.cos(f.sweep.elev * Math.PI / 180), f.sweep.elev) / 10) * 10 + ' ft MSL' : '');
  } else r.textContent = '';
}

// ---------- overlay drawing (labels, crosshair, tracks, polygons) ----------
function drawOverlay(p) {
  var ctx = p.canvas.getContext('2d'), dpr = window.devicePixelRatio || 1, map = p.map;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, p.canvas.width, p.canvas.height);
  var z = map.getZoom(), b = map.getBounds();
  // radar site marker
  if (App.radar) {
    var rp = map.project([App.radar.lon, App.radar.lat]);
    ctx.strokeStyle = '#9fb3c8'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(rp.x, rp.y, 4, 0, 7); ctx.stroke();
    ctx.font = '600 11px ui-monospace, Menlo, monospace'; ctx.fillStyle = '#9fb3c8'; ctx.fillText(App.radar.site, rp.x + 6, rp.y - 6);
  }
  // city labels
  ctx.font = '11px system-ui, sans-serif'; ctx.textBaseline = 'middle';
  var minPop = z < 6 ? 400000 : z < 7 ? 150000 : z < 8 ? 60000 : 0;
  var placed = [];
  function label(name, lat, lon, strong) {
    if (lat < b.getSouth() || lat > b.getNorth() || lon < b.getWest() || lon > b.getEast()) return;
    var q = map.project([lon, lat]), w = ctx.measureText(name).width;
    for (var i = 0; i < placed.length; i++) { var o = placed[i]; if (q.x < o[2] && q.x + w + 8 > o[0] && Math.abs(q.y - o[1]) < 13) return; }
    placed.push([q.x, q.y, q.x + w + 8]);
    ctx.fillStyle = strong ? '#e6edf3' : '#b7c3cf';
    ctx.fillRect(q.x - 1.5, q.y - 1.5, 3, 3);
    ctx.strokeStyle = 'rgba(8,12,16,.85)'; ctx.lineWidth = 3; ctx.strokeText(name, q.x + 5, q.y);
    ctx.fillText(name, q.x + 5, q.y);
  }
  CITY_LABELS.forEach(function (c) { if (c[1] >= minPop) label(c[0], c[2], c[3], c[1] > 150000); });
  if (z >= 9) PLACES.forEach(function (c) { label(c[0], c[2], c[3], false); });
  if (App.cwas && z >= 5.5) {
    ctx.font = '700 11px ui-monospace, Menlo, monospace'; ctx.fillStyle = '#ff7af6';
    GEO.cwa.forEach(function (c) {
      if (c[2] < b.getSouth() || c[2] > b.getNorth() || c[1] < b.getWest() || c[1] > b.getEast()) return;
      var q = map.project([c[1], c[2]]); ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,12,16,.85)'; ctx.strokeText(c[0], q.x - 10, q.y); ctx.fillText(c[0], q.x - 10, q.y);
    });
  }
  PSev.draw(p, ctx);
  Scit.draw(p, ctx);
  Warn.draw(p, ctx);
  // crosshair
  if (App.mouse && App.panels.length > 1) {
    var mp = map.project([App.mouse.lon, App.mouse.lat]);
    ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(mp.x - 8, mp.y); ctx.lineTo(mp.x + 8, mp.y); ctx.moveTo(mp.x, mp.y - 8); ctx.lineTo(mp.x, mp.y + 8); ctx.stroke();
  }
}

// ---------- time / tilt navigation ----------
function stepTime(dir) {
  var p = App.panels[App.active]; if (!p) return;
  var fr = frames(p.product, App.tilt); if (!fr.length) return;
  var cur = p.frame ? fr.indexOf(p.frame) : fr.length - 1;
  if (cur < 0) cur = fr.length - 1;
  var n = cur + dir;
  if (n >= fr.length - 1) App.cursor = null;
  else App.cursor = fr[Math.max(0, n)].time;
  refreshAll();
}
function stepTilt(dir) {
  var t = tilts(); if (!t.length) return;
  var i = t.indexOf(App.tilt);
  if (i < 0) { i = 0; for (var k = 0; k < t.length; k++) if (t[k] <= App.tilt) i = k; }
  App.tilt = t[Math.max(0, Math.min(t.length - 1, i + dir))];
  refreshAll();
}
function toggleLoop() {
  if (App.loopTimer) { clearTimeout(App.loopTimer); App.loopTimer = null; App.cursor = null; refreshAll(); return; }
  var tick = function () {
    var p = App.panels[App.active]; var fr = p ? frames(p.product, App.tilt) : [];
    if (fr.length < 2) { App.loopTimer = setTimeout(tick, 500); return; }
    var start = Math.max(0, fr.length - App.maxVols * 2);
    var cur = App.cursor == null ? fr.length - 1 : fr.indexOf(p.frame);
    var n = cur >= fr.length - 1 || cur < start ? start : cur + 1;
    App.cursor = n === fr.length - 1 ? null : fr[n].time;
    refreshAll();
    App.loopTimer = setTimeout(tick, n === fr.length - 1 ? 1400 : 450);
  };
  tick();
}

// ---------- toolbar ----------
function updateToolbar() {
  var p = App.panels[App.active];
  document.querySelectorAll('[data-prod]').forEach(function (b) { b.classList.toggle('on', !!p && b.dataset.prod === p.product); });
  document.querySelectorAll('[data-layout]').forEach(function (b) { b.classList.toggle('on', +b.dataset.layout === App.layout); });
  $('tiltval').textContent = App.tilt.toFixed(1) + '°';
  var t = latestDataTime();
  var live = App.archiveEnd == null;
  var lag = t ? Math.round((Date.now() - t) / 60000) : null;
  $('mode').textContent = App.loopTimer ? 'LOOP' : App.cursor == null ? (live ? 'LIVE' : 'LATEST') : 'HISTORY';
  $('mode').dataset.kind = App.cursor == null && !App.loopTimer ? (live ? 'live' : 'latest') : 'hist';
  var vcp = null; App.volumes.forEach(function (v) { if (v.meta && v.meta.vcp) vcp = v.meta.vcp; });
  $('volinfo').textContent = App.volumes.length ? App.volumes.length + ' vol' + (vcp ? ' · VCP ' + vcp : '') + (t ? ' · newest ' + fmtZ(t) + (live && lag != null ? ' (' + lag + ' min ago)' : '') : '') : '';
}

// ---------- loading ----------
async function loadSite(site, archiveEnd) {
  site = site.toUpperCase();
  if (!RADARS[site]) { toast('Unknown radar ' + site); return; }
  var gen = ++App.gen;
  App.site = site; App.archiveEnd = archiveEnd || null; App.volumes = []; App.version++; App.cursor = null; App.radar = null;
  App.panels.forEach(function (p) { p.layer.dropTextures(); p.map.jumpTo({ center: [RADARS[site][1], RADARS[site][0]] }); });
  setRadar({ site: site, lat: RADARS[site][0], lon: RADARS[site][1], height: RADARS[site][2] });
  refreshAll();
  setStatus('Listing ' + site + ' volumes…');
  try {
    var list = await Data.listArchive(site, App.maxVols, App.archiveEnd);
    if (gen !== App.gen) return;
    if (!App.archiveEnd) pollLive(gen);
    if (!list.length && App.archiveEnd) { setStatus('No archive volumes found for that time', 'error'); return; }
    var queue = list.slice().reverse(), loaded = 0;
    setStatus('Loading ' + queue.length + ' volumes…');
    var next = function () {
      if (gen !== App.gen || !queue.length) return;
      var item = queue.shift();
      if (findVolumeNear(item.time)) { loaded++; next(); return; }
      var v = addVolume('archive', item.key, item.time);
      Data.request({ type: 'volume', url: item.url }, function (msg) {
        if (gen !== App.gen) return;
        mergeVolume(v, msg); loaded++;
        if (loaded === 1 && App.tilt == null) App.tilt = tilts()[0];
        setStatus(loaded >= list.length ? 'Loaded ' + App.volumes.length + ' volumes' + (App.archiveEnd ? ' (archive)' : '') : 'Loaded ' + loaded + ' of ' + list.length + ' volumes…');
        next();
      });
    };
    next(); next();
  } catch (e) { setStatus('Could not list AWS bucket: ' + e.message, 'error'); }
}
async function pollLive(gen) {
  if (gen !== App.gen || App.archiveEnd) return;
  try {
    var dir = await Data.latestChunkDir(App.site);
    if (dir != null) {
      var dirs = App.liveDir != null && App.liveDir !== dir ? [App.liveDir, dir] : [dir];
      for (var i = 0; i < dirs.length; i++) {
        var chunks = await Data.listChunks(App.site, dirs[i]);
        if (gen !== App.gen || !chunks.length) continue;
        var t = Data.chunkTime(chunks[0].key), key = App.site + '/' + dirs[i] + '/' + t;
        var v = App.volumes.filter(function (x) { return x.id === 'live:' + key; })[0];
        if (!v) {
          if (findVolumeNear(t, 'archive')) continue; // already have the complete file
          v = addVolume('live', key, t);
        }
        if (v.complete) continue;
        await new Promise(function (res) {
          Data.request({ type: 'live', dir: key, urls: chunks.map(function (c) { return c.url; }) }, function (msg) {
            if (gen === App.gen) mergeVolume(v, msg);
            if (msg.done) res();
          }, 0);
        });
      }
      App.liveDir = dir;
    }
    if ($('status').dataset.kind === 'error') setStatus('Live: polling AWS every 10 s');
    updateToolbar();
  } catch (e) { console.warn(e); setStatus('Live update failed, retrying: ' + e.message, 'error'); }
  setTimeout(function () { pollLive(gen); }, 10000);
}

// ---------- keyboard ----------
function onKey(e) {
  var tag = (e.target.tagName || '').toLowerCase();
  if (Warn.dialogOpen() && (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey)))) { Warn.dialogKey(e); return; }
  if (tag === 'input' || tag === 'select' || tag === 'textarea') { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  var k = e.key, lk = k.toLowerCase(), handled = true;
  if (k === 'ArrowUp') stepTilt(1);
  else if (k === 'ArrowDown') stepTilt(-1);
  else if (k === 'ArrowLeft') stepTime(-1);
  else if (k === 'ArrowRight') stepTime(1);
  else if (k === 'Home') { var p = App.panels[App.active], fr = frames(p.product, App.tilt); if (fr.length) { App.cursor = fr[0].time; refreshAll(); } }
  else if (k === 'End') { App.cursor = null; refreshAll(); }
  else if (k === ' ') toggleLoop();
  else if (k === '1' || k === '2' || k === '4') setLayout(+k);
  else if (k === 'Tab') setActive((App.active + (e.shiftKey ? App.layout - 1 : 1)) % App.layout);
  else if (PRODUCT_KEYS[lk] && !e.shiftKey) setProduct(PRODUCT_KEYS[lk]);
  else if (lk === 't') Warn.start('cell');
  else if (lk === 'g') Warn.start(e.shiftKey ? 'line' : 'cell', true);
  else if (lk === 'i') Scit.toggle();
  else if (lk === 'l') Warn.start('line');
  else if (k === 'Enter') Warn.enter();
  else if (k === 'Escape') Warn.cancel();
  else if (lk === 'd') Warn.openDialog();
  else if (lk === 'x' && e.shiftKey) Warn.clearTracks();
  else if (lk === 'x') Warn.clear();
  else if (lk === 'e') Warn.exportGeoJSON();
  else if (lk === 'b') { App.basemap = !App.basemap; App.panels.forEach(function (p) { p.map.setLayoutProperty('basemap', 'visibility', App.basemap ? 'visible' : 'none'); }); toast('Basemap ' + (App.basemap ? 'on (needs internet tiles)' : 'off')); }
  else if (lk === 'k' && e.shiftKey) { App.cwas = !App.cwas; App.panels.forEach(function (p) { p.map.setLayoutProperty('cwa', 'visibility', App.cwas ? 'visible' : 'none'); drawOverlay(p); }); }
  else if (lk === 'k') { App.counties = !App.counties; App.panels.forEach(function (p) { p.map.setLayoutProperty('counties', 'visibility', App.counties ? 'visible' : 'none'); }); }
  else if (lk === 'm') { if (App.radar) App.panels[0].map.easeTo({ center: [App.radar.lon, App.radar.lat], zoom: 7.2 }); }
  else if (k === '/') { $('site').focus(); $('site').select(); }
  else if (lk === 'u') { App.dealias = !App.dealias; toast('Velocity dealiasing ' + (App.dealias ? 'on' : 'off')); refreshAll(); }
  else if (lk === 'o') PSev.toggle();
  else if (k === '?' || lk === 'h') $('help').hidden = !$('help').hidden;
  else handled = false;
  if (handled) e.preventDefault();
}

function init() {
  GEO = { geo: JSON.parse($('geo-data').textContent), cpoly: JSON.parse($('county-data').textContent), cwa: JSON.parse($('cwa-data').textContent) };
  CITY_LABELS = JSON.parse($('label-data').textContent).sort(function (a, b) { return b[1] - a[1]; });
  PLACES = JSON.parse($('place-data').textContent);
  Data.initWorkers($('worker-src').textContent, 3);
  var dl = $('sites');
  Object.keys(RADARS).sort().forEach(function (s) { var o = document.createElement('option'); o.value = s; dl.appendChild(o); });
  var saved = null; try { saved = localStorage.getItem('spcwarn.site'); } catch (e) {}
  var hashSite = (location.hash || '').replace('#', '').toUpperCase();
  App.site = RADARS[hashSite] ? hashSite : RADARS[saved] ? saved : 'KTLX';
  $('site').value = App.site;
  buildPanels();
  document.addEventListener('keydown', onKey);
  $('siteform').addEventListener('submit', function (e) {
    e.preventDefault();
    var s = $('site').value.trim().toUpperCase(), when = $('archive').value;
    try { localStorage.setItem('spcwarn.site', s); } catch (er) {}
    $('site').blur();
    loadSite(s, when ? Date.parse(when + 'Z') : null);
  });
  $('golive').addEventListener('click', function () { $('archive').value = ''; loadSite($('site').value.trim().toUpperCase(), null); });
  document.querySelectorAll('[data-prod]').forEach(function (b) { b.addEventListener('click', function () { setProduct(b.dataset.prod); }); });
  document.querySelectorAll('[data-layout]').forEach(function (b) { b.addEventListener('click', function () { setLayout(+b.dataset.layout); }); });
  $('tiltup').addEventListener('click', function () { stepTilt(1); });
  $('tiltdn').addEventListener('click', function () { stepTilt(-1); });
  $('btn-cell').addEventListener('click', function () { Warn.start('cell'); });
  $('btn-line').addEventListener('click', function () { Warn.start('line'); });
  $('btn-warn').addEventListener('click', function () { Warn.openDialog(); });
  $('btn-trackonly').addEventListener('click', function (e) { Warn.start(e.shiftKey ? 'line' : 'cell', true); });
  $('btn-scit').addEventListener('click', function () { Scit.toggle(); });
  $('btn-psev').addEventListener('click', function () { PSev.toggle(); });
  $('btn-cleartracks').addEventListener('click', function () { Warn.clearTracks(); });
  RadarMenu.init();
  $('btn-help').addEventListener('click', function () { $('help').hidden = !$('help').hidden; });
  $('help').addEventListener('click', function () { $('help').hidden = true; });
  setInterval(updateToolbar, 30000);
  Warn.init();
  loadSite(App.site, null);
}
window.addEventListener('DOMContentLoaded', init);
