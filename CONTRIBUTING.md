# Developing One System

This repository is public. A successful build, secret scan, or local test run does
not authorize a push, deployment, or release. Local development and synthetic tests require no inference credentials.

## Initialize contributor guidance

Clone with submodules so the official TypeSafe agent skill is available:

```sh
git clone --recurse-submodules https://github.com/rawwerks/one-system.git
```

For an existing checkout, run this from its root:

```sh
git submodule update --init --recursive
```

Before repository work, every agent and delegate must read the complete
[`third_party/typesafe-skills/skills/typesafe-ai/SKILL.md`](third_party/typesafe-skills/skills/typesafe-ai/SKILL.md),
not a summary or a recollection. Follow its live-documentation guidance as well.
The submodule pins the official [TypeSafe-AI/skills](https://github.com/TypeSafe-AI/skills)
release `v0.5.7`, commit `65a39f393687675ce170e6094757de20370365b9`.
It supplies contributor guidance only, not a gateway or inference runtime
dependency. Keep the recorded gitlink pin; initializing a checkout is not an
instruction to update it to an unreviewed upstream version.

## Choose the smallest setup

Start at the repository root with `make help`. The [README](README.md) introduces the
product and its first demo. See [development checks](docs/development-checks.md)
for the full check reference and [configuration](docs/configuration.md) for runtime
behavior. `mise.toml` pins Go, Node, Bun, and
uv; use `mise install` to prepare those tools. Node must be real Node 24, not Bun's
compatibility executable named `node`. For the full gateway development setup:

```sh
mise trust  # after reviewing mise.toml in a new checkout
mise install
make setup-dev
make doctor
make check
```

`setup-dev` prepares gateway and SDK dependencies without installing the optional
Laya/Torch stack. `doctor` diagnoses runtime identity, dependency availability, and
development-tool prerequisites without reading credentials or running inference.
`make check` is the one gate: the pre-push hook and the hosted workflow run exactly
it. It needs Gitleaks and `true-up` 0.2.1 on PATH; `make doctor` reports them
separately from gateway runtimes. See [the one gate](docs/development-checks.md#the-one-gate).

`true-up` 0.2.1 is available from source, not the npm registry. CI pins the
public commit below, whose launcher and library files match the tested 0.2.1
installation. Node runs it directly; optional symbol-extraction packages are
unnecessary because this repository sets `symbols: false`.

```sh
git clone --no-checkout https://github.com/rawwerks/true-up.git .build/true-up
git -C .build/true-up checkout --detach 527b3b81fc555d48730392cad41d388d5f6fbe0c
export PATH="$PWD/.build/true-up/bin:$PATH"
true-up --version  # true-up 0.2.1
make true-up-check
```

| Work | Setup | Verification |
| --- | --- | --- |
| Go gateway | `make setup build` | `make check-go` |
| Hono gateway | `make setup-hono build-hono` | `make check-hono` |
| SDK skill example | `make setup-examples` | `make check-examples` |
| SDK integration review/probe/gate | Same example environment | `make check-examples` (synthetic loopback HTTP) |
| Both gateways and SDK integration | All three setups above | `make check-conformance` (`ONE_SYSTEM_RUNTIMES=go` or `hono` for one) |
| Worker packaging and local runtime | Hono setup above | `make check-worker check-worker-local` |
| System One consumer scenarios | Node 24 and example environment | `make check-examples` |
| Verification tooling (TypeScript) | Hono setup above | `make check-verification` |
| Optional Laya CPU adapter startup | Node 24 and `make setup-laya` | `make check-laya-startup` |
| Optional Apple Silicon MLX adapter startup | Node 24 and `make setup-laya-mlx` | `LAYA_RUNTIME=mlx make check-laya-startup` |
| Laya inference scenarios | Adapter runtime and checkpoint (`LAYA_MODEL_PATH`) | `make check-laya` |

Bun and uv are required for the corresponding setup targets. Example setup uses
Python 3.12 and an isolated `.build/example-venv`. The optional `make setup-laya`
environment is separate: it installs the CPU inference stack into `.venv` and
requires a separately supplied checkpoint to serve requests. Apple Silicon can
add the MLX GPU runtime with `make setup-laya-mlx`. Adapter scenarios live under
`verification/`. `check-laya` requires a checkpoint and reports incomplete when it
is unavailable. `make check-laya-startup` collects only runtime/startup observations. This
environment is unnecessary for gateway development and conformance tests. See
[local Laya setup](docs/local-laya.md) for checkpoint setup and local-only operation.

An explicitly authorized CI run can bypass the adapter's 72-hour package cooldown:

```sh
gh workflow run check.yml --ref main -f bypass_package_cooldown=true
```

This manual option uses `uv sync --frozen` to install the committed versions
without updating the lockfile, and records the override in the run summary.
Commit matching dependency declarations and lockfile first: frozen mode treats
the lockfile as authoritative rather than checking it against the manifest.
Local setup and every other workflow run retain the cooldown. It changes package
eligibility only; all adapter startup/runtime checks still run.

Commit dependency declarations and their canonical lockfiles: `go.mod`/`go.sum`,
`hono/package.json`/`hono/bun.lock`, and `pyproject.toml`/`uv.lock`.
The SDK example's inline dependency metadata and `examples/requirements.lock`
are versioned together. Setup installs that exact hash-checked dependency lock;
`make update-examples-lock` deliberately regenerates it when changing the example
dependencies. Review the resulting versions and hashes before committing. Bun is
the only JavaScript package manager: `make setup-hono` installs the frozen
`hono/bun.lock` with a three-day minimum release age. To change a dependency,
edit the exact pin in `hono/package.json`, run `bun install --cwd hono
--minimum-release-age 259200`, and review the lock diff. `verification/` has no
package dependencies; it runs on Node 24 alone. Do not commit generated schema
modules, compiled bundles, package trees, virtual environments, or downloaded
weights. The build regenerates Hono schema modules from the pinned OpenAPI file.

Respect package release-age policy. If a pinned dependency is too new, retain the
pins and reuse an already installed compatible environment or wait. Do not weaken
the policy or substitute package versions just to make setup pass. Tests use
prepared environments; they do not implicitly install Python dependencies.
Routine checking is the local push gate described in
[the one gate](docs/development-checks.md#the-one-gate); the hosted workflows run
only when explicitly dispatched, mainly for optional macOS coverage. The hosted
conformance workflow runs the same `make setup-dev check` on Linux and macOS.
The separate adapter workflow checks CPU/MLX setup and startup without a checkpoint.
A package-age failure remains a real setup blocker,
not permission to switch from `--locked` to `--frozen` or relax cutoffs without
explicit authorization through the manual workflow above.
Adapter setup also validates every locked artifact's upload timestamp before
calling uv; even `--locked --refresh` can reuse a lock without reevaluating its
relative age cutoff. This check includes all platforms and extras, requires
timestamps, and fails before installing anything when an artifact is too young.

## Build local downloadable binaries

The Go gateway can be distributed without a source checkout or Go installation on
the receiving computer. Maintainers build bundles with the pinned Go and Node 24
runtimes plus GNU tar (`GNU_TAR=gtar` on a macOS build host):

```sh
make package-go
make check-go-packages
node --test verification/package-go.test.ts
```

The default output is `.build/downloads`; override it with `BUNDLE_OUT`. The output
directory must not already exist, so choose a new directory for a later build.
The packaging command downloads declared Go dependencies if necessary, builds
Linux/macOS amd64/arm64 binaries with CGO disabled, and includes only an explicit
asset allowlist. Output includes `install.sh`, four archives, and their `SHA256SUMS`.
Verification checks checksums, archive contents and binary architectures, then
starts both the host-native executable and installed launcher against synthetic
loopback services. The launcher is exercised from an unrelated working directory,
including installation paths with spaces and apostrophes. Other architectures
are not executed on that host; no paid inference is called.
Windows is not currently packaged. macOS binaries are not Developer-ID signed or
notarized; the ARM64 binary has been observed with an ad-hoc signature, which does
not establish a trusted publisher identity.
Reproducibility is checked for identical source and toolchain inputs:

```sh
make package-go BUNDLE_OUT=.build/downloads-repeat
cmp .build/downloads/SHA256SUMS .build/downloads-repeat/SHA256SUMS
```

Share only reviewed assets under the repository's current sharing policy.
`make package-go` does not publish anything. Recipient instructions are in
[the binary installation guide](docs/binary-install.md) and each archive's
`INSTALL.md`. Building these bundles does not replace normal development checks.

## Publish a Go release

Publishing a release is an explicitly authorized action, separate from building
local bundles or making the repository public. Releases are built and published
locally; no Actions run is required. All hosted workflows are manual-only:
neither branch nor tag pushes start them. The optional
[`Go release verification` workflow](.github/workflows/release.yml) builds all four targets
and verifies installation on native Linux/macOS runners, but never publishes,
even when dispatched at a tag:

```sh
gh workflow run release.yml --ref main
```

A local Linux check proves only its native runtime path, not macOS execution.
For current native macOS evidence, run the package checks on an actual Mac or
explicitly request the manual workflow. Cross-built archives are inspected, not
executed on an incompatible host. Report coverage gaps rather than treating
cross-compilation as native verification.

Complete the normal development/security checks and source/asset review before
tagging. This recipe does not call paid inference.
Prepare the full contributor toolchain above, including Gitleaks and true-up on
PATH, and authenticate `gh` with repository write access. Use the committed
Go 1.27.1 and Node 24.14.1 toolchain; set `GNU_TAR=gtar` on a macOS build host.
Run the following from the repository root after reviewing and committing the
intended sources. Choose a new `vMAJOR.MINOR.PATCH` tag (the value below is an
example), and confirm that `origin` is the intended repository.

```sh
(
  set -eu
  repository=rawwerks/one-system
  tag=v0.2.0
  commit=$(git rev-parse --verify 'HEAD^{commit}')
  test -z "$(git status --porcelain)"
  git remote get-url origin
  gh auth status
  remote_tag=$(git ls-remote --tags origin "refs/tags/$tag" "refs/tags/$tag^{}")
  test -z "$remote_tag" # Refuse an existing remote tag.
  make setup-hooks
  git tag -a "$tag" "$commit" -m "Release $tag" # Refuses an existing local tag.

  release_dir=$(mktemp -d "${TMPDIR:-/tmp}/one-system-release.XXXXXXXX")
  worktree="$release_dir/source"
  assets="$release_dir/assets"
  printf 'Release checkout and assets retained at %s\n' "$release_dir"
  # Invoke Git directly, without shell wrappers copying local dependency trees.
  command git worktree add --detach "$worktree" "$tag"
  (
    cd "$worktree"
    git submodule update --init --recursive
    test -z "$(git status --porcelain)"
    mise trust # Trust only the configuration already reviewed in this commit.
    mise exec -- make check-commit REV="$commit"
    mise exec -- make package-go BUNDLE_OUT="$assets"
    mise exec -- make check-go-packages BUNDLE_OUT="$assets"
    mise exec -- node --test verification/package-go.test.ts
  )

  # Ordinary push: the installed clean-checkout pre-push gate remains mandatory.
  git push origin "refs/tags/$tag:refs/tags/$tag"
  gh release create "$tag" --repo "$repository" --verify-tag --draft \
    --title "$tag" --notes "Go gateway bundles; see CONTRIBUTING.md for validation scope." \
    "$assets/install.sh" "$assets/SHA256SUMS" \
    "$assets/one-system-linux-amd64.tar.gz" \
    "$assets/one-system-linux-arm64.tar.gz" \
    "$assets/one-system-darwin-amd64.tar.gz" \
    "$assets/one-system-darwin-arm64.tar.gz"
  gh release view "$tag" --repo "$repository" --json isDraft,assets,url
  printf 'Review the draft and its six assets; type publish to publish/latest: '
  read -r approval
  test "$approval" = publish
  gh release edit "$tag" --repo "$repository" --draft=false --latest

  # Only this newly-created, clean checkout; Git requires force for submodules.
  test "$(git -C "$worktree" rev-parse HEAD)" = "$commit"
  test -z "$(git -C "$worktree" status --porcelain --ignore-submodules=none)"
  command git worktree remove --force "$worktree"
  printf 'Published %s; local assets retained at %s\n' "$tag" "$assets"
)
```

The six release assets are exactly `install.sh`, `SHA256SUMS`, and the four
platform archives listed above. Do not upload verification bodies or logs.
Tags and published releases are immutable: do not move/reuse tags, force-push,
replace releases, or clobber assets. `gh release create` refuses an existing
release. On failure, stop and inspect the retained checkout, assets, tag, and any
draft before deciding recovery; no failure trap deletes evidence. Cleanup first
requires the unchanged tagged commit and a clean worktree, including submodules.
Git requires `--force` to remove an initialized submodule checkout; this applies
only to the disposable worktree the recipe created, never dirty or unrelated
worktrees. The local release assets remain available for comparison.

Release assets are public: anonymous HTTPS installation and authenticated GitHub
CLI both work. Release checks establish packaging, installation, and synthetic
routing behavior, not inference quality or a blanket semantic pass. The content
review below still applies to everything a release publishes.

## Local configuration and private data

For a real gateway, copy the blank template with owner-only permissions:

```sh
(umask 077; cp -n .env.example .env)
```

Fill `.env` locally without pasting secrets into shared logs or documents. Go,
Node, and Laya serve targets source it as shell code, so only use a file you
trust. `check-laya` and `review` also source this file. Its assignments override same-named
exported variables, so configure each value in one place. The default
registry requires every named backend credential; blank keys deliberately fail
startup. See [`.env.example`](.env.example) for the variable names.

Each registry requires an operator-chosen top-level `name` matching
`^[A-Za-z0-9_-]+$` and distinct from all its backend IDs. Missing, empty, null,
non-string, malformed, or colliding names fail startup. To migrate, add the name
and update automatic-route clients to send it as `model`; there is no default or
compatibility `one-system` alias. An explicitly configured `one-system` name is
ordinary, not reserved. One System remains the project and `/v1/systemone` remains
the protocol path.

Choose a shipped configuration from the [configuration table](docs/configuration.md)
and put its unchanged path in `ONE_SYSTEM_CONFIG`. For example, `backends.json`
serves `routing-demo`, while `examples/privacy.backends.json` serves `privacy-demo`.
Authenticated `GET /v1/models` lists the automatic name first, then sorted direct
backend IDs. Example consumer CLIs require `--model` explicitly; choose the active
registry name for automatic routing or a backend ID for direct dispatch. A route
name does not grant privacy: review selector exposure, hosted leaf destinations,
and private-corpus opt-in separately.

Use these destinations for local artifacts:

| Artifact | Destination |
| --- | --- |
| Credentials | `.env`, `.secrets/`, or Worker secret bindings |
| Custom registry, private roster, or private request | `.local/` |
| Checkpoint and model cache | Outside the repository, or `models/` / `checkpoints/` |
| Local experiment output | `evidence/local/` or `scratch/` |
| Sessions and server logs | `sessions/` or `logs/` |

These directories are ignored by Git. `*.local.json` and `*.local.backends.json`
are ignored alternatives for custom registries. Canonical `backends.json`,
`examples/*.backends.json`, public examples, and the blank root `.env.example`
remain versioned. Put credential *environment variable names* in registry
`api_key_env` fields, never actual key values. Private backend URLs, corpus names,
instructions, and state may be sensitive even when they contain no credential.

Ignore rules do not protect files already tracked and do not prevent
`git add --force`. Review the staged diff before committing. To check a new local
path without opening it, run `git check-ignore -v -- path/to/file`.

## Verify a change

Run the checks for the component you changed. Routing, transport, configuration,
or shared contract changes require dual-runtime conformance. Worker-specific
changes also need local workerd smoke tests. Tests use loopback synthetic
services, and Worker packaging uses a deployment dry run. These checks establish
local behavior; they do not prove live inference quality or deployed behavior.

The repository hygiene regression checks both halves of the ignore policy:
private/generated paths must be ignored, and canonical source/templates/locks
must remain trackable. It uses a temporary Git repository, so it cannot read local
secrets or depend on personal global ignore rules:

`node verification/scenarios.ts --group repository` collects these executable
scenarios together with development-tool checks; `make check-scenarios` includes
them. It also checks that SDK dependency declarations and the hashed example lock agree.

Enable the repository hooks with `make setup-hooks`; [the one gate](docs/development-checks.md#the-one-gate)
describes what they enforce. `make check-secrets`, part of `make check`, scans tracked and nonignored working files and
Git history, including initialized pinned submodules, with secret values redacted.
Ignored, untracked local files are not included. Missing, uninitialized, mismatched,
or symlinked submodules fail before source copying. A secret scanner detects
credential patterns, not whether prompts, source
snippets, skill descriptions, paths, or inference responses are private.

Version prompts, contract changes, tests, and their human-facing documentation
together. `.true-up.json` declares which implementations, conformance tests and
contract cases derive from each shared spec file; `make true-up-impact BASE=<ref>`
lists them for review. Changes to those declarations require human approval. Use Mycelium
git notes for agent handoff details rather than adding session transcripts to
source files. Mycelium and every `refs/notes/*` ref are local-only: reading and
writing local notes remains supported, but do not run `mycelium.sh sync-init`,
push notes refs, or publish a repository mirror containing notes.

The pre-push hook's note guard is described with [the one gate](docs/development-checks.md#the-one-gate);
running source checks does not authorize note publication.

## Moving work between machines

Use independent Git clones and rebuild dependencies on each machine. Copy source
and reviewed local configuration separately. Do not sync `.git`, `.jj`, virtual
environments, `node_modules`, generated bundles, model caches, or credential files
as part of a source folder. A copied Python environment can retain interpreter
paths from the originating machine even when its files look complete.

Git ignore rules do **not** configure Syncthing or another synchronization tool.
If using Syncthing, maintain its machine-local/shared ignore policy separately and
verify that it covers all private directories you use. `.stignore*`, `.stfolder`,
`.stversions`, and conflict copies are excluded from Git. Investigate conflict
copies before accepting either version; do not publish archived source or logs.

## Keep what is published reviewed

This repository began from a single reviewed commit. Earlier development history,
recorded experiment evidence and agent Git notes remain in a private archive and
are not part of it. Do not import them: a clean working tree does not sanitize
history, and `.gitignore` does not filter what a commit already contains.

Everything pushed here is public immediately and may be cached or mirrored even
if later removed. Before pushing, review what the push publishes, not only the
files you edited. [The public-release review](docs/public-release-review.md) reads
every non-ignored file, and with `--history` every reachable blob, and reports what
a person should look at; its answers are review signals, not clearance.

Git notes stay local. Never publish `refs/notes/*`; the pre-push hook rejects it.
Removing a remote ref does not prove that a hosting service purged its objects or
cached views. Recorded prompts, responses, diagnostics and source snapshots are
experimental records, not an approved public dataset: keep them out of tracked
files unless they have been reviewed for release. Machine-specific paths,
identities and private registries do not belong in tracked files.

## Use the system while building it

`make review [BASE=<ref>]` judges each file changed since `BASE` (default
`origin/main`) against a frozen rubric through a temporary One System gateway and
pinned Jev, and lists the files to read. It needs `TYPESAFE_API_KEY` and may incur
charges. It is never a gate: confirm each flag by reading the diff. See
[System One reviews System One](docs/development-checks.md#system-one-reviews-system-one).

Cross-language tests are TypeScript scenarios under `verification/`. There is no
Python test framework or discovery command. `make check-scenarios` runs actual
tools and HTTP requests; each observation carries its own deterministic verdict.
See [scenario coverage](verification/SCENARIOS.md).
