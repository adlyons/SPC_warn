// Velocity dealiasing (2D continuity unfolding, written for this app) and storm-relative velocity.
var Vel = (function () {
  function toFloat(m) {
    var n = m.data.length, v = new Float32Array(n);
    for (var i = 0; i < n; i++) { var c = m.data[i]; v[i] = c < 2 ? NaN : (c - m.offset) / m.scale; }
    return v;
  }
  function encode(m, v, src) {
    var out = new Uint8Array(v.length);
    for (var i = 0; i < v.length; i++) {
      if (v[i] !== v[i]) { out[i] = src.data[i] === 1 ? 1 : 0; continue; }
      var c = Math.round(v[i] * m.scale + m.offset); out[i] = c < 2 ? 2 : c > 255 ? 255 : c;
    }
    return { ngates: m.ngates, first: m.first, spacing: m.spacing, scale: m.scale, offset: m.offset, data: out };
  }
  // Unfold aliased radial velocities in two steps.
  // 1) Fold-aware VAD: for each 10 km range ring, find the uniform wind (u, v) whose radial component best matches the
  //    observations modulo the Nyquist interval (score = sum of cos(pi * (obs - model) / Vn), which ignores folding).
  // 2) Unfold every gate to the value closest to that environmental wind, then run local-continuity passes so that
  //    storm-scale features that differ from the environment by more than Vn (couplets, RIJ) follow their neighbours.
  function dealias(sw) {
    var m = sw.moments.VEL; if (!m) return null;
    if (sw._deal && sw._deal.src === m) return sw._deal.m;
    var Vn = sw.nyquist, ng = m.ngates, rows = sw.rows;
    if (!Vn || Vn <= 0) return m;
    var v = toFloat(m), twoV = 2 * Vn, k = Math.PI / Vn;
    var cosE = Math.cos(sw.elev * Math.PI / 180), ringM = 10000;
    var nRing = Math.ceil((m.first + ng * m.spacing) * cosE / ringM) + 1;
    var sinA = new Float32Array(rows), cosA = new Float32Array(rows);
    for (var r = 0; r < rows; r++) { var az = (r + 0.5) * sw.res * Math.PI / 180; sinA[r] = Math.sin(az) * cosE; cosA[r] = Math.cos(az) * cosE; }
    var ringU = new Float32Array(nRing).fill(NaN), ringV = new Float32Array(nRing).fill(NaN);
    var rStep = Math.max(1, Math.round(rows / 240)), gStep = 5;
    for (var ri = 0; ri < nRing; ri++) {
      var g0 = Math.max(0, Math.floor((ri * ringM / cosE - m.first) / m.spacing)), g1 = Math.min(ng, Math.floor(((ri + 1) * ringM / cosE - m.first) / m.spacing));
      var ss = [], cc = [], oo = [];
      for (var r2 = 0; r2 < rows; r2 += rStep) for (var g = g0; g < g1; g += gStep) { var x = v[r2 * ng + g]; if (x === x) { ss.push(sinA[r2]); cc.push(cosA[r2]); oo.push(x); } }
      if (ss.length < 120) continue;
      var n = ss.length, best = -Infinity, bu = 0, bv = 0;
      var search = function (u0, v0, span, step) {
        for (var uu = u0 - span; uu <= u0 + span; uu += step) for (var vv = v0 - span; vv <= v0 + span; vv += step) {
          var sc = 0;
          for (var i = 0; i < n; i++) sc += Math.cos(k * (oo[i] - uu * ss[i] - vv * cc[i]));
          if (sc > best) { best = sc; bu = uu; bv = vv; }
        }
      };
      search(0, 0, 60, 6); search(bu, bv, 6, 1);
      if (best / n > 0.25) { ringU[ri] = bu; ringV[ri] = bv; }
    }
    // fill rings without a good fit from the nearest fitted rings
    var any = false; for (var q = 0; q < nRing; q++) if (ringU[q] === ringU[q]) any = true;
    if (!any) { ringU.fill(0); ringV.fill(0); }
    for (var q2 = 0; q2 < nRing; q2++) if (ringU[q2] !== ringU[q2]) {
      for (var d = 1; d < nRing; d++) {
        var lo = q2 - d, hi = q2 + d;
        if (lo >= 0 && ringU[lo] === ringU[lo]) { ringU[q2] = ringU[lo]; ringV[q2] = ringV[lo]; break; }
        if (hi < nRing && ringU[hi] === ringU[hi]) { ringU[q2] = ringU[hi]; ringV[q2] = ringV[hi]; break; }
      }
    }
    // step 2: unfold toward the environmental wind
    for (var r3 = 0; r3 < rows; r3++) {
      var b = r3 * ng;
      for (var g2 = 0; g2 < ng; g2++) {
        var x2 = v[b + g2]; if (x2 !== x2) continue;
        var rr = (m.first + g2 * m.spacing) * cosE / ringM, i0 = Math.min(nRing - 1, Math.floor(rr)), i1 = Math.min(nRing - 1, i0 + 1), f = rr - i0;
        var uu2 = ringU[i0] * (1 - f) + ringU[i1] * f, vv2 = ringV[i0] * (1 - f) + ringV[i1] * f;
        var ref = uu2 * sinA[r3] + vv2 * cosA[r3];
        v[b + g2] = x2 + Math.round((ref - x2) / twoV) * twoV;
      }
    }
    // step 3: local continuity passes (3 radials x 7 gates)
    for (var pass = 0; pass < 3; pass++) {
      var out = new Float32Array(v), changed = 0;
      for (var r4 = 0; r4 < rows; r4++) for (var g3 = 0; g3 < ng; g3++) {
        var idx = r4 * ng + g3, x3 = v[idx]; if (x3 !== x3) continue;
        var sm = 0, cn = 0;
        for (var dr = -1; dr <= 1; dr++) {
          var row = (r4 + dr + rows) % rows;
          for (var dg = -3; dg <= 3; dg++) { var gg = g3 + dg; if ((dr || dg) && gg >= 0 && gg < ng) { var y = v[row * ng + gg]; if (y === y) { sm += y; cn++; } } }
        }
        if (cn >= 8) { var mean = sm / cn; if (Math.abs(x3 - mean) > Vn) { out[idx] = x3 + Math.round((mean - x3) / twoV) * twoV; changed++; } }
      }
      v = out;
      if (!changed) break;
    }
    var res = encode(m, v, m);
    sw._deal = { src: m, m: res, wind: { u: ringU, v: ringV } };
    return res;
  }
  // Storm motion used for SRV. SCIT motion is the first guess; the user can switch to their track or type a motion (SRV motion box).
  function trackMotion() {
    var W = Warn._W;
    if (W.motion) return { from: W.motion.from, kt: W.motion.kt, src: 'track' };
    if (W.tracks.length) { var t = W.tracks[W.tracks.length - 1]; return { from: t.motion.from, kt: t.motion.kt, src: 'track' }; }
    return null;
  }
  function motion() {
    if (App.srvSource === 'manual' && App.srvManual) return { from: App.srvManual.from, kt: App.srvManual.kt, src: 'manual' };
    if (App.srvSource === 'track') { var tm = trackMotion(); if (tm) return tm; }
    return Scit.motion() || trackMotion();
  }
  function srv(sw) {
    var base = App.dealias ? dealias(sw) : sw.moments.VEL; if (!base) return null;
    var mo = motion(); if (!mo) return base;
    var key = mo.from.toFixed(1) + '/' + mo.kt.toFixed(1) + '/' + App.dealias;
    if (sw._srv && sw._srv.key === key && sw._srv.src === base) return sw._srv.m;
    var to = (mo.from + 180) * Math.PI / 180, spd = mo.kt / 1.943844, u = Math.sin(to) * spd, vv = Math.cos(to) * spd;
    var v = toFloat(base), ng = base.ngates, rows = sw.rows;
    for (var r = 0; r < rows; r++) {
      var az = (r + 0.5) * sw.res * Math.PI / 180, comp = u * Math.sin(az) + vv * Math.cos(az), b = r * ng;
      for (var g = 0; g < ng; g++) v[b + g] -= comp;
    }
    var res = encode(base, v, base);
    sw._srv = { key: key, src: base, m: res };
    return res;
  }
  return { dealias: dealias, srv: srv, motion: motion };
})();
// The moment actually displayed / sampled for a frame (raw, dealiased or storm-relative).
function momentOf(f) {
  if (!f) return null;
  var sw = f.sweep;
  if (f.product === 'VEL') return App.dealias ? Vel.dealias(sw) : sw.moments.VEL;
  if (f.product === 'SRV') return Vel.srv(sw);
  return sw.moments[f.product];
}
