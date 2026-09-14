import { htmlPreviewHostUrl } from "../bus-client/transport.ts";

/** Constrain iframe navigation, including navigation initiated by preview code.
 * Install before mounting the app. This adds to (never relaxes) the host CSP. */
export function installHtmlPreviewFramePolicy(): void {
  const policy = document.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = `frame-src ${new URL(htmlPreviewHostUrl(), window.location.href).href}`;
  document.head.appendChild(policy);
}
