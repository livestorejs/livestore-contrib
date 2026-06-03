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
    (taskModules.pnpm { packages = pnpmPackages; })
    (taskModules.ts { tsconfigFile = "tsconfig.dev.json"; })
    (taskModules.clean { packages = pnpmPackages; })
    (taskModules.lint-oxc {
      lintPaths = [ "." ];
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
        "repos/"
        "node_modules/"
      ];
      denyWarnings = false;
    })
    (taskModules.check {
      hasTests = false;
      hasNixCheck = false;
      extraChecks = [ "workspace:preimport-check" ];
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

  # Pre-package-import phase: contrib-owned package directories are declared in
  # the generated root workspace before their histories are imported. Until that
  # import lands, checks must not force a pnpm install over the incomplete graph.
  tasks."lint:check".after = lib.mkForce [
    "lint:check:format"
    "lint:check:oxlint"
    "lint:check:genie"
    "lint:check:genie:coverage"
  ];
  tasks."ts:build".after = lib.mkForce [ "genie:run" ];
  tasks."ts:build-watch".after = lib.mkForce [ "genie:run" ];
  tasks."ts:check".after = lib.mkForce [ "genie:run" ];
  tasks."ts:check:strict".after = lib.mkForce [ "genie:run" ];
  tasks."ts:emit".after = lib.mkForce [ "genie:run" ];
  tasks."workspace:preimport-check" = {
    description = "Validate the pre-package-import contrib workspace shape";
    after = [
      "genie:run"
      "mr:check"
    ];
    exec = ''
      set -euo pipefail
      test ! -e .envrc
      test ! -e pnpm-lock.yaml
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

      for (const path of contribMembers) {
        if (path.startsWith('repos/')) {
          throw new Error('contrib workspace member must not be declared under repos/: ' + path)
        }
      }
      NODE
    '';
  };

  enterShell = ''
    export MONOREPO_ROOT="$PWD/repos"
  '';
}
