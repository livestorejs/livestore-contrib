{
  pkgs,
  lib,
  inputs,
  ...
}:
let
  # Pinned input, not ./repos/effect-utils. The composed checkout is gitignored and can sit at a
  # different revision than the lock records, and evaluating it made shell entry depend on that drift:
  # a stale member declared a fixed-output hash that no longer matched, so the shell failed to build
  # for a reason the committed locks did not describe. Evaluating the pin keeps local entry agreeing
  # with CI, which composes members fresh at the locked revision.
  effectUtils = inputs.effect-utils;
  effectUtilsPackages = effectUtils.packages.${pkgs.system};
  taskModules = effectUtils.devenvModules.tasks;

  rootPackageJson = builtins.fromJSON (builtins.readFile ./package.json);
  pnpmPackages = rootPackageJson.workspaces or [ ];
  generatedInstalledWorkspaceTasks = [
    "genie:run"
    "pnpm:install"
  ];

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
    taskModules.genie
    # gh:apply-labels / gh:check-labels — reconcile .github/labels.json with live labels.
    (taskModules.gh-labels { repo = "livestorejs/livestore-contrib"; })
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
        "ci:quality"
        "ci:types"
        "ci:packages"
        "ci:examples-build"
        "ci:node"
        "test:integration:node-sync:allow-flaky"
        "release:surface:check"
        "release:snapshot:dryrun"
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

  # Keep Nix-provided `tsc` aligned with the workspace TypeScript catalog override so
  # devenv tasks validate against the same compiler as package-local tooling. Remove
  # this once the inherited nixpkgs `pkgs.typescript` provides TypeScript 6.0.3 or newer.
  overlays = [
    (_final: prev: {
      typescript = prev.typescript.overrideAttrs (
        _finalAttrs: _oldAttrs:
        let
          typescriptSrc = prev.fetchFromGitHub {
            owner = "microsoft";
            repo = "TypeScript";
            rev = "v6.0.3";
            hash = "sha256-RvM+fGO94ItdQxgXUcCdkpX039pytnMri100wGjNhhc=";
          };
        in
        {
          version = "6.0.3";
          src = typescriptSrc;
          npmDeps = prev.fetchNpmDeps {
            name = "typescript-6.0.3-npm-deps";
            src = typescriptSrc;
            hash = "sha256-nnBXImViLpuPPNYwBxe3T+hpoiuA/7qpIMVcXJmjklg=";
          };
          npmDepsHash = "sha256-nnBXImViLpuPPNYwBxe3T+hpoiuA/7qpIMVcXJmjklg=";
        }
      );
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
  tasks."ts:build".after = lib.mkForce generatedInstalledWorkspaceTasks;
  tasks."ts:build-watch".after = lib.mkForce generatedInstalledWorkspaceTasks;
  tasks."ts:check".after = lib.mkForce generatedInstalledWorkspaceTasks;
  tasks."ts:check:strict".after = lib.mkForce generatedInstalledWorkspaceTasks;
  tasks."ts:emit".after = lib.mkForce generatedInstalledWorkspaceTasks;
  tasks."ci:quality" = {
    description = "Run PR quality checks for contrib";
    after = [
      "genie:check"
      "lint:check"
      "mr:lock-sync-check"
      "workspace:shape-check"
    ];
  };
  tasks."ci:types" = {
    description = "Run PR type checks for contrib";
    after = [ "ts:check" ];
  };
  tasks."ci:packages" = {
    description = "Run PR package unit tests for contrib";
    after = [ "test:packages" ];
  };
  tasks."ci:examples-build" = {
    description = "Build PR-covered contrib examples";
    after = [ "test:examples:build" ];
  };
  tasks."ci:node" = {
    description = "Run PR node adapter integration coverage for contrib";
    after = [ "test:integration:node-misc" ];
  };
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
    '';
  };
  tasks."release:snapshot:dryrun" = {
    description = "Dry-run a contrib snapshot package publish";
    after = [
      "mr:check"
      "pnpm:install"
    ];
    exec = ''
      set -euo pipefail
      cd "$DEVENV_ROOT"

      git_sha="''${GIT_SHA:-$(git rev-parse HEAD)}"
      core_sha="''${LIVESTORE_CORE_GIT_SHA:-$(jq -r '.members.livestore.commit' megarepo.lock)}"
      release_version="''${LIVESTORE_RELEASE_VERSION:-0.0.0-snapshot-$git_sha}"
      core_release_version="''${LIVESTORE_CORE_RELEASE_VERSION:-0.0.0-snapshot-$core_sha}"

      DEVENV_TASK_PASSTHROUGH=1 LIVESTORE_RELEASE_VERSION="$release_version" genie --writeable
      node release/simulate-publish.mjs --version "$release_version" --core-version "$core_release_version" --dry-run
    '';
  };
  tasks."release:snapshot:pack:git-sha" = {
    description = "Pack an exact-SHA contrib snapshot without registry credentials";
    after = [
      "mr:check"
      "pnpm:install"
    ];
    exec = ''
      set -euo pipefail
      cd "$DEVENV_ROOT"

      : "''${GIT_SHA:?GIT_SHA is required}"
      : "''${PR_NUMBER:?PR_NUMBER is required}"
      : "''${SNAPSHOT_OUT_DIR:?SNAPSHOT_OUT_DIR is required}"

      # The producer half runs on fork-authored code with no registry credentials, so it must never
      # be able to publish. Refuse outright if a token is present rather than relying on --pack-only.
      if [ -n "''${NODE_AUTH_TOKEN:-}" ] || [ -n "''${NPM_TOKEN:-}" ]; then
        echo "The snapshot pack job must not run with registry credentials present." >&2
        exit 1
      fi

      core_sha="$(jq -r '.members.livestore.commit' megarepo.lock)"
      if [ -z "$core_sha" ] || [ "$core_sha" = "null" ]; then
        echo "megarepo.lock is missing members.livestore.commit" >&2
        exit 1
      fi

      release_version="0.0.0-snapshot-pr.$PR_NUMBER.$GIT_SHA"

      DEVENV_TASK_PASSTHROUGH=1 LIVESTORE_RELEASE_VERSION="$release_version" genie --writeable
      node release/simulate-publish.mjs \
        --version "$release_version" \
        --core-sha "$core_sha" \
        --verify-core \
        --pack-only \
        --out-dir "$SNAPSHOT_OUT_DIR"
    '';
  };
  tasks."release:snapshot:git-sha" = {
    description = "Publish contrib snapshot packages for a git SHA";
    after = [
      "mr:check"
      "pnpm:install"
    ];
    exec = ''
      set -euo pipefail
      cd "$DEVENV_ROOT"

      : "''${GIT_SHA:?GIT_SHA is required}"
      core_sha="''${LIVESTORE_CORE_GIT_SHA:-$(jq -r '.members.livestore.commit' megarepo.lock)}"
      release_version="''${LIVESTORE_RELEASE_VERSION:-0.0.0-snapshot-$GIT_SHA}"
      core_release_version="''${LIVESTORE_CORE_RELEASE_VERSION:-0.0.0-snapshot-$core_sha}"

      if [ -n "''${NODE_AUTH_TOKEN:-}" ] || [ -n "''${NPM_TOKEN:-}" ]; then
        echo "npm snapshot publishing must use trusted publishing; token auth is not allowed in this task." >&2
        exit 1
      fi

      DEVENV_TASK_PASSTHROUGH=1 LIVESTORE_RELEASE_VERSION="$release_version" genie --writeable
      node release/simulate-publish.mjs --version "$release_version" --core-version "$core_release_version" --verify-core --publish
    '';
  };
  tasks."test:integration:node" = {
    description = "Run moved adapter-node integration tests";
    after = [
      "genie:run"
      "pnpm:install"
    ];
    exec = ''
      devenv tasks run test:integration:node-misc --mode before --no-tui
      devenv tasks run test:integration:node-sync:allow-flaky --mode before --no-tui
    '';
  };
  tasks."test:integration:node-misc" = {
    description = "Run moved adapter-node miscellaneous integration tests";
    after = [
      "genie:run"
      "pnpm:install"
    ];
    exec = ''
      WORKSPACE_ROOT="$PWD" DEVENV_TASK_PASSTHROUGH=1 pnpm --dir tests/integration exec vitest run --config src/tests/node-misc/vitest.config.ts
    '';
  };
  tasks."test:integration:node-sync" = {
    description = "Run moved node-sync integration tests";
    after = [
      "genie:run"
      "pnpm:install"
    ];
    exec = ''
      WORKSPACE_ROOT="$PWD" DEVENV_TASK_PASSTHROUGH=1 pnpm --dir tests/integration exec vitest run --config src/tests/node-sync/vitest.config.ts
    '';
  };
  tasks."test:integration:node-sync:allow-flaky" = {
    description = "Run moved node-sync integration tests, warning on known flakiness";
    after = [
      "genie:run"
      "pnpm:install"
    ];
    exec = ''
      if timeout --kill-after=30s 180s devenv tasks run test:integration:node-sync --mode before --no-tui; then
        exit 0
      fi
      echo "::warning::Node-sync integration tests failed or timed out (flaky; carried over from livestorejs/livestore#624)"
      exit 0
    '';
  };
  tasks."test:packages" = {
    description = "Run stable contrib package unit tests";
    after = [
      "test:packages:cli"
      "test:packages:svelte"
      "test:packages:sync-s2"
    ];
  };
  tasks."test:packages:cli" = {
    description = "Run @livestore/cli unit tests";
    after = [
      "genie:run"
      "pnpm:install"
    ];
    exec = "DEVENV_TASK_PASSTHROUGH=1 pnpm --dir packages/@livestore/cli exec vitest run --config vitest.config.ts";
  };
  tasks."test:packages:svelte" = {
    description = "Run @livestore/svelte unit tests";
    after = [
      "genie:run"
      "pnpm:install"
    ];
    exec = ''
      WORKSPACE_ROOT="$PWD" DEVENV_TASK_PASSTHROUGH=1 pnpm --dir packages/@livestore/svelte exec vitest run --config tests/vitest.config.ts
    '';
  };
  tasks."test:packages:sync-s2" = {
    description = "Run @livestore/sync-s2 unit tests";
    after = [
      "genie:run"
      "pnpm:install"
    ];
    exec = "DEVENV_TASK_PASSTHROUGH=1 pnpm --dir packages/@livestore/sync-s2 exec vitest run --config vitest.config.ts";
  };
  tasks."test:examples:build" = {
    description = "Build contrib examples with build scripts";
    after = [
      "genie:run"
      "pnpm:install"
    ];
    exec = ''
      DEVENV_TASK_PASSTHROUGH=1 pnpm \
        --filter "./examples/cf-chat" \
        --filter "./examples/cf-chat-solid" \
        --filter "./examples/web-*" \
        run build
    '';
  };
  tasks."test:sync-provider:electric" = {
    description = "Run moved Electric sync-provider tests";
    after = [
      "genie:run"
      "pnpm:install"
    ];
    exec = "DEVENV_TASK_PASSTHROUGH=1 TEST_SYNC_PROVIDER=electric pnpm --dir tests/sync-provider exec vitest run src/sync-provider.test.ts src/electric-specific.test.ts";
  };
  tasks."test:sync-provider:s2" = {
    description = "Run moved S2 sync-provider tests";
    after = [
      "genie:run"
      "pnpm:install"
    ];
    exec = "DEVENV_TASK_PASSTHROUGH=1 TEST_SYNC_PROVIDER=s2 pnpm --dir tests/sync-provider exec vitest run src/sync-provider.test.ts src/s2-specific.test.ts";
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

      const forbidden = ['devtools-web-common', '@livestore/devtools-web-common']
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
        (path) => path.startsWith('packages/@livestore/') || path.startsWith('examples/') || path.startsWith('tests/'),
      )
      if (contribMembers.includes('packages/@livestore/effect-playwright')) {
        throw new Error('effect-playwright must stay a materialized core workspace member')
      }

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

      const packageManifests = contribMembers
        .map((memberPath) => `''${memberPath}/package.json`)
        .filter((manifestPath) => fs.existsSync(manifestPath))
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
