// Data access: AWS listings, worker pool, volume store and frame (scan) indexing.
var Data = (function () {
  var ARCHIVE = 'https://unidata-nexrad-level2.s3.amazonaws.com';
  var CHUNKS = 'https://unidata-nexrad-level2-chunks.s3.amazonaws.com';
  var STD_TILTS = [-0.5, -0.4, -0.3, -0.2, -0.1, 0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.9, 1.3, 1.5, 1.8, 2.4, 2.5, 3.1, 3.5, 4.0, 4.5, 5.1, 6.0, 6.4, 7.5, 8.0, 8.7, 10.0, 12.0, 12.5, 14.0, 15.6, 16.7, 19.5];

  function nominal(e) {
    var best = null, bd = 1e9;
    for (var i = 0; i < STD_TILTS.length; i++) { var d = Math.abs(STD_TILTS[i] - e); if (d < bd) { bd = d; best = STD_TILTS[i]; } }
    return bd <= 0.22 ? best : Math.round(e * 10) / 10;
  }

  async function listXML(url) {
    var r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('Listing failed (HTTP ' + r.status + ')');
    return new DOMParser().parseFromString(await r.text(), 'application/xml');
  }
  function texts(doc, tag) { return Array.prototype.map.call(doc.getElementsByTagName(tag), function (n) { return n.textContent; }); }

  function ymd(d) { return d.getUTCFullYear() + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + String(d.getUTCDate()).padStart(2, '0'); }
  function keyTime(key) { // .../KTLX20261023_225041_V06
    var m = /(\d{8})_(\d{6})/.exec(key); if (!m) return null;
    var s = m[1], t = m[2];
    return Date.UTC(+s.substr(0, 4), +s.substr(4, 2) - 1, +s.substr(6, 2), +t.substr(0, 2), +t.substr(2, 2), +t.substr(4, 2));
  }
  // Most recent archive volume keys for a site, newest last. `end` (ms) for archived cases.
  async function listArchive(site, n, end) {
    var keys = [], day = new Date(end || Date.now());
    for (var back = 0; back < 3 && keys.length < n; back++) {
      var d = new Date(day.getTime() - back * 86400000);
      var doc = await listXML(ARCHIVE + '/?list-type=2&prefix=' + ymd(d) + '/' + site + '/');
      var ks = texts(doc, 'Key').filter(function (k) { return !/_MDM$/.test(k) && keyTime(k) != null && (!end || keyTime(k) <= end); });
      keys = ks.concat(keys);
    }
    return keys.slice(-n).map(function (k) { return { key: k, url: ARCHIVE + '/' + k, time: keyTime(k) }; });
  }
  async function latestChunkDir(site) {
    var doc = await listXML(CHUNKS + '/?list-type=2&delimiter=/&prefix=' + site + '/');
    var nums = texts(doc, 'Prefix').map(function (p) { return +(p.split('/')[1]); }).filter(function (x) { return x > 0; }).sort(function (a, b) { return a - b; });
    if (!nums.length) return null;
    var best = -1, latest = nums[nums.length - 1];
    for (var i = 0; i < nums.length; i++) { // number right before the largest circular gap
      var next = i < nums.length - 1 ? nums[i + 1] : nums[0] + 1000, g = next - nums[i];
      if (g > best) { best = g; latest = nums[i]; }
    }
    return latest;
  }
  async function listChunks(site, dir) {
    var doc = await listXML(CHUNKS + '/?list-type=2&prefix=' + site + '/' + dir + '/');
    return texts(doc, 'Key').sort(function (a, b) { return chunkNum(a) - chunkNum(b); }).map(function (k) { return { key: k, url: CHUNKS + '/' + k }; });
  }
  function chunkNum(k) { var m = /-(\d+)-[SIE]$/.exec(k); return m ? +m[1] : 0; }
  function chunkTime(k) { var m = /(\d{8})-(\d{6})-\d+-[SIE]$/.exec(k); if (!m) return null; return keyTime(m[1] + '_' + m[2]); }

  // ---- worker pool ----
  var workers = [], pending = {}, seq = 0, rr = 0;
  function initWorkers(src, n) {
    var url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    for (var i = 0; i < n; i++) {
      var w = new Worker(url);
      w.onmessage = function (ev) { var cb = pending[ev.data.id]; if (cb) { cb(ev.data); if (ev.data.done) delete pending[ev.data.id]; } };
      workers.push(w);
    }
  }
  function request(msg, cb, workerIndex) {
    msg.id = ++seq; pending[msg.id] = cb;
    var w = workerIndex != null ? workers[workerIndex] : workers[1 + (rr++ % (workers.length - 1))];
    w.postMessage(msg);
  }

  return { nominal: nominal, listArchive: listArchive, latestChunkDir: latestChunkDir, listChunks: listChunks,
    chunkTime: chunkTime, keyTime: keyTime, initWorkers: initWorkers, request: request };
})();
