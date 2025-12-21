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

    // Aggressively remove ALL Syncfusion trial content (banners, modals, dialogs, overlays)
    const removeBanner = () => {
      const selectors = [
        'div[style*="z-index: 999999999"]',
        '.e-dlg-container',
        '.e-dialog',
        '.e-dlg-overlay',
        '.e-popup-overlay',
        '[role="dialog"]',
        '[role="alertdialog"]',
        'div[class*="license"]',
        'div[id*="license"]',
        'div[class*="e-dlg"]',
        'div[style*="position: fixed"][style*="z-index"]',
      ];

      selectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        elements.forEach((element) => {
          const text = element.textContent?.toLowerCase() || '';
          if (
            text.includes("syncfusion") ||
            text.includes("trial") ||
            text.includes("license") ||
            text.includes("claim your free") ||
            text.includes("account") && text.includes("sign in")
          ) {
            element.remove();
          }
        });
      });

      // Also remove any backdrop/overlay elements
      document.querySelectorAll('.e-dlg-overlay, .e-popup-overlay').forEach(el => el.remove());
    };

    // Remove on mount
    removeBanner();

    // Watch for dynamically added banners with MutationObserver
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1) {
            const element = node as HTMLElement;
            const style = element.getAttribute("style");
            const className = element.getAttribute("class") || '';
            const text = element.textContent?.toLowerCase() || '';
            
            // Remove if it's a Syncfusion trial dialog/modal/banner
            if (
              (style?.includes("z-index: 999999999")) ||
              className.includes('e-dlg') ||
              className.includes('e-dialog') ||
              className.includes('e-popup') ||
              element.getAttribute('role') === 'dialog' ||
              element.getAttribute('role') === 'alertdialog'
            ) {
              if (
                text.includes("syncfusion") ||
                text.includes("trial") ||
                text.includes("license") ||
                text.includes("claim your free")
              ) {
                element.remove();
              }
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
