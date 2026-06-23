import { useEffect, useState } from "react";
import { ChevronDown, Plus, Share, SquarePlus, X } from "lucide-react";

// A slim, top-of-screen hint that nudges mobile users to install the PWA to
// their home screen. It only appears when ALL of these hold:
//   - we're on a phone/tablet (iOS or Android),
//   - the app is NOT already running installed (standalone display mode),
//   - the user hasn't dismissed it before (persisted in localStorage).
// The install flow differs per platform, so the copy + icons adapt: Android
// fires `beforeinstallprompt` and we can drive the native installer directly;
// iOS Safari has no such event, so the banner opens a full-screen, step-by-step
// guide (the Share → "Add to Home Screen" flow) aimed at non-technical users.

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

const PLATFORM = detectPlatform();

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
  const [dismissed, setDismissed] = useState(wasDismissed);
  const [standalone, setStandalone] = useState(isStandalone);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

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

  // Lock background scrolling while the full-screen iOS guide is open.
  useEffect(() => {
    if (!guideOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [guideOpen]);

  if (!PLATFORM || standalone || dismissed) return null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Best-effort; if storage is unavailable the banner just returns next load.
    }
    setGuideOpen(false);
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
    <>
      <section className="installBanner" aria-label="Install app">
        <img className="installBanner__icon" src="./icon.svg" alt="" aria-hidden />
        <p className="installBanner__text">
          {PLATFORM === "android" && deferredPrompt ? (
            <>Install {appName} for a full-screen, app-like experience.</>
          ) : PLATFORM === "ios" ? (
            <>
              Add {appName} to your Home Screen for one-tap access.
            </>
          ) : (
            <>
              Install {appName}: open the browser menu, then <strong>Add to Home screen</strong>.
            </>
          )}
        </p>
        {PLATFORM === "android" && deferredPrompt && (
          <button className="installBanner__action" onClick={install} type="button">
            <Plus size={15} />
            Install
          </button>
        )}
        {PLATFORM === "ios" && (
          <button
            className="installBanner__action"
            onClick={() => setGuideOpen(true)}
            type="button"
          >
            Show me how
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
      </section>

      {guideOpen && PLATFORM === "ios" && (
        <div
          className="installGuide"
          role="dialog"
          aria-modal="true"
          aria-label={`Install ${appName}`}
        >
          <div className="installGuide__card">
            <button
              className="installGuide__close"
              onClick={() => setGuideOpen(false)}
              aria-label="Close"
              type="button"
            >
              <X size={20} />
            </button>

            <img className="installGuide__icon" src="./icon.svg" alt="" aria-hidden />
            <h2 className="installGuide__title">Install {appName}</h2>
            <p className="installGuide__lead">
              Add it to your Home Screen so it opens full-screen, just like a normal app. It only
              takes a few seconds.
            </p>

            <ol className="installGuide__steps">
              <li className="installGuide__step">
                <span className="installGuide__num">1</span>
                <span className="installGuide__stepText">
                  Tap the <strong>Share</strong> button
                  <span className="installGuide__stepHint">
                    It looks like this, at the bottom of the screen.
                  </span>
                </span>
                <span className="installGuide__stepIcon" aria-hidden>
                  <Share size={22} />
                </span>
              </li>
              <li className="installGuide__step">
                <span className="installGuide__num">2</span>
                <span className="installGuide__stepText">
                  Scroll down and tap <strong>Add to Home Screen</strong>
                </span>
                <span className="installGuide__stepIcon" aria-hidden>
                  <SquarePlus size={22} />
                </span>
              </li>
              <li className="installGuide__step">
                <span className="installGuide__num">3</span>
                <span className="installGuide__stepText">
                  Tap <strong>Add</strong> in the top-right corner — done!
                </span>
              </li>
            </ol>

            <button
              className="installGuide__done"
              onClick={() => setGuideOpen(false)}
              type="button"
            >
              Got it
            </button>
          </div>

          {/* Points non-technical users at Safari's Share button in the bottom bar. */}
          <div className="installGuide__pointer" aria-hidden>
            <span className="installGuide__pointerLabel">Share button is down here</span>
            <ChevronDown size={28} className="installGuide__pointerArrow" />
          </div>
        </div>
      )}
    </>
  );
}
