import { useCallback, useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return (
    Boolean(nav.standalone) ||
    window.matchMedia?.('(display-mode: standalone)').matches === true
  );
}

function detectIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isIos =
    /iPad|iPhone|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!isIos) return false;
  return /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS/i.test(ua);
}

let sharedDeferredPrompt: BeforeInstallPromptEvent | null = null;
let sharedIsStandalone = detectStandalone();
let listenersInitialized = false;
const subscribers = new Set<() => void>();

function notifySubscribers() {
  for (const fn of subscribers) {
    fn();
  }
}

function ensureGlobalListeners() {
  if (listenersInitialized || typeof window === 'undefined') return;
  listenersInitialized = true;

  window.addEventListener('beforeinstallprompt', (e: Event) => {
    e.preventDefault();
    sharedDeferredPrompt = e as BeforeInstallPromptEvent;
    notifySubscribers();
  });

  window.addEventListener('appinstalled', () => {
    sharedDeferredPrompt = null;
    sharedIsStandalone = true;
    notifySubscribers();
  });

  const media = window.matchMedia?.('(display-mode: standalone)');
  media?.addEventListener?.('change', () => {
    sharedIsStandalone = detectStandalone();
    notifySubscribers();
  });
}

export function usePwaInstall() {
  ensureGlobalListeners();

  const [, setTick] = useState(0);
  const [installHint, setInstallHint] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => setTick((t) => t + 1);
    subscribers.add(sync);
    return () => {
      subscribers.delete(sync);
    };
  }, []);

  const isLocalFile =
    typeof window !== 'undefined' &&
    (window.location.protocol === 'file:' || window.location.protocol === 'content:');
  const isIosSafari = detectIosSafari();
  const isStandalone = sharedIsStandalone;
  const hasNativePrompt = sharedDeferredPrompt !== null;
  const canInstall = !isStandalone && !isLocalFile && (hasNativePrompt || isIosSafari);

  const dismissHint = useCallback(() => {
    setInstallHint(null);
  }, []);

  const triggerInstall = useCallback(async () => {
    if (sharedDeferredPrompt) {
      const promptEvent = sharedDeferredPrompt;
      try {
        await promptEvent.prompt();
        const choice = await promptEvent.userChoice;
        if (choice.outcome === 'accepted') {
          sharedDeferredPrompt = null;
          setInstallHint(null);
          notifySubscribers();
        }
      } catch {
        // Ignore prompt dismissal errors
      }
      return;
    }

    if (isIosSafari) {
      setInstallHint((prev) =>
        prev ? null : 'In Safari, tap Share → Add to Home Screen to install for offline play.'
      );
      return;
    }

    setInstallHint((prev) =>
      prev
        ? null
        : 'Open the GitHub Pages site in Chrome, Edge, or Safari to install as an app, or use Settings → Save Offline HTML.'
    );
  }, [isIosSafari]);

  return {
    canInstall,
    hasNativePrompt,
    isStandalone,
    isLocalFile,
    isIosSafari,
    installHint,
    triggerInstall,
    dismissHint,
  };
}
