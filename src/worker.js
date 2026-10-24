// Decode worker: fetches archive volumes or real-time chunks and decodes them off the main thread.
var live = {}; // dir -> {builder, done:Set}
function post(id, builder, elevNums, copy, extra) {
  var e = builder.export(elevNums, copy);
  var msg = { id: id, meta: e.meta, sweeps: e.sweeps };
  for (var k in extra) msg[k] = extra[k];
  self.postMessage(msg, e.transfer);
}
async function getBytes(url) {
  var r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
  var b = new Uint8Array(await r.arrayBuffer());
  // archive files before about 2016 are whole-file gzip (.gz)
  if (b[0] === 0x1f && b[1] === 0x8b) b = new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  return b;
}
self.onmessage = async function (ev) {
  var m = ev.data;
  try {
    if (m.type === 'volume') {
      var bytes = m.bytes || await getBytes(m.url);
      var vb = new Level2.VolumeBuilder();
      vb.feed(bytes);
      post(m.id, vb, null, false, { done: true });
    } else if (m.type === 'live') {
      var st = live[m.dir] || (live[m.dir] = { builder: new Level2.VolumeBuilder(), done: {} });
      var keys = Object.keys(live); if (keys.length > 3) delete live[keys[0]];
      for (var i = 0; i < m.urls.length; i++) {
        var u = m.urls[i];
        if (st.done[u]) continue;
        var b = await getBytes(u);
        st.done[u] = true;
        var touched = st.builder.feed(b);
        var nums = Object.keys(touched);
        if (nums.length) post(m.id, st.builder, nums, true, { done: false, chunk: u });
      }
      self.postMessage({ id: m.id, done: true, sweeps: [], meta: st.builder.export([], false).meta });
    }
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err && err.message || err), done: true });
  }
};
