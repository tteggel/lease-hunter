{
  description = "Lease Hunter dev shell: Node 22 + Playwright using Nix-provided browsers";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.nodejs_22 ];

          # Use the browsers nixpkgs builds (patched for NixOS) instead of Playwright's downloads.
          PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
          PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
          # The npm `playwright` package should match this version so it finds the browser revision above.
          PLAYWRIGHT_NIX_VERSION = pkgs.playwright-driver.version;

          shellHook = ''
            want="$PLAYWRIGHT_NIX_VERSION"
            have="$(node -p "require('./package.json').dependencies.playwright" 2>/dev/null)"
            if [ "$have" != "$want" ]; then
              echo "lease-hunter: nixpkgs ships Playwright $want but package.json pins $have."
              echo "  Align them with:  npm pkg set dependencies.playwright=$want && npm install"
              echo "  (Until then lib/pw.mjs launches the Nix Chromium directly, which usually works.)"
            fi
            [ -d node_modules ] || echo "lease-hunter: run 'npm install' first."
          '';
        };
      });
    };
}
