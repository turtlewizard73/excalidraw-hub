#!/usr/bin/env bash
# Probe: does the canvas (headless renderer) draw an SVG-mimetype image element? Usage: probe/svg-image.sh [canvas-url]
set -euo pipefail
C="${1:-http://localhost:3001}"; out="${2:-/tmp/svg-probe.png}"
svg='<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#4a90d9"/><text x="20" y="60" font-size="30" fill="white">SVG OK</text></svg>'
url="data:image/svg+xml;base64,$(printf '%s' "$svg" | base64 -w0)"
curl -sf -X DELETE "$C/api/elements/clear" >/dev/null
curl -sf -X POST "$C/api/files" -H 'content-type: application/json' -d "{\"files\":[{\"id\":\"probe-svg\",\"dataURL\":\"$url\",\"mimeType\":\"image/svg+xml\"}]}" >/dev/null
curl -sf -X POST "$C/api/elements" -H 'content-type: application/json' -d '{"id":"cb1","type":"image","x":0,"y":0,"width":200,"height":100,"fileId":"probe-svg","status":"saved","customData":{"kind":"codeblock","lang":"mermaid","source":"graph TD; A-->B","view":"diagram"}}' >/dev/null
curl -sf "$C/api/elements/cb1" | grep -o '"customData":{[^}]*}'
curl -sf -X POST "$C/api/export/image" -H 'content-type: application/json' -d '{"format":"png"}' \
 | uv run --no-project python -c 'import sys,json,base64;j=json.load(sys.stdin);print("renderer:",j.get("renderer"));open(sys.argv[1],"wb").write(base64.b64decode(j["data"]))' "$out"
echo "wrote $out"
