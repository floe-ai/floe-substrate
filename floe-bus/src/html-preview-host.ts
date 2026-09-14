/** A static, authority-free document. Content arrives only from its embedding
 * client after that client has read an exact ArtefactVersion under authority. */
export const HTML_PREVIEW_HOST_PATH = "/v1/previews/html";
export const HTML_PREVIEW_CSP = [
  "default-src 'none'", "sandbox allow-scripts",
  "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
  "img-src data: blob:", "media-src data: blob:", "font-src data:",
  "connect-src blob: data:", "frame-src 'none'", "worker-src 'none'",
  "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join("; ");

// document.write preserves this response's CSP and the iframe sandbox. There
// is no Bus client, bearer, filesystem bridge or general message API here.
export const HTML_PREVIEW_HOST_DOCUMENT = `<!doctype html>
<meta charset="utf-8"><title>Saved result preview</title>
<script>
'use strict';
window.addEventListener('message', function receive(event) {
  if (event.source !== parent || event.data?.type !== 'floe.preview.html' || event.data?.version !== 1 || event.ports.length !== 1) return;
  window.removeEventListener('message', receive);
  const port = event.ports[0];
  port.onmessage = function(message) {
    port.onmessage = null;
    if (typeof message.data?.html !== 'string') { port.close(); return; }
    document.open();
    // Registered before result code. Escape can leave even a canvas-only game.
    // The channel's sole reverse message closes this preview; it grants no API.
    window.addEventListener('keydown', function(event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      port.postMessage({type: 'floe.preview.close'});
      port.close();
    }, true);
    document.write(message.data.html);
    document.close();
  };
  port.start();
});
</script>`;
