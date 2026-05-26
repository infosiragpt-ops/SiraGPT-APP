{ pkgs }: {
  deps = [
    pkgs.pandoc
    pkgs.nodejs_20
    pkgs.nodePackages.npm
    pkgs.git
    pkgs.gh
    pkgs.playwright-driver
    pkgs.tesseract
    pkgs.vips
  ];

  env = {
    HOST = "0.0.0.0";
    NEXT_TELEMETRY_DISABLED = "1";
  };
}
