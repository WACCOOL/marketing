import { useEffect } from "react";
import { prewarmShot } from "./appshot.js";

// Re-ping a bit more often than the worker's 10-min scaledown window so an open
// editor stays warm without gaps, but rarely enough to be cheap.
const HEARTBEAT_MS = 5 * 60 * 1000;

/**
 * Keep the render worker warm while a 3D editor page is open.
 *
 * Fires a pre-warm on mount (boots the Modal GPU container so the first
 * Test/Final render skips the cold boot), then re-warms on a heartbeat. We only
 * ping while the tab is visible — a backgrounded tab isn't rendering, so there's
 * no reason to pay to keep the GPU warm; we re-warm immediately on refocus.
 * Stops on unmount, letting the worker scale to zero on its own.
 *
 * @param active gate the heartbeat (e.g. only once a scene is loaded). Defaults true.
 */
export function usePrewarmWorker(active = true): void {
  useEffect(() => {
    if (!active) return;

    const ping = () => {
      if (document.visibilityState === "visible") void prewarmShot();
    };

    ping();
    const timer = window.setInterval(ping, HEARTBEAT_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") ping();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active]);
}
