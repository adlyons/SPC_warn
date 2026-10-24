// NEXRAD Level II (Archive II, Message 31 and legacy pre-2008 Message 1) decoder. Handles full volumes, real-time chunks,
// split cuts, SAILS / MESO-SAILS and MRLE supplemental cuts (each cut is kept as its own sweep).
var Level2 = (function () {
  var MOMENTS = { REF: 1, VEL: 1, SW: 1, ZDR: 1, PHI: 1, RHO: 1 };
  // 16-bit moments are requantized to 8 bits for display with these codings
  var EIGHT = { ZDR: { scale: 16, offset: 128 }, PHI: { scale: 253 / 360, offset: 2 }, RHO: { scale: 300, offset: -60.5 } };

  function VolumeBuilder() {
    this.site = null; this.lat = null; this.lon = null; this.height = 0; this.vcp = null;
    this.volTime = null; this.sweeps = {}; this.complete = false; this.records = 0;
  }

  // Feed raw file/chunk bytes (Uint8Array). Returns object of touched elevation numbers.
  VolumeBuilder.prototype.feed = function (bytes) {
    var touched = {}, p = 0;
    // volume header: "AR2V00xx." (2000s on) or "ARCHIVE2." (1990s, often with a blank site ID)
    var ar2v = bytes[0] === 0x41 && bytes[1] === 0x52 && bytes[2] === 0x32 && bytes[3] === 0x56;
    var arch = bytes[0] === 0x41 && bytes[1] === 0x52 && bytes[2] === 0x43 && bytes[3] === 0x48 && bytes[7] === 0x32;
    if (bytes.length >= 24 && (ar2v || arch)) {
      var hv = new DataView(bytes.buffer, bytes.byteOffset, 24);
      var jd = hv.getUint32(12), ms = hv.getUint32(16);
      if (this.volTime == null && jd > 0) this.volTime = (jd - 1) * 86400000 + ms;
      if (!this.site) this.site = String.fromCharCode(bytes[20], bytes[21], bytes[22], bytes[23]).replace(/\0/g, '');
      p = 24;
    }
    while (p + 4 <= bytes.length) {
      var size = Math.abs(new DataView(bytes.buffer, bytes.byteOffset + p, 4).getInt32(0));
      // compressed LDM record?
      if (size > 0 && p + 8 <= bytes.length && bytes[p + 4] === 0x42 && bytes[p + 5] === 0x5a && bytes[p + 6] === 0x68) {
        var rec = Bzip2.decompress(bytes.subarray(p + 4, p + 4 + size));
        this.parseMessages(rec, touched);
        this.records++;
        p += 4 + size;
      } else {
        // uncompressed messages for the remainder
        this.parseMessages(bytes.subarray(p), touched);
        break;
      }
    }
    return touched;
  };

  VolumeBuilder.prototype.parseMessages = function (buf, touched) {
    var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), p = 0, n = buf.length;
    while (p + 28 <= n) {
      var sizeHW = dv.getUint16(p + 12), type = dv.getUint8(p + 15);
      if (type === 31) {
        this.parse31(dv, p + 28, touched);
        if (sizeHW === 0) break;
        p += 12 + sizeHW * 2;
      } else {
        if (type === 5 && !this.cutAngles) this.parse5(dv, p + 28);
        else if (type === 1 && p + 2432 <= n) this.parse1(dv, p + 28, touched);
        p += 2432;
      }
    }
  };

  // Message 5 (volume coverage pattern): nominal elevation angle of every cut, indexed by elevation number.
  VolumeBuilder.prototype.parse5 = function (dv, b) {
    var n = dv.getUint16(b + 6), cuts = {};
    if (n < 1 || n > 40 || b + 22 + n * 46 > dv.byteLength) return;
    for (var i = 0; i < n; i++) cuts[i + 1] = Math.round(dv.getUint16(b + 22 + i * 46) * 180 / 32768 * 100) / 100;
    this.cutAngles = cuts;
    if (this.vcp == null) this.vcp = dv.getUint16(b + 4);
  };

  // Legacy Message 1 (before 2008): 1 degree radials, REF at 1 km gates, VEL / SW at 250 m. Pointers are relative to b.
  VolumeBuilder.prototype.parse1 = function (dv, b, touched) {
    var collMs = dv.getUint32(b), date = dv.getUint16(b + 4);
    var az = dv.getUint16(b + 8) * 180 / 32768, status = dv.getUint16(b + 12);
    var elev = dv.getUint16(b + 14) * 180 / 32768, elevNum = dv.getUint16(b + 16);
    var firstS = dv.getInt16(b + 18), firstD = dv.getInt16(b + 20), sizeS = dv.getUint16(b + 22), sizeD = dv.getUint16(b + 24);
    var nS = dv.getUint16(b + 26), nD = dv.getUint16(b + 28);
    var pS = dv.getUint16(b + 36), pV = dv.getUint16(b + 38), pW = dv.getUint16(b + 40), velRes = dv.getUint16(b + 42);
    if (!elevNum || elevNum > 40) return;
    var t = (date - 1) * 86400000 + collMs;
    if (this.volTime == null) this.volTime = t;
    if (this.vcp == null) this.vcp = dv.getUint16(b + 44);
    if (status === 4) this.complete = true;
    var sw = this.sweeps[elevNum];
    if (!sw) sw = this.sweeps[elevNum] = { elevNum: elevNum, res: 1, rows: 360, elevSum: 0, nrad: 0, time: t, endTime: t, nyquist: null, moments: {}, ended: false };
    sw.elevSum += elev; sw.nrad++;
    if (t < sw.time) sw.time = t; if (t > sw.endTime) sw.endTime = t;
    if (status === 2 || status === 4) sw.ended = true;
    var nyq = dv.getUint16(b + 60); if (nyq && sw.nyquist == null) sw.nyquist = nyq / 100;
    var row = Math.floor(az) % 360;
    touched[elevNum] = true;
    function put(name, ptr, ng, first, spacing, scale, offset) {
      if (!ptr || !ng || b + ptr + ng > dv.byteLength) return;
      var m = sw.moments[name];
      if (!m) m = sw.moments[name] = { ngates: ng, first: first, spacing: spacing, scale: scale, offset: offset, word: 8, data: new Uint8Array(360 * ng) };
      var k = Math.min(ng, m.ngates);
      m.data.set(new Uint8Array(dv.buffer, dv.byteOffset + b + ptr, k), row * m.ngates);
    }
    put('REF', pS, nS, firstS, sizeS, 2, 66);
    put('VEL', pV, nD, firstD, sizeD, velRes === 4 ? 1 : 2, 129);
    put('SW', pW, nD, firstD, sizeD, 2, 129);
  };

  VolumeBuilder.prototype.parse31 = function (dv, b, touched) {
    var collMs = dv.getUint32(b + 4), date = dv.getUint16(b + 8);
    var az = dv.getFloat32(b + 12), azResCode = dv.getUint8(b + 20), status = dv.getUint8(b + 21);
    var elevNum = dv.getUint8(b + 22), elev = dv.getFloat32(b + 24), nBlocks = dv.getUint16(b + 30);
    var t = (date - 1) * 86400000 + collMs;
    if (!this.site) this.site = String.fromCharCode(dv.getUint8(b), dv.getUint8(b + 1), dv.getUint8(b + 2), dv.getUint8(b + 3));
    if (this.volTime == null) this.volTime = t;
    if (status === 4) this.complete = true;
    var res = azResCode === 1 ? 0.5 : 1.0;
    var sw = this.sweeps[elevNum];
    if (!sw) {
      sw = this.sweeps[elevNum] = { elevNum: elevNum, res: res, rows: Math.round(360 / res), elevSum: 0, nrad: 0,
        time: t, endTime: t, nyquist: null, moments: {}, ended: false };
    }
    sw.elevSum += elev; sw.nrad++;
    if (t < sw.time) sw.time = t; if (t > sw.endTime) sw.endTime = t;
    if (status === 2 || status === 4) sw.ended = true;
    var row = Math.floor((az % 360) / sw.res) % sw.rows;
    touched[elevNum] = true;
    for (var i = 0; i < nBlocks && i < 12; i++) {
      var ptr = dv.getUint32(b + 32 + i * 4);
      if (!ptr) continue;
      var bp = b + ptr;
      if (bp + 28 > dv.byteLength) continue;
      var name = String.fromCharCode(dv.getUint8(bp + 1), dv.getUint8(bp + 2), dv.getUint8(bp + 3)).trim();
      if (name === 'VOL') {
        if (this.lat == null) {
          this.lat = dv.getFloat32(bp + 8); this.lon = dv.getFloat32(bp + 12);
          this.height = dv.getInt16(bp + 16) + dv.getUint16(bp + 18);
          this.vcp = dv.getUint16(bp + 40);
        }
      } else if (name === 'RAD') {
        if (sw.nyquist == null) sw.nyquist = dv.getInt16(bp + 16) / 100;
      } else if (MOMENTS[name]) {
        var ng = dv.getUint16(bp + 8), first = dv.getInt16(bp + 10), spacing = dv.getUint16(bp + 12);
        var word = dv.getUint8(bp + 19), scale = dv.getFloat32(bp + 20), offset = dv.getFloat32(bp + 24);
        if (bp + 28 + ng * (word / 8) > dv.byteLength) continue;
        var m = sw.moments[name];
        if (!m || m.ngates < ng) {
          var old = m;
          m = { ngates: ng, first: first, spacing: spacing, scale: scale, offset: offset, word: word, data: new Uint8Array(sw.rows * ng) };
          if (word === 16) { var t8 = EIGHT[name] || { scale: 1, offset: 128 }; m.scale = t8.scale; m.offset = t8.offset; m.srcScale = scale; m.srcOffset = offset; }
          if (old) for (var r = 0; r < sw.rows; r++) m.data.set(old.data.subarray(r * old.ngates, (r + 1) * old.ngates), r * ng);
          sw.moments[name] = m;
        }
        var base = row * m.ngates, src = bp + 28, d = m.data, g;
        if (word === 8) {
          var u8 = new Uint8Array(dv.buffer, dv.byteOffset + src, ng);
          d.set(u8, base);
        } else {
          for (g = 0; g < ng; g++) {
            var raw = dv.getUint16(src + g * 2);
            if (raw < 2) d[base + g] = raw;
            else {
              var phys = (raw - m.srcOffset) / m.srcScale;
              var c = Math.round(phys * m.scale + m.offset); d[base + g] = c < 2 ? 2 : c > 255 ? 255 : c;
            }
          }
        }
      }
    }
  };

  // Export sweeps as plain objects. copy=true when the builder will keep mutating (live chunks).
  VolumeBuilder.prototype.export = function (elevNums, copy) {
    var out = [], transfer = [], keys = elevNums || Object.keys(this.sweeps);
    for (var i = 0; i < keys.length; i++) {
      var sw = this.sweeps[keys[i]];
      if (!sw) continue;
      var moms = {};
      for (var k in sw.moments) {
        var m = sw.moments[k], data = copy ? m.data.slice() : m.data;
        moms[k] = { ngates: m.ngates, first: m.first, spacing: m.spacing, scale: m.scale, offset: m.offset, data: data };
        transfer.push(data.buffer);
      }
      out.push({ elevNum: sw.elevNum, cutAngle: this.cutAngles ? this.cutAngles[sw.elevNum] : null, res: sw.res, rows: sw.rows, elev: sw.elevSum / sw.nrad, nrad: sw.nrad,
        time: sw.time, endTime: sw.endTime, nyquist: sw.nyquist, ended: sw.ended, moments: moms });
    }
    return {
      meta: { site: this.site, lat: this.lat, lon: this.lon, height: this.height, vcp: this.vcp, volTime: this.volTime, complete: this.complete },
      sweeps: out, transfer: transfer
    };
  };

  return { VolumeBuilder: VolumeBuilder };
})();
if (typeof module !== 'undefined') module.exports = Level2;
