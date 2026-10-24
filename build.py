#!/usr/bin/env python3
# Bundles src/ + data/ into one self-contained HTML file (dist/spcwarn.html).
import json, os
root = os.path.dirname(os.path.abspath(__file__))
src = lambda f: open(os.path.join(root, 'src', f), encoding='utf8').read()
data = lambda f: open(os.path.join(root, 'data', f), encoding='utf8').read()
radars = json.loads(data('radars.json'))
radars_js = 'var RADARS = ' + json.dumps(radars, separators=(',', ':')) + ';\n'
app = radars_js + '\n'.join(src(f) for f in ['bzip2.js', 'level2.js', 'level3.js', 'colors.js', 'render.js', 'data.js', 'velocity.js', 'warn.js', 'extras.js', 'app.js'])
worker = src('bzip2.js') + '\n' + src('level2.js') + '\n' + src('worker.js')
html = src('index.html')
def put(h, k, v):
    assert k in h, k
    return h.replace(k, v.replace('</script', '<\\/script'), 1)
html = put(html, '/*MAPLIBRE_CSS*/', data('maplibre-gl.css'))
html = put(html, '/*GEO*/', data('geo.json'))
html = put(html, '/*COUNTIES*/', data('cpoly.json'))
html = put(html, '/*CWA*/', data('cwa.json'))
html = put(html, '/*LABELS*/', data('labels.json'))
html = put(html, '/*PLACES*/', data('cities.json'))
html = put(html, '/*WORKER*/', worker)
html = put(html, '/*MAPLIBRE*/', data('maplibre-gl.js'))
html = put(html, '/*APP*/', app)
os.makedirs(os.path.join(root, 'dist'), exist_ok=True)
out = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">\n' + html + '\n</html>\n'
open(os.path.join(root, 'dist', 'spcwarn.html'), 'w', encoding='utf8').write(out)
# Root copy is the GitHub Pages entry page.
open(os.path.join(root, 'index.html'), 'w', encoding='utf8').write(out)
print('wrote dist/spcwarn.html', len(out) // 1024, 'KB')
