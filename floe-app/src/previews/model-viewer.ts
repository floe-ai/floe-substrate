import {
  Box3, Color, DirectionalLight, HemisphereLight, LoadingManager,
  PerspectiveCamera, Scene, Sphere, Vector3, WebGLRenderer,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// This entry executes only inside the opaque saved-result preview. No app
// imports, authority, operation API, remote decoders or model-supplied scripts.
const status = document.querySelector<HTMLDivElement>("#status")!;
const canvas = document.querySelector<HTMLCanvasElement>("canvas")!;
const viewport = document.querySelector<HTMLElement>("#viewport")!;
const reset = document.querySelector<HTMLButtonElement>("#reset")!;

async function openModel() {
  const encoded = document.querySelector("#model-bytes")!;
  const bytes = Uint8Array.from(atob(encoded.textContent ?? ""), char => char.charCodeAt(0));
  encoded.remove();
  const header = new DataView(bytes.buffer);
  if (bytes.length < 20 || header.getUint32(0, true) !== 0x46546c67
    || header.getUint32(4, true) !== 2 || header.getUint32(8, true) !== bytes.length
    || header.getUint32(16, true) !== 0x4e4f534a || header.getUint32(12, true) > bytes.length - 20) {
    throw new Error("invalid GLB");
  }
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + header.getUint32(12, true))));
  // A saved version must be self-contained. Never silently open a partial
  // model after the loader has substituted a failed external texture.
  for (const resource of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (resource.uri !== undefined && (typeof resource.uri !== "string" || !resource.uri.startsWith("data:"))) {
      throw new Error("external resource");
    }
  }
  const manager = new LoadingManager();
  let resourceFailed = false;
  manager.onError = () => { resourceFailed = true; };
  manager.setURLModifier(url => {
    if (!url.startsWith("blob:") && !url.startsWith("data:")) throw new Error("external resource");
    return url;
  });
  const gltf = await new GLTFLoader(manager).parseAsync(bytes.buffer, "");
  if (resourceFailed) throw new Error("incomplete model");
  const bounds = new Box3().setFromObject(gltf.scene);
  const sphere = bounds.getBoundingSphere(new Sphere());
  if (bounds.isEmpty() || !Number.isFinite(sphere.radius) || sphere.radius <= 0) throw new Error("empty model");

  let renderer: WebGLRenderer;
  try { renderer = new WebGLRenderer({ canvas, antialias: true }); }
  catch {
    status.textContent = "3D viewing is unavailable in this browser. Enable hardware acceleration or try another browser.";
    status.setAttribute("role", "alert");
    return;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new Scene();
  scene.background = new Color(0x151b21);
  scene.add(gltf.scene);
  let hasLight = false;
  gltf.scene.traverse(object => { if ("isLight" in object) hasLight = true; });
  if (!hasLight) {
    scene.add(new HemisphereLight(0xe8f0ff, 0x70746c, 2.4));
    const light = new DirectionalLight(0xffeedc, 3);
    light.position.copy(sphere.center).add(new Vector3(1, 2, 3).multiplyScalar(sphere.radius));
    light.target.position.copy(sphere.center);
    scene.add(light, light.target);
  }
  const camera = new PerspectiveCamera(40, 1, sphere.radius / 1000, sphere.radius * 1000);
  const controls = new OrbitControls(camera, canvas);
  controls.minDistance = sphere.radius * 0.05;
  controls.maxDistance = sphere.radius * 50;
  controls.listenToKeyEvents(canvas);
  const render = () => renderer.render(scene, camera);
  const resetView = () => {
    const halfFov = Math.min(camera.fov * Math.PI / 360, Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect));
    const distance = sphere.radius / Math.sin(halfFov) * 1.15;
    controls.target.copy(sphere.center);
    camera.position.copy(sphere.center).add(new Vector3(1, 0.7, 1.25).normalize().multiplyScalar(distance));
    controls.update();
    render();
  };
  const resize = () => {
    const { width, height } = viewport.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
  };
  controls.addEventListener("change", render);
  const observer = new ResizeObserver(resize);
  observer.observe(viewport);
  reset.onclick = resetView;
  canvas.addEventListener("keydown", event => {
    if (event.key.toLowerCase() === "r") { event.preventDefault(); resetView(); }
  });
  canvas.addEventListener("webglcontextlost", event => {
    event.preventDefault();
    status.textContent = "The 3D view was interrupted. Close and reopen this preview to continue.";
    status.setAttribute("role", "alert");
    status.hidden = false;
  });
  window.addEventListener("pagehide", () => { observer.disconnect(); controls.dispose(); renderer.dispose(); }, { once: true });
  document.querySelector("#name")!.textContent = gltf.scene.name || "3D saved result";
  resize();
  resetView();
  reset.disabled = false;
  status.hidden = true;
  canvas.focus();
}

void openModel().catch(() => {
  status.textContent = "This 3D file could not be opened. It may use unsupported features or need files outside this saved version.";
  status.setAttribute("role", "alert");
});
