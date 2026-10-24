// MapLibre custom WebGL layer that draws one radar sweep. The fragment shader converts every map
// pixel to azimuth/range from the radar and samples the polar data texture directly.
function RadarLayer(id) {
  this.id = id; this.type = 'custom'; this.renderingMode = '2d';
  this.frame = null; this.textures = new Map();
}
RadarLayer.prototype.onAdd = function (map, gl) {
  this.map = map; this.gl = gl;
  var vs = 'attribute vec2 aPos; uniform mat4 uMatrix; varying vec2 vMerc;' +
    'void main(){ vMerc = aPos; gl_Position = uMatrix * vec4(aPos, 0.0, 1.0); }';
  var fs = [
    'precision highp float;',
    'varying vec2 vMerc;',
    'uniform sampler2D uData; uniform sampler2D uLut;',
    'uniform vec2 uRadar; uniform float uNGates; uniform float uFirst; uniform float uSpacing; uniform float uRows; uniform float uRes; uniform float uCosEl; uniform float uOpacity;',
    'const float PI = 3.141592653589793;',
    'void main(){',
    '  float lon = vMerc.x * 2.0 * PI - PI;',
    '  float lat = 2.0 * atan(exp(PI - 2.0 * PI * vMerc.y)) - PI / 2.0;',
    '  float dlon = lon - uRadar.y; float dlat = lat - uRadar.x;',
    '  float a = sin(dlat*0.5)*sin(dlat*0.5) + cos(lat)*cos(uRadar.x)*sin(dlon*0.5)*sin(dlon*0.5);',
    '  float dist = 2.0 * 6371000.0 * asin(min(1.0, sqrt(a)));',
    '  float y = sin(dlon) * cos(lat);',
    '  float x = cos(uRadar.x) * sin(lat) - sin(uRadar.x) * cos(lat) * cos(dlon);',
    '  float az = degrees(atan(y, x)); if (az < 0.0) az += 360.0;',
    '  float r = dist / uCosEl;',
    '  float gate = floor((r - uFirst) / uSpacing + 0.5);',
    '  if (gate < 0.0 || gate >= uNGates) discard;',
    '  float row = mod(floor(az / uRes), uRows);',
    '  float code = texture2D(uData, vec2((gate + 0.5) / uNGates, (row + 0.5) / uRows)).r * 255.0;',
    '  vec4 c = texture2D(uLut, vec2((floor(code + 0.5) + 0.5) / 256.0, 0.5));',
    '  if (c.a < 0.01) discard;',
    '  gl_FragColor = vec4(c.rgb * uOpacity, uOpacity);',
    '}'].join('\n');
  function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
  var p = this.prog = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
  this.loc = {};
  var self = this;
  ['uMatrix', 'uData', 'uLut', 'uRadar', 'uNGates', 'uFirst', 'uSpacing', 'uRows', 'uRes', 'uCosEl', 'uOpacity'].forEach(function (n) { self.loc[n] = gl.getUniformLocation(p, n); });
  this.aPos = gl.getAttribLocation(p, 'aPos');
  this.buf = gl.createBuffer();
  this.lutTex = gl.createTexture();
};
RadarLayer.prototype.setFrame = function (frame) { // frame: {sweep, product, radar:{lat,lon}}
  this.frame = frame;
  if (this.map) this.map.triggerRepaint();
};
RadarLayer.prototype.dataTexture = function (m) {
  var gl = this.gl, t = this.textures.get(m);
  if (t && t.version === m.version) return t.tex;
  if (!t) {
    t = { tex: gl.createTexture(), version: -1 };
    this.textures.set(m, t);
    if (this.textures.size > 160) { // simple LRU eviction
      var k = this.textures.keys().next().value; gl.deleteTexture(this.textures.get(k).tex); this.textures.delete(k);
    }
  }
  gl.bindTexture(gl.TEXTURE_2D, t.tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, m.ngates, m.data.length / m.ngates, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, m.data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  t.version = m.version;
  return t.tex;
};
RadarLayer.prototype.dropTextures = function () {
  var gl = this.gl; if (!gl) return;
  this.textures.forEach(function (t) { gl.deleteTexture(t.tex); }); this.textures.clear();
};
RadarLayer.prototype.render = function (gl, matrix) {
  var f = this.frame; if (!f || !f.sweep) return;
  var m = f.moment || f.sweep.moments[f.product]; if (!m) return;
  var maxR = m.first + m.ngates * m.spacing + 2000;
  var lat0 = f.radar.lat, lon0 = f.radar.lon;
  var dLat = maxR / 111320, dLon = maxR / (111320 * Math.cos(lat0 * Math.PI / 180));
  function merc(lon, lat) {
    var x = (lon + 180) / 360, s = Math.sin(lat * Math.PI / 180);
    return [x, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
  }
  var a = merc(lon0 - dLon, Math.min(85, lat0 + dLat)), b = merc(lon0 + dLon, Math.max(-85, lat0 - dLat));
  var verts = new Float32Array([a[0], a[1], b[0], a[1], a[0], b[1], b[0], b[1]]);
  if (gl.bindVertexArray) gl.bindVertexArray(null);
  gl.useProgram(this.prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(this.aPos);
  gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, this.dataTexture(m));
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, Colors.lut(f.product, m.scale, m.offset));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  var L = this.loc;
  gl.uniformMatrix4fv(L.uMatrix, false, matrix);
  gl.uniform1i(L.uData, 0); gl.uniform1i(L.uLut, 1);
  gl.uniform2f(L.uRadar, lat0 * Math.PI / 180, lon0 * Math.PI / 180);
  gl.uniform1f(L.uNGates, m.ngates); gl.uniform1f(L.uFirst, m.first); gl.uniform1f(L.uSpacing, m.spacing);
  gl.uniform1f(L.uRows, f.sweep.rows); gl.uniform1f(L.uRes, f.sweep.res);
  gl.uniform1f(L.uCosEl, Math.cos(f.sweep.elev * Math.PI / 180));
  gl.uniform1f(L.uOpacity, 1.0);
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.SCISSOR_TEST);
  gl.colorMask(true, true, true, true);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.activeTexture(gl.TEXTURE0);
};
