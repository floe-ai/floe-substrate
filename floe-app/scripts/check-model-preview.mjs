// A static browser fixture, never a Floe service or an operator Workspace.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { bundleModelViewer } from './model-preview-plugin.ts';
import { modelPreviewDocument } from '../src/previews/model-document.ts';
import { HTML_PREVIEW_CSP, HTML_PREVIEW_HOST_DOCUMENT, HTML_PREVIEW_HOST_PATH } from '../../floe-bus/src/html-preview-host.ts';

const script = await bundleModelViewer();
const requests = [];
const server = createServer((req, res) => {
  requests.push(req.url);
  if (req.url === HTML_PREVIEW_HOST_PATH) {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': HTML_PREVIEW_CSP });
    res.end(HTML_PREVIEW_HOST_DOCUMENT);
  } else if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><meta http-equiv="Content-Security-Policy" content="script-src 'self'; frame-src http://127.0.0.1:${server.address().port}${HTML_PREVIEW_HOST_PATH}"><title>3D preview regression</title><script src="/parent.js"></script>`);
  } else if (req.url === '/parent.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(`window.show = html => {
      document.querySelector('iframe')?.remove();
      const frame = document.createElement('iframe');
      frame.sandbox = 'allow-scripts'; frame.src = '${HTML_PREVIEW_HOST_PATH}';
      frame.style = 'width:900px;height:600px;border:0';
      frame.onload = () => {
        frame.onload = null;
        const channel = new MessageChannel();
        channel.port1.onmessage = event => {
          if(event.data?.type === 'floe.preview.close') { frame.remove(); channel.port1.close(); }
        };
        channel.port1.start();
        frame.contentWindow.postMessage({type:'floe.preview.html',version:1},'*',[channel.port2]);
        channel.port1.postMessage({html});
      };
      document.body.append(frame);
    };`);
  } else { res.writeHead(404); res.end('Unexpected request'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

function fixture(external = false) {
  const positions = Buffer.from(new Float32Array([-1,0,0, 1,0,0, 0,1.5,0]).buffer);
  const uv = Buffer.from(new Float32Array([0,0, 1,0, 0.5,1]).buffer);
  const bin = Buffer.concat([positions, uv]);
  const json = Buffer.from(JSON.stringify({ asset:{version:'2.0'}, scene:0,
    scenes:[{nodes:[0], name:'Fixture </script><script>parent.leaked=true</script>'}],
    nodes:[{mesh:0}], meshes:[{primitives:[{attributes:{POSITION:0,TEXCOORD_0:1},material:0}]}],
    buffers:[{byteLength:bin.length}], bufferViews:[{buffer:0,byteOffset:0,byteLength:positions.length},{buffer:0,byteOffset:positions.length,byteLength:uv.length}],
    accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[-1,0,0],max:[1,1.5,0]},{bufferView:1,componentType:5126,count:3,type:'VEC2'}],
    images:[{uri:external ? `http://127.0.0.1:${server.address().port}/external-texture` : 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4AWK6H2nyH4SZGKAAAAAA//88CwMZAAAABklEQVQDAEFWBNuIlshsAAAAAElFTkSuQmCC'}],
    textures:[{source:0}], materials:[{pbrMetallicRoughness:{baseColorTexture:{index:0},metallicFactor:0},doubleSided:true}],
  }));
  const padded = Buffer.concat([json, Buffer.alloc((4-json.length%4)%4, 32)]);
  const header = Buffer.alloc(20); header.write('glTF'); header.writeUInt32LE(2,4);
  header.writeUInt32LE(20+padded.length+8+bin.length,8); header.writeUInt32LE(padded.length,12); header.write('JSON',16);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(bin.length); binHeader.writeUInt32LE(0x004e4942,4);
  const result = Buffer.concat([header,padded,binHeader,bin]);
  return result.buffer.slice(result.byteOffset,result.byteOffset+result.byteLength);
}

let browser;
try {
  browser = await chromium.launch({headless:true, ...(process.env.FLOE_TEST_BROWSER_EXECUTABLE
    ? {executablePath:process.env.FLOE_TEST_BROWSER_EXECUTABLE} : process.platform === 'win32' ? {channel:'msedge'} : {})});
  const page = await browser.newPage({viewport:{width:1100,height:760}});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const show = async bytes => page.evaluate(html => window.show(html), modelPreviewDocument(bytes,script));
  await show(fixture());
  const frame = () => page.frames().find(f => f.parentFrame());
  const inner = page.frameLocator('iframe');
  await inner.getByRole('button',{name:'Reset view'}).waitFor();
  await inner.locator('#status').waitFor({state:'hidden',timeout:20000});
  assert.equal(await page.evaluate(() => window.leaked), undefined);
  const boundary = await frame().evaluate(() => {
    let parentAccess = false; try { parentAccess = !!parent.document; } catch {}
    return {parentAccess,nativeBridge:typeof window.__TAURI_INTERNALS__};
  });
  assert.deepEqual(boundary,{parentAccess:false,nativeBridge:'undefined'});
  const canvas = inner.locator('canvas');
  const before = await canvas.screenshot();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  await page.mouse.down(); await page.mouse.move(box.x+box.width*0.7,box.y+box.height*0.6,{steps:12}); await page.mouse.up();
  const rotated = await canvas.screenshot();
  assert.equal(before.equals(rotated),false,'drag must change the rendered view');
  await inner.getByRole('button',{name:'Reset view'}).click();
  // Keep keyboard focus styling identical to the initial programmatic focus.
  await page.keyboard.press('Tab');
  await canvas.focus();
  assert.equal(before.equals(await canvas.screenshot()),true,'reset must restore the view');
  await canvas.focus(); await page.keyboard.press('Escape');
  await page.locator('iframe').waitFor({state:'detached'});
  await show(fixture(true));
  await inner.getByRole('alert').waitFor();
  assert.equal(requests.includes('/external-texture'),false);
  await show(new ArrayBuffer(3));
  await inner.getByRole('alert').waitFor();
  const actualFiles = [];
  for (const path of process.argv.slice(2)) {
    const bytes = readFileSync(path);
    await show(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
    await inner.locator('#status').waitFor({state:'hidden',timeout:20000});
    actualFiles.push({path,opened:true,heading:await inner.locator('#name').textContent()});
  }
  console.log(JSON.stringify({browser:browser.version(),rendered:true,embeddedTexture:true,rotate:true,reset:true,escape:true,
    modelMarkupInert:true,boundary,externalResourceRefused:true,malformedRefused:true,actualFiles,requests},null,2));
} finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
