import { useEffect, useState } from "react";
import { Plus, Share, SquarePlus, X } from "lucide-react";

// A slim, top-of-screen hint that nudges mobile users to install the PWA to
// their home screen. It only appears when ALL of these hold:
//   - we're on a phone/tablet (iOS or Android),
//   - the app is NOT already running installed (standalone display mode),
//   - the user hasn't dismissed it before (persisted in localStorage).
// The install flow differs per platform, so the copy + icons adapt: Android
// fires `beforeinstallprompt` and we can drive the native installer directly;
// iOS Safari has no such event, so we show the Share → "Add to Home Screen"
// steps with the matching glyphs.

const DISMISS_KEY = "openclaw.voice.installBannerDismissed";

type MobilePlatform = "ios" | "android";

// The `beforeinstallprompt` event isn't in the standard DOM lib types.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function detectPlatform(): MobilePlatform | null {
  if (typeof navigator === "undefined") return null;
  const ua = navigator.userAgent;
  // iPadOS 13+ masquerades as desktop Safari, so also treat a touch-capable
  // "Macintosh" as iOS.
  const isIOS =
    /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  if (isIOS) return "ios";
  if (/android/i.test(ua)) return "android";
  return null;
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    // iOS Safari exposes this non-standard flag when launched from the home
    // screen.
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function InstallBanner({ appName }: { appName: string }) {
  const [platform] = useState(detectPlatform);
  const [dismissed, setDismissed] = useState(wasDismissed);
  const [standalone, setStandalone] = useState(isStandalone);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  // Capture Android/Chrome's install prompt so our own button can trigger it,
  // and hide the banner the moment the app gets installed.
  useEffect(() => {
    function onBeforeInstall(event: Event) {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    }
    function onInstalled() {
      setStandalone(true);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!platform || standalone || dismissed) return null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Best-effort; if storage is unavailable the banner just returns next load.
    }
    setDismissed(true);
  }

  async function install() {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    // Whatever the user chose, the prompt can't be reused — drop it. If they
    // accepted, `appinstalled` will hide the banner; if not, the steps remain.
    setDeferredPrompt(null);
  }

  return (
    <div className="installBanner" role="region" aria-label="Install app">
      <img className="installBanner__icon" src="./icon.svg" alt="" aria-hidden />
      <p className="installBanner__text">
        {platform === "android" && deferredPrompt ? (
          <>Install {appName} for a full-screen, app-like experience.</>
        ) : platform === "ios" ? (
          <>
            Install {appName}: tap{" "}
            <Share size={15} className="installBanner__glyph" aria-label="Share" /> then{" "}
            <strong>Add to Home Screen</strong>{" "}
            <SquarePlus size={15} className="installBanner__glyph" aria-hidden />
          </>
        ) : (
          <>
            Install {appName}: open the browser menu, then <strong>Add to Home screen</strong>.
          </>
        )}
      </p>
      {platform === "android" && deferredPrompt && (
        <button className="installBanner__action" onClick={install} type="button">
          <Plus size={15} />
          Install
        </button>
      )}
      <button
        className="installBanner__close"
        onClick={dismiss}
        aria-label="Dismiss install hint"
        type="button"
      >
        <X size={16} />
      </button>
    </div>
  );
}
