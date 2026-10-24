// Minimal, fast bzip2 decompressor (single or multi-stream). Returns Uint8Array.
var Bzip2 = (function () {
  var CRC_TABLE = null;
  function decompress(src) {
    var pos = 0, bitBuf = 0, bitCount = 0, srcLen = src.length;
    function bits(n) {
      while (bitCount < n) { bitBuf = (bitBuf << 8) | (pos < srcLen ? src[pos] : 0); pos++; bitCount += 8; }
      bitCount -= n;
      return (bitBuf >>> bitCount) & ((1 << n) - 1);
    }
    var out = new Uint8Array(Math.max(1024, srcLen * 6)), outPos = 0;
    function grow(need) {
      if (outPos + need <= out.length) return;
      var n = new Uint8Array(Math.max(out.length * 2, outPos + need));
      n.set(out.subarray(0, outPos)); out = n;
    }
    var tt = null;
    while (pos < srcLen) {
      // stream header
      if (bits(8) !== 0x42 || bits(8) !== 0x5a || bits(8) !== 0x68) break;
      var level = bits(8) - 48;
      if (level < 1 || level > 9) throw new Error('bzip2: bad level');
      var blockMax = level * 100000;
      if (!tt || tt.length < blockMax) tt = new Uint32Array(blockMax);
      for (;;) {
        var m1 = bits(24), m2 = bits(24);
        if (m1 === 0x177245 && m2 === 0x385090) { bits(16); bits(16); bitCount -= bitCount & 7; break; }
        if (m1 !== 0x314159 || m2 !== 0x265359) throw new Error('bzip2: bad block magic');
        bits(16); bits(16); // crc
        if (bits(1)) throw new Error('bzip2: randomised blocks unsupported');
        var origPtr = bits(24);
        var used = bits(16), symToByte = new Uint8Array(256), nInUse = 0, i, j, k;
        for (i = 0; i < 16; i++) if (used & (0x8000 >> i)) {
          var b = bits(16);
          for (j = 0; j < 16; j++) if (b & (0x8000 >> j)) symToByte[nInUse++] = i * 16 + j;
        }
        var alphaSize = nInUse + 2;
        var nGroups = bits(3), nSelectors = bits(15);
        var mtfG = [0, 1, 2, 3, 4, 5], selectors = new Uint8Array(nSelectors);
        for (i = 0; i < nSelectors; i++) {
          j = 0; while (bits(1)) j++;
          var v = mtfG[j]; for (; j > 0; j--) mtfG[j] = mtfG[j - 1]; mtfG[0] = v; selectors[i] = v;
        }
        var limits = [], bases = [], perms = [], minLens = [];
        for (var g = 0; g < nGroups; g++) {
          var lens = new Uint8Array(alphaSize), cur = bits(5);
          for (i = 0; i < alphaSize; i++) {
            while (bits(1)) cur += bits(1) ? -1 : 1;
            lens[i] = cur;
          }
          var minL = 32, maxL = 0;
          for (i = 0; i < alphaSize; i++) { if (lens[i] > maxL) maxL = lens[i]; if (lens[i] < minL) minL = lens[i]; }
          var perm = new Int32Array(alphaSize), limit = new Int32Array(22), base = new Int32Array(22), pp = 0;
          for (i = minL; i <= maxL; i++) for (j = 0; j < alphaSize; j++) if (lens[j] === i) perm[pp++] = j;
          var cnt = new Int32Array(23);
          for (i = 0; i < alphaSize; i++) cnt[lens[i] + 1]++;
          for (i = 1; i < 23; i++) cnt[i] += cnt[i - 1];
          var vec = 0;
          for (i = minL; i <= maxL; i++) { vec += cnt[i + 1] - cnt[i]; limit[i] = vec - 1; vec <<= 1; }
          for (i = minL + 1; i <= maxL; i++) base[i] = ((limit[i - 1] + 1) << 1) - cnt[i];
          base[minL] = 0; // cnt[minL] is 0
          limits.push(limit); bases.push(base); perms.push(perm); minLens.push(minL);
          for (i = 0; i < 21; i++) if (limit[i] === 0 && i > maxL) limit[i] = 0;
          limit[maxL + 1] = 0x7fffffff;
        }
        // decode MTF/Huffman
        var mtf = new Uint8Array(256); for (i = 0; i < 256; i++) mtf[i] = i;
        var unzftab = new Int32Array(256), nblock = 0, eob = nInUse + 1;
        var groupPos = 0, groupNo = -1, lim, bas, prm, mnl;
        var runPos = 0, runLen = 0, sym;
        for (;;) {
          if (groupPos === 0) { groupNo++; groupPos = 50; var sel = selectors[groupNo]; lim = limits[sel]; bas = bases[sel]; prm = perms[sel]; mnl = minLens[sel]; }
          groupPos--;
          var zn = mnl, zvec = bits(zn);
          while (zvec > lim[zn]) { zn++; zvec = (zvec << 1) | bits(1); }
          sym = prm[zvec - bas[zn]];
          if (sym <= 1) { // RUNA/RUNB
            if (runPos === 0) { runPos = 1; runLen = 0; }
            runLen += (sym + 1) * runPos; runPos <<= 1;
            continue;
          }
          if (runPos) {
            runPos = 0; var bb = symToByte[mtf[0]];
            unzftab[bb] += runLen;
            while (runLen--) tt[nblock++] = bb;
          }
          if (sym === eob) break;
          var idx = sym - 1, val = mtf[idx];
          for (k = idx; k > 0; k--) mtf[k] = mtf[k - 1];
          mtf[0] = val; var by = symToByte[val];
          unzftab[by]++; tt[nblock++] = by;
        }
        // inverse BWT
        var cftab = new Int32Array(256), sum = 0;
        for (i = 0; i < 256; i++) { cftab[i] = sum; sum += unzftab[i]; }
        for (i = 0; i < nblock; i++) { var c = tt[i] & 0xff; tt[cftab[c]] |= i << 8; cftab[c]++; }
        if (nblock) {
          grow(nblock * 2 + 1024);
          var tPos = tt[origPtr] >>> 8, last = -1, run = 0, ch;
          for (i = 0; i < nblock; i++) {
            tPos = tt[tPos]; ch = tPos & 0xff; tPos >>>= 8;
            if (run === 4) {
              if (ch) { grow(ch); for (k = 0; k < ch; k++) out[outPos++] = last; }
              run = 0; last = -1; continue;
            }
            if (ch === last) run++; else { run = 1; last = ch; }
            if (outPos >= out.length) grow(1024);
            out[outPos++] = ch;
          }
        }
        for (i = 0; i < nblock; i++) tt[i] = 0;
      }
    }
    return out.subarray(0, outPos);
  }
  return { decompress: decompress };
})();
if (typeof module !== 'undefined') module.exports = Bzip2;
