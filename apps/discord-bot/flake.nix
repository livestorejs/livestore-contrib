{
  description = "Immutable LiveStore Discord bot executable";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          pnpm_11_8_0 = pkgs.callPackage ./nix/pnpm-11_8.nix { };
          livestore-discord = pkgs.callPackage ./nix/package.nix { inherit pnpm_11_8_0; };
        in
        {
          default = livestore-discord;
          inherit livestore-discord pnpm_11_8_0;
        }
      );

      checks = forAllSystems (system: {
        inherit (self.packages.${system}) livestore-discord;
      });
    };
}
