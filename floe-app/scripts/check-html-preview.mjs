// Browser security regression, independent of any Floe home or credentials.
// Run: node --import tsx scripts/check-html-preview.mjs (installed Edge on Windows).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { chromium } from 'playwright-core';
import { HTML_PREVIEW_CSP, HTML_PREVIEW_HOST_DOCUMENT, HTML_PREVIEW_HOST_PATH } from '../../floe-bus/src/html-preview-host.ts';

const requests = [];
const udp = createSocket('udp4');
let udpRequests = 0;
udp.on('message', () => udpRequests++);
await new Promise(resolve => udp.bind(0, '127.0.0.1', resolve));
const server = createServer((req, res) => {
  requests.push(req.url);
  if (req.url === HTML_PREVIEW_HOST_PATH) {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': HTML_PREVIEW_CSP });
    res.end(HTML_PREVIEW_HOST_DOCUMENT);
  } else if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><meta http-equiv="Content-Security-Policy" content="script-src 'self'; frame-src http://127.0.0.1:${server.address().port}${HTML_PREVIEW_HOST_PATH}">
      <title>HTML preview isolation regression</title><script src="/fixture-parent.js"></script>`);
  } else if (req.url === '/fixture-parent.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(`
      window.reports = [];
      addEventListener('message', event => { if(event.data?.proof) reports.push(event.data.proof); });
      window.show = html => {
        document.querySelector('iframe')?.remove();
        const frame = document.createElement('iframe');
        frame.sandbox = 'allow-scripts'; frame.referrerPolicy = 'no-referrer';
        frame.src = '${HTML_PREVIEW_HOST_PATH}';
        frame.onload = () => {
          frame.onload = null;
          const channel = new MessageChannel();
          channel.port1.onmessage = event => {
            if(event.data?.type === 'floe.preview.close') { frame.remove(); channel.port1.close(); reports.push({closed:true}); }
          };
          channel.port1.start();
          frame.contentWindow.postMessage({ type:'floe.preview.html', version:1 }, '*', [channel.port2]);
          channel.port1.postMessage({html});
        };
        document.body.append(frame);
      };
      `);
  } else {
    res.writeHead(404); res.end('Unexpected preview request');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.FLOE_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.FLOE_TEST_BROWSER_EXECUTABLE }
      : process.platform === 'win32' ? { channel: 'msedge' } : {}),
  });
  const page = await browser.newPage();
  await page.goto(origin);
  await page.evaluate(() => { localStorage.setItem('parent-secret', 'never-in-preview'); document.cookie = 'preview-test=private'; });
  const showScript = async script => {
    await page.evaluate(html => { window.reports = []; window.show(html); }, `<!doctype html><body><button id="click">Play</button><script>${script}</script>`);
    await page.waitForFunction(() => window.reports.length > 0);
    return page.evaluate(() => window.reports);
  };
  const isolation = await showScript(`
    const result = {script:true};
    for (const [name, read] of Object.entries({
      parentDOM:()=>parent.document.body.innerText,
      cookies:()=>document.cookie,
      storage:()=>localStorage.getItem('parent-secret'),
    })) { try { read(); result[name] = 'escaped'; } catch { result[name] = 'blocked'; } }
    result.nativeBridge = typeof window.__TAURI_INTERNALS__;
    document.getElementById('click').onclick = () => parent.postMessage({proof:{clicked:true}}, '*');
    parent.postMessage({proof:result}, '*');
  `);
  assert.deepEqual(isolation[0], { script:true, parentDOM:'blocked', cookies:'blocked', storage:'blocked', nativeBridge:'undefined' });
  await page.frameLocator('iframe').getByRole('button', {name:'Play'}).click();
  await page.waitForFunction(() => window.reports.some(r => r.clicked));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.reports.some(r => r.closed));
  assert.equal(await page.locator('iframe').count(), 0);
  const rtc = await showScript(`
    (async () => {
      try {
        const peer = new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${udp.address().port}'}]});
        peer.createDataChannel('proof'); await peer.setLocalDescription(await peer.createOffer());
        setTimeout(() => {peer.close(); parent.postMessage({proof:{rtc:'gathered'}}, '*');}, 1000);
      } catch (error) { parent.postMessage({proof:{rtc:'blocked', reason:String(error)}}, '*'); }
    })();
  `);
  // Browsers permit WebRTC from opaque frames even when connect-src is none.
  // This is a Floe-authority boundary, NOT an offline execution environment.
  // The product requires Run and discloses internet access before execution.

  const escape = await showScript(`
    const result = {};
    try { top.location = '${origin}/escape-top'; result.top = 'escaped'; } catch { result.top = 'blocked'; }
    result.popup = window.open('${origin}/escape-popup') === null ? 'blocked' : 'escaped';
    try { new Worker('data:text/javascript,postMessage(1)'); result.worker = 'escaped'; } catch { result.worker = 'blocked'; }
    fetch('${origin}/escape-fetch').then(()=>parent.postMessage({proof:{fetch:'escaped'}},'*'),()=>parent.postMessage({proof:{fetch:'blocked'}},'*'));
    const image = new Image(); image.src = '${origin}/escape-image'; document.body.append(image);
    const script = document.createElement('script'); script.src = '${origin}/escape-script'; document.body.append(script);
    const form = document.createElement('form'); form.action='${origin}/escape-form'; document.body.append(form); form.submit();
    const nested = document.createElement('iframe'); nested.src='${origin}/escape-frame'; document.body.append(nested);
    parent.postMessage({proof:result}, '*');
  `);
  assert.equal(escape.find(r => 'top' in r).top, 'blocked');
  assert.equal(escape.find(r => 'popup' in r).popup, 'blocked');
  await page.waitForFunction(() => window.reports.some(r => r.fetch));
  assert.equal(await page.evaluate(() => window.reports.find(r => r.fetch).fetch), 'blocked');
  await showScript(`parent.postMessage({proof:{navigationAttempt:true}}, '*'); location.href = '${origin}/escape-self';`);
  await showScript(`parent.postMessage({proof:{navigationAttempt:true}}, '*'); location.href = '${origin.replace('127.0.0.1', 'localhost')}/escape-cross-origin';`);
  // Browser task completion plus a new parent interaction gives requests time
  // to surface without relying on a snapshot of CSP strings alone.
  await page.getByTitle('HTML preview isolation regression').count();
  await page.waitForTimeout(300);
  assert.equal(page.url(), origin + '/');
  assert.deepEqual(requests.filter(path => path.startsWith('/escape-')), []);
  assert.equal(browser.contexts()[0].pages().length, 1);
  console.log(JSON.stringify({browser:await browser.version(), isolation:isolation[0], interaction:'passed',
    fetch:'blocked', image:'blocked', form:'blocked', nestedFrame:'blocked', topNavigation:'blocked',
    popup:'blocked', selfNavigation:'blocked', webRTC:rtc, udpRequests,
    offlineIsolation:false, unexpectedHttpRequests:[]}, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  udp.close();
}
