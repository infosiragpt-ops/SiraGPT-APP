{ pkgs }: {
  deps = [
    pkgs.pandoc
    # Node 22: @capacitor/cli@8 requires >=22 (Node 20 triggered EBADENGINE
    # warnings during deploy). Kept in sync with `modules = ["nodejs-22"]`.
    pkgs.nodejs_22
    pkgs.nodePackages.npm
    # Some test fixtures need basic utilities.
    pkgs.git
    pkgs.gh
    # The dev pipeline uses Playwright for E2E; the system bundles
    # need glibc + a few Chromium runtime libs. Replit's Nix profile
    # ships these via the playwright pkg.
    pkgs.playwright-driver
    # Document pipeline parsers (mammoth / xlsx / pdf-parse) are
    # pure JS, but image-side OCR (tesseract.js) and sharp need
    # system tooling.
    pkgs.tesseract
    pkgs.vips
  ];

  env = {
    # Next.js dev server binds to 0.0.0.0 inside Replit so the public
    # port forwarder (see [[ports]] in .replit) reaches it.
    HOST = "0.0.0.0";
    NEXT_TELEMETRY_DISABLED = "1";
  };
}
