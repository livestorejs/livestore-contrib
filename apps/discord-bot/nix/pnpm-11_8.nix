{
  fetchurl,
  lib,
  makeWrapper,
  nodejs_24,
  stdenvNoCC,
}:

stdenvNoCC.mkDerivation {
  pname = "pnpm";
  version = "11.8.0";

  src = fetchurl {
    url = "https://registry.npmjs.org/pnpm/-/pnpm-11.8.0.tgz";
    hash = "sha256-HpY6XEylFoVQugP8TujYc6dysHK3/OY7SP/yfXIOLpg=";
  };

  sourceRoot = "package";
  nativeBuildInputs = [ makeWrapper ];
  dontBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/libexec/pnpm" "$out/bin"
    cp -R . "$out/libexec/pnpm"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/pnpm" \
      --add-flags "$out/libexec/pnpm/bin/pnpm.cjs"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/pnpx" \
      --add-flags "$out/libexec/pnpm/bin/pnpx.cjs"

    runHook postInstall
  '';

  passthru.nodejs-slim = nodejs_24;

  meta = {
    description = "Fast, disk space efficient package manager";
    homepage = "https://pnpm.io";
    license = lib.licenses.mit;
    mainProgram = "pnpm";
  };
}
