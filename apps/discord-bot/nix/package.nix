{
  fetchPnpmDeps,
  lib,
  makeWrapper,
  nodejs_24,
  pnpmConfigHook,
  pnpm_11_8_0,
  stdenvNoCC,
}:

let
  pname = "livestore-discord";
  version = "0.0.0";

  manifests = [
    "package.json"
    "pnpm-lock.yaml"
    "pnpm-workspace.yaml"
  ];
  dependencyInputs = manifests ++ [ "patches" ];
  sourceWith =
    entries:
    lib.cleanSourceWith {
      src = ../.;
      filter =
        path: _type:
        let
          relative = lib.removePrefix (toString ../.) (toString path);
          segments = builtins.filter (segment: segment != "") (lib.splitString "/" relative);
          first = if segments == [ ] then "" else builtins.head segments;
        in
        relative == "" || builtins.elem first entries;
    };

  # Dependency preparation changes only when its declared manifests change;
  # ordinary source edits reuse the fixed-output pnpm store.
  depsSrc = sourceWith dependencyInputs;
  src = sourceWith (
    dependencyInputs
    ++ [
      "cf"
      "e2e"
      "src"
      "tsconfig.json"
    ]
  );

  pnpmDeps = fetchPnpmDeps {
    inherit pname version;
    src = depsSrc;
    pnpm = pnpm_11_8_0;
    fetcherVersion = 4;
    hash = "sha256-qqUoF6R0PSvRj0zl/+W667lM3n9i/+5UEtxwUnYMIjg=";
  };
in
stdenvNoCC.mkDerivation {
  inherit
    pname
    pnpmDeps
    src
    version
    ;

  nativeBuildInputs = [
    makeWrapper
    nodejs_24
    pnpmConfigHook
    pnpm_11_8_0
  ];

  buildPhase = ''
    runHook preBuild
    pnpm --version | grep -Fx 11.8.0

    assert_version() {
      actual="$(node -p "require('./node_modules/$1/package.json').version")"
      if [ "$actual" != "$2" ]; then
        echo "Expected $1@$2, resolved $actual" >&2
        exit 1
      fi
    }
    assert_version dfx 1.0.15
    assert_version effect 4.0.0-beta.105
    assert_version @effect/platform-node 4.0.0-beta.105
    assert_version @effect/platform-node-shared 4.0.0-beta.105
    assert_version discord-api-types 0.38.40

    pnpm check
    pnpm prune --prod --ignore-scripts
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    app="$out/lib/livestore-discord"
    mkdir -p "$app" "$out/bin"
    cp package.json pnpm-lock.yaml pnpm-workspace.yaml "$app/"
    cp -R e2e src node_modules "$app/"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/livestore-discord" \
      --add-flags "--experimental-strip-types $app/src/main.ts"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/livestore-discord-e2e" \
      --add-flags "--experimental-strip-types $app/e2e/src/live-main.ts"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/livestore-discord-e2e-broker" \
      --add-flags "--experimental-strip-types $app/e2e/src/attended-broker-main.ts"

    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    bash ${./runtime-e2e.sh} "$out/bin/livestore-discord"
    set +e
    "$out/bin/livestore-discord-e2e" >e2e-usage.stdout 2>e2e-usage.stderr
    e2e_status=$?
    set -e
    test "$e2e_status" -eq 2
    grep -F 'Usage: pnpm e2e:live' e2e-usage.stderr >/dev/null
    set +e
    "$out/bin/livestore-discord-e2e-broker" bogus-op >broker.stdout 2>broker.stderr
    broker_status=$?
    set -e
    test "$broker_status" -eq 2
    grep -F 'Usage:' broker.stderr >/dev/null
  '';

  meta = {
    description = "LiveStore Discord bot";
    license = lib.licenses.mit;
    mainProgram = "livestore-discord";
    platforms = lib.platforms.unix;
  };
}
