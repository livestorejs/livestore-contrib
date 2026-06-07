{
  pkgs,
  lib,
  inputs,
  ...
}:
let
  effectUtils =
    if builtins.pathExists ./repos/effect-utils/flake.nix then
      builtins.getFlake (toString ./repos/effect-utils)
    else
      inputs.effect-utils;
  effectUtilsPackages = effectUtils.packages.${pkgs.system};
  taskModules = effectUtils.devenvModules.tasks;

  rootPackageJson = builtins.fromJSON (builtins.readFile ./package.json);
  pnpmPackages = rootPackageJson.workspaces or [ ];

  oxlintNpm = effectUtils.lib.mkOxlintNpm {
    inherit pkgs;
    bun = pkgs.bun;
    src = inputs.effect-utils;
  };
  oxlintWithPlugins = effectUtils.lib.mkOxlintWithPlugins {
    inherit pkgs oxlintNpm;
  };
in
{
  imports = [
    effectUtils.devenvModules.dt
    taskModules.genie
    (taskModules.megarepo {
      syncAll = false;
      bootstrapMembers = [
        "effect-utils"
        "livestore"
      ];
    })
    (taskModules.pnpm {
      packages = pnpmPackages;
      installAfter = [ "mr:bootstrap" ];
    })
    (taskModules.ts { tsconfigFile = "tsconfig.dev.json"; })
    (taskModules.clean { packages = pnpmPackages; })
    (taskModules.lint-oxc {
      lintPaths = [
        "packages"
        ".github"
        "genie"
        "release"
        ".oxfmtrc.json"
        ".oxlintrc.json"
        "package.json.genie.ts"
        "pnpm-workspace.yaml.genie.ts"
        "tsconfig.dev.json.genie.ts"
      ];
      execIfModifiedPatterns = [
        "*.ts"
        "*.json"
        "*.yaml"
        "genie/**/*.ts"
        ".github/**/*.ts"
        ".github/**/*.yml"
        ".github/**/*.yaml"
      ];
      geniePatterns = [ "**/*.genie.ts" ];
      genieCoverageDirs = [ "." ];
      genieCoverageExcludes = [
        "examples/"
        "repos/"
        "node_modules/"
      ];
      denyWarnings = false;
    })
    (taskModules.check {
      hasTests = false;
      hasNixCheck = false;
      extraChecks = [
        "lint:check:lockfile"
        "workspace:shape-check"
        "release:surface:check"
      ];
    })
    (taskModules.setup {
      requiredTasks = [ ];
      optionalTasks = [
        "genie:run"
        "mr:check"
      ];
    })
  ];

  packages = [
    (effectUtils.lib.mkPnpm { inherit pkgs; })
    pkgs.bun
    pkgs.nodejs_24
    pkgs.typescript
    oxlintWithPlugins
    pkgs.oxfmt
    effectUtilsPackages.genie
    effectUtilsPackages.megarepo
    effectUtilsPackages.effect-tsgo
    pkgs.jq
  ];

  tasks."lint:check".after = lib.mkForce [
    "lint:check:format"
    "lint:check:oxlint"
    "lint:check:genie"
    "lint:check:genie:coverage"
    "lint:check:lockfile"
  ];
  # The current mr CLI accepts one --only value per invocation. Keep the
  # bootstrap contract local until the shared effect-utils task module handles
  # multi-member bootstrap with the current CLI parser.
  tasks."mr:bootstrap".exec = lib.mkForce ''
    set -euo pipefail
    if [ ! -f ./megarepo.kdl ] && [ ! -f ./megarepo.json ]; then
      exit 0
    fi

    mr apply --only effect-utils
    mr apply --only livestore

    # pnpm omits lockfile importers for workspace members under symlinked
    # directories. Dereference the pinned core repo after megarepo apply so the
    # contrib install root can own the materialized core package closure.
    if [ -L repos/livestore ]; then
      livestore_target="$(readlink -f repos/livestore)"
      tmp_dir="$(mktemp -d repos/.livestore-real.XXXXXX)"
      cp -a --reflink=auto "$livestore_target"/. "$tmp_dir"/ 2>/dev/null || cp -a "$livestore_target"/. "$tmp_dir"/
      rm repos/livestore
      mv "$tmp_dir" repos/livestore
    fi
  '';
  tasks."mr:bootstrap".status = lib.mkForce ''
    set -euo pipefail
    if [ ! -f ./megarepo.kdl ] && [ ! -f ./megarepo.json ]; then
      exit 0
    fi

    test -d repos/effect-utils
    test -d repos/livestore
    test ! -L repos/livestore
  '';
  tasks."ts:build".after = lib.mkForce [ "genie:run" ];
  tasks."ts:build-watch".after = lib.mkForce [ "genie:run" ];
  tasks."ts:check".after = lib.mkForce [ "genie:run" ];
  tasks."ts:check:strict".after = lib.mkForce [ "genie:run" ];
  tasks."ts:emit".after = lib.mkForce [ "genie:run" ];
  tasks."release:surface:check" = {
    description = "Validate the contrib release workflow surface";
    after = [
      "genie:run"
      "mr:check"
    ];
    exec = ''
      set -euo pipefail

      core_version="$(jq -r '.version' repos/livestore/release/version.json)"
      : "$core_version"
      if [ "$core_version" = "null" ] || [ -z "$core_version" ]; then
        echo "Missing core version in repos/livestore/release/version.json" >&2
        exit 1
      fi

      if [ -f release/release-plan.json ]; then
        echo "Contrib release plans are intentionally disabled until release planning is added." >&2
        exit 1
      fi

      node release/simulate-publish.mjs

      echo "Core version authority available: $core_version"
      echo "Package publish simulation passed."
      echo "Package publish is intentionally blocked until release planning is added."
    '';
  };
  tasks."workspace:shape-check" = {
    description = "Validate the contrib workspace shape";
    after = [
      "genie:run"
      "mr:check"
    ];
    exec = ''
      set -euo pipefail
      test ! -e .envrc
      node <<'NODE'
      const fs = require('node:fs')

      const generatedFiles = [
        'package.json',
        'pnpm-workspace.yaml',
        'tsconfig.dev.json',
        '.oxlintrc.json',
        '.oxfmtrc.json',
      ]

      const forbidden = [
        'devtools-web-common',
        '@livestore/devtools-web-common',
        'effect-playwright',
        '@livestore/effect-playwright',
      ]
      for (const file of generatedFiles) {
        const text = fs.readFileSync(file, 'utf8')
        for (const token of forbidden) {
          if (text.includes(token)) {
            throw new Error(file + ' contains ' + token)
          }
        }
      }

      const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'))
      const packageWorkspaces = packageJson.workspaces ?? []
      if (!Array.isArray(packageWorkspaces)) {
        throw new Error('package.json workspaces must be an array')
      }

      const workspaceYaml = fs.readFileSync('pnpm-workspace.yaml', 'utf8')
      const yamlPackages = workspaceYaml
        .split('\n')
        .map((line) => line.match(/^  - (.+)$/)?.[1])
        .filter(Boolean)

      const sort = (values) => [...values].sort()
      if (JSON.stringify(sort(packageWorkspaces)) !== JSON.stringify(sort(yamlPackages))) {
        throw new Error('package.json and pnpm-workspace.yaml workspace members differ')
      }

      const coreMembers = packageWorkspaces.filter((path) =>
        path.startsWith('repos/livestore/packages/@livestore/'),
      )
      const contribMembers = packageWorkspaces.filter(
        (path) => path.startsWith('packages/@livestore/') || path.startsWith('examples/'),
      )

      if (coreMembers.length === 0) {
        throw new Error('expected materialized core workspace members under repos/livestore')
      }
      if (contribMembers.length === 0) {
        throw new Error('expected declared contrib package/example members')
      }

      for (const path of coreMembers) {
        if (!fs.existsSync(path)) {
          throw new Error('materialized core workspace member is missing: ' + path)
        }
      }

      const livestoreStat = fs.lstatSync('repos/livestore')
      if (livestoreStat.isSymbolicLink()) {
        throw new Error('repos/livestore must be dereferenced before pnpm owns the install graph')
      }

      const packageManifests = fs
        .readdirSync('packages/@livestore')
        .map((name) => `packages/@livestore/''${name}/package.json`)
      const coreMemberSet = new Set(coreMembers)
      const expectedCoreMembers = new Set()
      for (const manifestPath of packageManifests) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        for (const path of manifest.$genie?.workspaceClosureDirs ?? []) {
          if (path.startsWith('repos/livestore/packages/@livestore/')) {
            expectedCoreMembers.add(path)
          }
        }
      }

      const corePackageNames = new Set(packageJson.$genie.coreOwnedPackageNames.map((name) => `@livestore/''${name}`))
      const dependencySections = ['dependencies', 'devDependencies', 'peerDependencies']
      for (const memberPath of contribMembers.filter((path) => path.startsWith('examples/'))) {
        const manifest = JSON.parse(fs.readFileSync(`''${memberPath}/package.json`, 'utf8'))
        for (const section of dependencySections) {
          for (const name of Object.keys(manifest[section] ?? {})) {
            if (corePackageNames.has(name)) {
              expectedCoreMembers.add(`repos/livestore/packages/@livestore/''${name.slice('@livestore/'.length)}`)
            }
          }
        }
      }

      const expectedCoreMemberSet = new Set(expectedCoreMembers)
      for (const path of expectedCoreMemberSet) {
        if (!coreMemberSet.has(path)) {
          throw new Error('expected core workspace member is missing from root workspace: ' + path)
        }
      }
      for (const path of coreMemberSet) {
        if (!expectedCoreMemberSet.has(path)) {
          throw new Error('unexpected core workspace member in root workspace: ' + path)
        }
      }
      NODE
    '';
  };

  enterShell = ''
    export MONOREPO_ROOT="$PWD/repos"
  '';
}
