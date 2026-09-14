/** Model bytes are inert base64, not interpolated script or markup. The only
 * executable source is our locally bundled viewer, inside the existing sandbox. */
export function modelPreviewDocument(bytes: ArrayBuffer, viewerScript: string): string {
  const data = new Uint8Array(bytes);
  let binary = "";
  for (let offset = 0; offset < data.length; offset += 8192) {
    binary += String.fromCharCode(...data.subarray(offset, offset + 8192));
  }
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>3D saved result</title>
<style>
*{box-sizing:border-box}html,body{height:100%;margin:0;overflow:hidden;background:#151b21;color:#e6ebe8;font:14px system-ui}
body{display:flex;flex-direction:column}header{padding:12px 16px;display:flex;align-items:center;flex-wrap:wrap;gap:12px;background:#1c242b}
header strong{margin-right:auto}button{font:inherit;color:inherit;background:#28363f;border:1px solid #52646d;border-radius:6px;padding:7px 12px;cursor:pointer}
button:focus-visible,canvas:focus-visible{outline:2px solid #ace0d0;outline-offset:-2px}
#viewport{position:relative;flex:1;min-height:0}canvas{display:block;width:100%;height:100%;touch-action:none}
#status{position:absolute;inset:0;display:grid;place-items:center;padding:24px;text-align:center;background:#151b21}#status[hidden]{display:none}
footer{padding:9px 16px;color:#acb8c0;font-size:12px;line-height:1.6}
</style><body>
<header><strong id="name">3D saved result</strong><button id="reset" disabled>Reset view</button></header>
<main id="viewport"><canvas aria-label="3D model: drag to rotate, scroll to zoom" tabindex="0"></canvas><div id="status" role="status">Opening 3D model…</div></main>
<footer>Drag to rotate · Scroll or pinch to zoom · Right-drag or arrow keys to pan · R to reset · Escape to close</footer>
<script id="model-bytes" type="application/octet-stream">${btoa(binary)}</script>
<script>${viewerScript.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
}
