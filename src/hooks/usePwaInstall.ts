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

export function usePwaInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState<boolean>(() => detectStandalone());
  const [showIosHint, setShowIosHint] = useState(false);

  const isLocalFile =
    typeof window !== 'undefined' &&
    (window.location.protocol === 'file:' || window.location.protocol === 'content:');
  const isIosSafari = detectIosSafari();

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const onAppInstalled = () => {
      setDeferredPrompt(null);
      setIsStandalone(true);
      setShowIosHint(false);
    };

    const media = window.matchMedia?.('(display-mode: standalone)');
    const onDisplayChange = () => setIsStandalone(detectStandalone());

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    media?.addEventListener?.('change', onDisplayChange);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
      media?.removeEventListener?.('change', onDisplayChange);
    };
  }, []);

  const canInstall =
    !isStandalone && !isLocalFile && (deferredPrompt !== null || isIosSafari);

  const triggerInstall = useCallback(async () => {
    if (deferredPrompt) {
      try {
        await deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice;
        if (choice.outcome === 'accepted') {
          setDeferredPrompt(null);
        }
      } catch {
        // Ignore prompt dismissal errors
      }
      return;
    }
    if (isIosSafari) {
      setShowIosHint((prev) => !prev);
    }
  }, [deferredPrompt, isIosSafari]);

  return {
    canInstall,
    isIosSafari,
    showIosHint,
    triggerInstall,
  };
}
