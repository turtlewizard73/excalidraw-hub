"""Build chartroom v1: canvas hub elements + xd-* elements with label/binding shorthand expanded."""
import json, random, sys, urllib.request, time
V0, OUT = sys.argv[1], sys.argv[2]
v0 = json.load(open(V0))
canvas = json.load(urllib.request.urlopen('http://127.0.0.1:3000/api/elements'))
canvas = canvas.get('elements', canvas)
STD = set().union(*(x.keys() for x in v0['elements'])) | {'name'}
v0ids = {x['id']: x for x in v0['elements']}
# hub part: report drift vs v0, keep canvas state
hub = [x for x in canvas if not x['id'].startswith('xd-')]
drift = [x['id'] for x in hub if x['id'] not in v0ids or any(x.get(k) != v0ids[x['id']].get(k) for k in v0ids[x['id']] if k not in ('updated','version','versionNonce','index','seed'))]
print('hub elements', len(hub), 'differ from v0:', drift[:20], file=sys.stderr)
hub_clean = [{k: v for k, v in x.items() if k in STD} for x in hub]
now = int(time.time() * 1000)
rnd = random.Random(42)
def base(x, **over):
    e = dict(id=x['id'], type=x['type'], x=x['x'], y=x['y'], width=x.get('width', 0), height=x.get('height', 0), angle=0,
             strokeColor=x.get('strokeColor', '#1e1e1e'), backgroundColor=x.get('backgroundColor', 'transparent'),
             fillStyle='solid', strokeWidth=x.get('strokeWidth', 2), strokeStyle=x.get('strokeStyle', 'solid'),
             roughness=1, opacity=100, groupIds=[], frameId=None, roundness=None, seed=rnd.randint(1, 2**31 - 1),
             version=1, versionNonce=rnd.randint(1, 2**31 - 1), isDeleted=False, boundElements=[], updated=now,
             link=None, locked=False)
    e.update(over); return e
def text_el(id_, txt, fs, color, cx, cy, container=None, align='center', valign='middle', left=None, top=None):
    lines = txt.split('\n'); w = max(len(l) for l in lines) * fs * 0.48; h = len(lines) * fs * 1.25
    x = left if left is not None else cx - w / 2; y = top if top is not None else cy - h / 2
    return base({'id': id_, 'type': 'text', 'x': x, 'y': y, 'width': w, 'height': h, 'strokeColor': color},
                text=txt, originalText=txt, fontSize=fs, fontFamily=5, textAlign=align, verticalAlign=valign,
                containerId=container, autoResize=True, lineHeight=1.25)
xd = [x for x in canvas if x['id'].startswith('xd-')]
byid = {x['id']: x for x in xd}
out, bound = [], {x['id']: [] for x in xd}
for x in xd:
    if x['type'] == 'arrow':
        s, t = x['start']['id'], x['end']['id']
        bound[s].append({'type': 'arrow', 'id': x['id']}); bound[t].append({'type': 'arrow', 'id': x['id']})
for x in xd:
    lab = (x.get('label') or {}).get('text') or (x.get('text') if x['type'] != 'text' else None)
    if x['type'] == 'text':
        out.append(text_el(x['id'], x['text'], x.get('fontSize', 20), x.get('strokeColor', '#1e1e1e'), 0, 0,
                           align='left', valign='top', left=x['x'], top=x['y']))
        continue
    if x['type'] == 'frame':
        out.append(base(x, name=None)); continue
    if x['type'] == 'arrow':
        pts = x['points']; xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
        e = base(x, width=max(xs) - min(xs), height=max(ys) - min(ys), points=pts, lastCommittedPoint=None,
                 startBinding={'elementId': x['start']['id'], 'focus': 0, 'gap': 8},
                 endBinding={'elementId': x['end']['id'], 'focus': 0, 'gap': 8},
                 startArrowhead=None, endArrowhead='arrow', elbowed=False)
        if len(pts) > 2: e['roundness'] = None
        mid = pts[len(pts) // 2] if len(pts) > 2 else [(pts[0][0] + pts[-1][0]) / 2, (pts[0][1] + pts[-1][1]) / 2]
        if len(pts) == 4: mid = [(pts[1][0] + pts[2][0]) / 2, (pts[1][1] + pts[2][1]) / 2]
        cx, cy = x['x'] + mid[0], x['y'] + mid[1]
    else:
        e = base(x); cx, cy = x['x'] + x['width'] / 2, x['y'] + x['height'] / 2
    e['boundElements'] = list(bound.get(x['id'], []))
    out.append(e)
    if lab:
        lid = x['id'] + '-label'
        e['boundElements'].insert(0, {'type': 'text', 'id': lid})
        color = '#555555' if x['type'] == 'arrow' else (x.get('strokeColor') if x.get('backgroundColor') in ('#08427b', '#1168bd', '#438dd5', '#8a8a8a') else '#1e1e1e')
        out.append(text_el(lid, lab, x.get('fontSize', 20), color, cx, cy, container=x['id']))
# indices after all hub ones
D = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
for i, e in enumerate(out):
    n = i + 62
    e['index'] = 'b' + D[n // 62] + D[n % 62]
doc = {'type': 'excalidraw', 'version': 2, 'source': 'excalidraw-hub', 'elements': hub_clean + out, 'appState': v0['appState']}
ids = [e['id'] for e in doc['elements']]
assert len(ids) == len(set(ids)), 'duplicate ids'
for e in doc['elements']:
    for b in e.get('boundElements') or []: assert b['id'] in ids, (e['id'], b)
    if e.get('containerId'): assert e['containerId'] in ids
json.dump(doc, open(OUT, 'x'), indent=2)
print('wrote', OUT, len(doc['elements']), 'elements', file=sys.stderr)
