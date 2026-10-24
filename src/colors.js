// Color tables for each product. Values are physical units (REF dBZ, VEL/SW kt, ZDR dB, RHO, PHI deg).
var Colors = (function () {
  var MS2KT = 1.943844;
  var TABLES = {
    REF: { units: 'dBZ', conv: 1, stops: [[5, '#3a4a5c'], [10, '#5a7d99'], [15, '#4aa3c9'], [20, '#2fbf4f'], [25, '#1f9a36'], [30, '#127523'],
      [35, '#e9e432'], [40, '#e3b21f'], [45, '#ee7b19'], [50, '#e2231a'], [55, '#b0071d'], [60, '#ee28ee'], [65, '#a020c8'], [70, '#ffffff'], [75, '#a8ffff'], [80, '#a8ffff']] , min: 5 },
    VEL: { units: 'kt', conv: MS2KT, stops: [[-120, '#e8fff0'], [-80, '#4dff95'], [-60, '#00e050'], [-40, '#00a83a'], [-20, '#0b6a26'], [-5, '#2b4d34'], [0, '#555555'],
      [5, '#5a2b2b'], [20, '#7d0e0e'], [40, '#c70f0f'], [60, '#ff3030'], [80, '#ff9a9a'], [120, '#fff7b0']], rf: '#7b2fa8' },
    SW: { units: 'kt', conv: MS2KT, stops: [[0, '#2a2a2a'], [5, '#5a5a5a'], [10, '#8c8c8c'], [15, '#d6c341'], [20, '#e8861d'], [25, '#e2231a'], [35, '#ffffff']], rf: '#7b2fa8', min: 0.5 },
    ZDR: { units: 'dB', conv: 1, stops: [[-4, '#1c1c1c'], [-2, '#4b4b4b'], [-0.5, '#8a8a8a'], [0, '#a8a8c8'], [0.5, '#3e64d6'], [1, '#3fa9e0'], [1.5, '#3ec46b'], [2, '#9ad13a'], [2.5, '#e6e03a'], [3, '#f0a030'],
      [4, '#e2231a'], [5, '#b0071d'], [6, '#ee5aee'], [8, '#ffffff']] },
    RHO: { units: '', conv: 1, stops: [[0.2, '#151535'], [0.45, '#2a2a8a'], [0.65, '#3c6ed0'], [0.75, '#3aaed8'], [0.8, '#40c060'], [0.85, '#8fd03a'], [0.9, '#e6dd3a'],
      [0.93, '#f0a030'], [0.95, '#e8661c'], [0.97, '#e2231a'], [0.99, '#b0071d'], [1.0, '#8a1068'], [1.05, '#f2c0f2']], min: 0.2 },
    PHI: { units: '°', conv: 1, stops: [[0, '#3a1a6a'], [45, '#2d4fd6'], [90, '#2fb8d8'], [135, '#3ec46b'], [180, '#e6e03a'], [225, '#f0a030'], [270, '#e2231a'], [315, '#d040c0'], [360, '#ffffff']] }
  };
  TABLES.SRV = TABLES.VEL;
  var NAMES = { REF: 'Reflectivity', VEL: 'Velocity', SRV: 'Storm-Rel. Velocity', SW: 'Spectrum Width', ZDR: 'Diff. Reflectivity', RHO: 'Correlation Coef.', PHI: 'Diff. Phase' };
  function hex(h) { return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)]; }
  function colorAt(prod, v) {
    var t = TABLES[prod], s = t.stops;
    if (t.min != null && v < t.min) return null;
    if (v <= s[0][0]) return hex(s[0][1]);
    for (var i = 1; i < s.length; i++) if (v < s[i][0]) {
      var a = hex(s[i - 1][1]), b = hex(s[i][1]), f = (v - s[i - 1][0]) / (s[i][0] - s[i - 1][0]);
      // REF uses stepped bands with mild blending, others are smooth
      if (prod === 'REF') f = f * 0.55;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    }
    return hex(s[s.length - 1][1]);
  }
  var lutCache = {};
  // 256-entry RGBA lookup from 8-bit code to color.
  function lut(prod, scale, offset) {
    var key = prod + scale + '/' + offset;
    if (lutCache[key]) return lutCache[key];
    var t = TABLES[prod], out = new Uint8Array(256 * 4);
    for (var c = 2; c < 256; c++) {
      var v = (c - offset) / scale * t.conv, col = colorAt(prod, v);
      if (col) { out[c * 4] = col[0]; out[c * 4 + 1] = col[1]; out[c * 4 + 2] = col[2]; out[c * 4 + 3] = 255; }
    }
    if (t.rf) { var r = hex(t.rf); out[4] = r[0]; out[5] = r[1]; out[6] = r[2]; out[7] = 255; }
    return (lutCache[key] = out);
  }
  function value(prod, m, code) { // physical value in display units, null for no data, 'RF' for range folded
    if (code === 0) return null;
    if (code === 1) return 'RF';
    return (code - m.offset) / m.scale * TABLES[prod].conv;
  }
  return { TABLES: TABLES, NAMES: NAMES, lut: lut, value: value, colorAt: colorAt, MS2KT: MS2KT };
})();
