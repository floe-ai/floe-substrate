# HTML saved-result preview boundary

Observed need (F26): Floe produced a self-contained game and attached its exact
ArtefactVersion. Opening it displayed `No inline preview for application/octet-stream`.
The correction is client representation and content transport, with no new substrate
object, lifecycle or domain schema. It does not implement the Extension surface gate I7.

The existing authorised exact-version content reader verifies content identity and
digest. HTML retains its MIME identity, but its content endpoint uses attachment
disposition, no-sniff and a script-disabled sandbox CSP to prevent execution in the
authenticated origin. Merely inspecting an attachment never runs its HTML.

The client offers Run and Stop. Run loads `/v1/previews/html`, a static public document
containing no content, session or authority. The parent sends verified bytes once over
a MessageChannel. Only scripts and local presentation execute in the opaque iframe;
no same-origin, top-navigation, popup, download, form or native capability is granted.
The bootstrap accepts its parent only, then accepts HTML once. The channel's sole
reverse message closes the preview, allowing Escape from inside a game; it grants
no Floe API. Both ports close when the preview ends.
The response CSP survives document replacement. The parent CSP restricts iframe
navigation to that exact host path and is installed before the app mounts. Tauri keeps
its existing parent script/connection policy and grants no remote IPC capability.

F27 adds a locally bundled GLB viewer using this same boundary. Verified model
bytes are inert base64; the only executable source is the shipped viewer. The
viewer loads lazily and requires Open 3D view. It refuses external resources and
unsupported or malformed models, renders self-contained glTF 2 binary geometry
and embedded textures, and supports rotation, zoom, pan and reset. No remote
decoder, CDN or model-supplied script is loaded. The host now permits blob/data
connections for embedded resources; HTTP connections remain blocked. This is a
client format interpretation, not an executable Extension surface or new primitive.

This is an isolation boundary for Floe authority, **not an offline execution sandbox**.
The browser regression demonstrated that WebRTC sends STUN packets even with
`connect-src 'none'`; the draft `webrtc 'block'` directive did not enforce it in the
tested Edge. Do not describe this preview as network-free. The Run control discloses
possible internet access. No unsupported directive, JavaScript API monkey-patch, or
source-code filter is treated as a security boundary.

Run `npm run test:model-preview` from `floe-app` for real-browser rendering,
embedded texture, rotate/reset, Escape, inert model markup, malformed file and
external resource refusal checks. Additional GLB paths can be supplied to inspect
real saved files in the static fixture; these checks do not establish operator
success through the installed app. The viewer uses the official
[GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html) and
[OrbitControls](https://threejs.org/docs/pages/OrbitControls.html).

Relevant standards: [CSP frame-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-src),
[iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe),
and [CSP WebRTC directive](https://www.w3.org/TR/CSP/#directive-webrtc).

Reproduce the browser security checks from `floe-app` with `npm run test:html-preview`.
The script serves only a static fixture, never a Floe substrate or user credentials.
It uses installed Edge on Windows; `FLOE_TEST_BROWSER_EXECUTABLE` can select another
browser executable. It proves script and button operation, blocked parent DOM,
cookies and storage, absent native bridge, and blocked HTTP requests, forms, nested
frames, popups and same/cross-origin navigation. A local UDP listener records the
WebRTC limit. Component tests prove explicit Run, one full-content transfer and Stop.
The preview opens in a modal with keyboard focus and a visible Stop control, so
the conversation's scroll area cannot crop the work. These checks complement the
actual saved-game playtest; they do not replace it or
prove Safari, Firefox, mobile or the native desktop window.
