// Level III Storm Tracking Information (NST, product 58) parser: storm IDs, past and forecast tracks.
var Level3 = (function () {
  function parseNST(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // find message header: product code 58 followed by the -1 divider of the description block 18 bytes later
    var h = -1;
    for (var i = 0; i < Math.min(200, bytes.length - 40); i++) if (dv.getInt16(i) === 58 && dv.getInt16(i + 18) === -1) { h = i; break; }
    if (h < 0) throw new Error('not an NST product');
    var pd = h + 18;
    var lat = dv.getInt32(pd + 2) / 1000, lon = dv.getInt32(pd + 6) / 1000;
    var vdate = dv.getUint16(pd + 22), vtime = dv.getUint32(pd + 24);
    var symOff = dv.getUint32(pd + 90) * 2;
    var out = { lat: lat, lon: lon, time: (vdate - 1) * 86400000 + vtime * 1000, storms: [] };
    if (!symOff) return out;
    var p = h + symOff;
    if (dv.getInt16(p) !== -1) return out;
    var nLayers = dv.getUint16(p + 8); p += 10;
    var cur = null;
    function storm() { if (!cur) { cur = { id: null, pos: null, past: [], fcst: [] }; out.storms.push(cur); } return cur; }
    function xy(I, J) { return [I / 4, J / 4]; } // km east, km north (verified against KINX 7 May 2024)
    function readSub(q, end, target) {
      while (q + 4 <= end) {
        var code = dv.getUint16(q), len = dv.getUint16(q + 2), body = q + 4;
        if (code === 2) target.points.push(xy(dv.getInt16(body), dv.getInt16(body + 2)));
        q = body + len;
      }
    }
    for (var L = 0; L < nLayers; L++) {
      if (dv.getInt16(p) !== -1) break;
      var lend = p + 6 + dv.getUint32(p + 2); p += 6;
      while (p + 4 <= lend) {
        var code = dv.getUint16(p), len = dv.getUint16(p + 2), b = p + 4;
        if (code === 15) {
          cur = { id: String.fromCharCode(dv.getUint8(b + 4), dv.getUint8(b + 5)), pos: xy(dv.getInt16(b), dv.getInt16(b + 2)), past: [], fcst: [] };
          out.storms.push(cur);
        } else if (code === 23 || code === 24) {
          var t = { points: [] }; readSub(b, b + len, t);
          var s = storm();
          if (code === 23) s.past = s.past.concat(t.points); else s.fcst = s.fcst.concat(t.points);
        } else if (code === 25) {
          var s2 = storm(); if (!s2.pos) s2.pos = xy(dv.getInt16(b), dv.getInt16(b + 2));
        }
        p = b + len;
      }
      p = lend;
    }
    out.storms = out.storms.filter(function (s) { return s.pos; });
    // tabular block: storm-average motion and the SCIT adaptation default motion (both "from" direction)
    var txt = ''; for (var k = 0; k < bytes.length; k++) { var c = bytes[k]; txt += c >= 32 && c < 127 ? String.fromCharCode(c) : ' '; }
    var m = /AVG SPEED\s+(\d+)\s+KTS\s+AVG DIRECTION\s+(\d+)\s+DEG/.exec(txt);
    if (m) out.avg = { from: +m[2] % 360, kt: +m[1] };
    var dd = /([\d.]+)\s+\(DEG\)\s+DEFAULT \(DIRECTION\)/.exec(txt), ds = /([\d.]+)\s+\(KTS\)\s+DEFAULT \(SPEED\)/.exec(txt);
    if (dd && ds) out.dflt = { from: +dd[1] % 360, kt: +ds[1] };
    return out;
  }
  return { parseNST: parseNST };
})();
if (typeof module !== 'undefined') module.exports = Level3;
