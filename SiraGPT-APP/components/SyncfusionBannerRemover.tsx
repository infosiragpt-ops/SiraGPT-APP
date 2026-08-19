"use client";

import { useEffect } from "react";

export function SyncfusionBannerRemover() {
  useEffect(() => {
    // Intercept and override Syncfusion dialog/modal creation functions
    if (typeof window !== 'undefined') {
      // Override alert/confirm to block Syncfusion license prompts
      const originalAlert = window.alert;
      const originalConfirm = window.confirm;
      
      window.alert = function(message?: any) {
        const msg = String(message || '').toLowerCase();
        if (msg.includes('syncfusion') || msg.includes('trial') || msg.includes('license')) {
          return; // Block the alert
        }
        return originalAlert.apply(window, arguments as any);
      };
      
      window.confirm = function(message?: any) {
        const msg = String(message || '').toLowerCase();
        if (msg.includes('syncfusion') || msg.includes('trial') || msg.includes('license')) {
          return true; // Auto-confirm to dismiss
        }
        return originalConfirm.apply(window, arguments as any);
      };
    }

    // Only an UNAMBIGUOUS Syncfusion trial/license nag should ever be
    // removed. The previous gate matched generic words ("trial",
    // "license", "account"+"sign in"), which also matched the app's own
    // modals and the document-viewer dialog (any `[role="dialog"]`),
    // ripping them out of the DOM. Require a Syncfusion-specific signal.
    const isSyncfusionNag = (text: string) =>
      text.includes("syncfusion") ||
      text.includes("claim your free") ||
      (text.includes("trial version") && text.includes("license"));

    // Never touch dialogs/modals the app itself owns. The document
    // viewer marks its shell with this testid; Radix-based modals are
    // protected by the strict text gate above, but this is defense in
    // depth for anything that nests the viewer.
    const APP_OWNED = '[data-testid="unified-document-viewer-dialog"]';
    const isAppOwned = (el: Element) => {
      try {
        return !!(el.closest?.(APP_OWNED) || el.matches?.(APP_OWNED) || el.querySelector?.(APP_OWNED));
      } catch {
        return false;
      }
    };

    // Aggressively remove Syncfusion trial content (banners, modals,
    // dialogs, overlays) — scoped to Syncfusion's own element shapes so
    // we never collide with the app's dialogs.
    const removeBanner = () => {
      const selectors = [
        'div[style*="z-index: 999999999"]',
        '.e-dlg-container',
        '.e-dialog',
        '.e-dlg-overlay',
        '.e-popup-overlay',
        'div[class*="license"]',
        'div[id*="license"]',
        'div[class*="e-dlg"]',
      ];

      selectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        elements.forEach((element) => {
          if (isAppOwned(element)) return;
          const text = element.textContent?.toLowerCase() || '';
          if (isSyncfusionNag(text)) {
            element.remove();
          }
        });
      });

      // Also remove any Syncfusion backdrop/overlay elements.
      document.querySelectorAll('.e-dlg-overlay, .e-popup-overlay').forEach(el => {
        if (!isAppOwned(el)) el.remove();
      });
    };

    // Remove on mount
    removeBanner();

    // Watch for dynamically added banners with MutationObserver
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1) {
            const element = node as HTMLElement;
            if (isAppOwned(element)) return;
            const style = element.getAttribute("style");
            const className = element.getAttribute("class") || '';
            const text = element.textContent?.toLowerCase() || '';

            // Remove only if it's a Syncfusion-shaped element AND its text
            // is an unambiguous Syncfusion nag. Generic role="dialog" is no
            // longer a trigger — it collided with the app's own dialogs.
            const looksSyncfusion =
              (style?.includes("z-index: 999999999")) ||
              className.includes('e-dlg') ||
              className.includes('e-dialog') ||
              className.includes('e-popup');
            if (looksSyncfusion && isSyncfusionNag(text)) {
              element.remove();
            }
          }
        });
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // More aggressive periodic cleanup (every 200ms instead of 500ms)
    const interval = setInterval(removeBanner, 200);

    // Also run on various events that might trigger modals
    const events = ['click', 'focus', 'mousedown', 'keydown'];
    const eventHandler = () => setTimeout(removeBanner, 50);
    events.forEach(event => document.addEventListener(event, eventHandler, true));

    return () => {
      observer.disconnect();
      clearInterval(interval);
      events.forEach(event => document.removeEventListener(event, eventHandler, true));
    };
  }, []);

  return null;
}
