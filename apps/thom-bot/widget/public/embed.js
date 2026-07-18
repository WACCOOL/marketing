/*
 * Thom embed loader — WAC Group public chat widget.
 *
 * Host sites add ONE line:
 *   <script src="https://thom.gowac.cc/embed.js" data-site-key="SITE_KEY" async></script>
 *
 * This injects a floating launcher button (bottom-right). Clicking it opens an
 * iframe to https://thom.gowac.cc/widget?site_key=SITE_KEY. The loader derives
 * its own origin from the <script src> so it works unchanged in dev + prod, and
 * listens for postMessage from the iframe (close + resize). Vanilla JS, no
 * framework, all styles scoped inline so nothing leaks into the host page.
 */
(function () {
  "use strict";

  // Guard against double-inclusion.
  if (window.__thomEmbedLoaded) return;
  window.__thomEmbedLoaded = true;

  var script = document.currentScript;
  if (!script) {
    // Fallback: last <script src*=embed.js> on the page.
    var all = document.querySelectorAll('script[src*="embed.js"]');
    script = all[all.length - 1];
  }
  if (!script) return;

  var siteKey = script.getAttribute("data-site-key") || "";
  var origin;
  try {
    origin = new URL(script.src).origin;
  } catch (e) {
    origin = "";
  }

  var PANEL_W = 380; // px
  var PANEL_H = 620; // px
  var open = false;
  var launcher, container, iframe;

  function px(n) {
    return n + "px";
  }

  function buildLauncher() {
    launcher = document.createElement("button");
    launcher.type = "button";
    launcher.setAttribute("aria-label", "Chat with Thom, the WAC Group assistant");
    launcher.setAttribute("aria-expanded", "false");
    launcher.textContent = "Ask Thom";
    var s = launcher.style;
    s.position = "fixed";
    s.zIndex = "2147483000";
    s.right = "20px";
    s.bottom = "20px";
    s.height = "52px";
    s.padding = "0 20px";
    s.borderRadius = "999px";
    s.border = "none";
    s.cursor = "pointer";
    s.background = "#3b6fd4";
    s.color = "#ffffff";
    s.fontSize = "15px";
    s.fontWeight = "600";
    s.fontFamily =
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
    s.boxShadow = "0 8px 24px rgba(20,24,40,0.28)";
    launcher.addEventListener("click", toggle);
    document.body.appendChild(launcher);
  }

  function buildContainer() {
    container = document.createElement("div");
    var s = container.style;
    s.position = "fixed";
    s.zIndex = "2147483001";
    s.right = "20px";
    s.bottom = "84px";
    s.width = px(PANEL_W);
    s.height = px(PANEL_H);
    s.maxWidth = "calc(100vw - 40px)";
    s.maxHeight = "calc(100vh - 104px)";
    s.borderRadius = "16px";
    s.overflow = "hidden";
    s.boxShadow = "0 18px 48px rgba(20,24,40,0.32)";
    s.background = "#ffffff";
    s.display = "none";

    iframe = document.createElement("iframe");
    iframe.title = "Thom, the WAC Group assistant";
    iframe.src = origin + "/widget?site_key=" + encodeURIComponent(siteKey);
    iframe.setAttribute("allow", "clipboard-write");
    var fs = iframe.style;
    fs.width = "100%";
    fs.height = "100%";
    fs.border = "0";
    fs.display = "block";
    container.appendChild(iframe);
    document.body.appendChild(container);
  }

  function toggle() {
    open = !open;
    container.style.display = open ? "block" : "none";
    launcher.setAttribute("aria-expanded", open ? "true" : "false");
    launcher.textContent = open ? "Close" : "Ask Thom";
  }

  function close() {
    if (!open) return;
    open = false;
    container.style.display = "none";
    launcher.setAttribute("aria-expanded", "false");
    launcher.textContent = "Ask Thom";
  }

  // Resize protocol: the iframe may request a panel height (clamped to viewport).
  function onMessage(ev) {
    if (!ev || !ev.data || ev.data.source !== "thom-widget") return;
    if (origin && ev.origin && ev.origin !== origin) return; // only trust our iframe
    var msg = ev.data;
    if (msg.type === "thom:close") close();
    else if (msg.type === "thom:resize" && typeof msg.height === "number") {
      var h = Math.max(320, Math.min(msg.height, window.innerHeight - 104));
      container.style.height = px(h);
    }
  }

  function init() {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", init);
      return;
    }
    buildContainer();
    buildLauncher();
    window.addEventListener("message", onMessage);
  }

  init();
})();
