# Install the Go gateway

GitHub Releases distribute the installer, four platform archives, and `SHA256SUMS`.
The installer needs ordinary shell utilities plus curl, or an authenticated
GitHub CLI. No Go, Node, Python, compiler,
sudo, or source checkout is required on the receiving computer.

## One-line installation

```sh
curl -fsSL https://github.com/rawwerks/one-system/releases/latest/download/install.sh | sh
```

`curl -f` stops on an HTTP error before anything runs. The installer keeps every
action inside one function that it calls on its last line, so a download that is
cut short cannot start an installation.

### Inspect it first

Download the installer, read it, then run it:

```sh
curl -fsSLO https://github.com/rawwerks/one-system/releases/latest/download/install.sh
less install.sh
sh install.sh
```

An authenticated GitHub CLI can fetch it as well, which also works for a private
fork: `gh release download --repo github.com/rawwerks/one-system --pattern install.sh`.

Default destinations:

- Complete bundle: `$HOME/.local/share/one-system`.
- Launcher: `$HOME/.local/bin/one-system`.

The installer detects OS/architecture, verifies the selected archive's SHA-256,
and rejects unexpected archive contents, links, and unsafe paths. Checksums
detect corruption, not a compromised publisher; trust the release source.
Existing installation and launcher paths, including dangling symlinks, are
refused rather than overwritten. This is not an automatic updater: use fresh
custom destinations for a new version, then deliberately migrate any private
configuration and switch your launcher.

Bundled data files are installed as `0644`; the bundle directories, gateway, and
launcher are `0755`, so readers of a shared prefix can use them. Existing
installations are not changed automatically; use fresh destinations for a
replacement. Do not broadly relax permissions on your own configuration or
credential files.

No service is started, credentials configured, `.env` loaded, shell profile
changed, or inference runtime installed. If `$HOME/.local/bin` is not on PATH,
use the launcher's full path or add that directory to your own shell profile.

## Versions, destinations, and offline installation

A downloaded `install.sh` accepts:

```sh
sh install.sh --help
# Use an existing release tag to pin the downloaded gateway bundle.
sh install.sh --version v0.2.0
# Neither the installation path nor bin-dir/one-system may already exist.
sh install.sh --prefix "$HOME/one-system-preview" --bin-dir "$HOME/one-system-preview-bin"
# Use reviewed local archives and their matching manifest; no network required.
sh install.sh --from /path/to/bundles
```

Pass the same options through a pipe with `sh -s --`. For a fully pinned
installation, take `install.sh` from the same release tag, not the moving latest
release, and pass that tag with `--version`:

```sh
curl -fsSL https://github.com/rawwerks/one-system/releases/download/v0.2.0/install.sh | sh -s -- --version v0.2.0
```

The installed launcher changes into the bundle directory before executing the
binary. Bundled relative registry and routing-question paths therefore work from
any caller directory. Use absolute paths for custom registries and their question
files. For applications that require a different working directory, invoke the
installed raw executable directly and retain responsibility for relative paths.

## Supported platforms and manual extraction

| Your computer | Archive |
| --- | --- |
| Linux, Intel/AMD 64-bit | `one-system-linux-amd64.tar.gz` |
| Linux, ARM 64-bit | `one-system-linux-arm64.tar.gz` |
| macOS, Intel | `one-system-darwin-amd64.tar.gz` |
| macOS, Apple Silicon | `one-system-darwin-arm64.tar.gz` |

`uname -s` identifies the OS; `uname -m` reports `x86_64` for Intel/AMD, or
`aarch64` / `arm64` for ARM. macOS requires version 13 or newer. Windows is not
packaged. The macOS executables are not Developer-ID signed or notarized; the
ARM64 binary has been observed with an ad-hoc signature, not a trusted publisher
identity. Device security policy may require approval. The installer does not
remove quarantine attributes or bypass those policies.

To install manually, obtain the matching archive and `SHA256SUMS` from the same
trusted release. On Linux:

```sh
sha256sum --check --ignore-missing SHA256SUMS
```

On macOS, select the matching checksum line:

```sh
# For Apple Silicon; use darwin-amd64 on Intel.
grep '  one-system-darwin-arm64.tar.gz$' SHA256SUMS | shasum -a 256 --check
```

Proceed only when verification reports `OK`. Extract the complete directory:

```sh
# Substitute your platform's archive and directory.
tar -xzf one-system-linux-amd64.tar.gz
cd one-system-linux-amd64
```

## Start with a hosted backend

Configure `ONE_SYSTEM_API_KEY` (the bearer key clients present to the gateway)
and `TYPESAFE_API_KEY` (your TypeSafe credential) in your launch environment.
Keep real credentials out of shared commands, shell history, and logs. Then run:

```sh
: "${ONE_SYSTEM_API_KEY:?Set your gateway bearer key in the environment}"
: "${TYPESAFE_API_KEY:?Set your TypeSafe credential in the environment}"
ONE_SYSTEM_ADDR=127.0.0.1:8090 \
ONE_SYSTEM_CONFIG=examples/jev-lint.backends.json \
"$HOME/.local/bin/one-system"
```

For a manually extracted archive, use `./one-system` from its directory instead.
This configuration uses a pinned hosted Jev evaluator; hosted calls may incur
provider charges. The executable reads environment variables directly and does
not automatically load `.env` files.

The service stays in the foreground; stop it with Ctrl-C. Clients use
`http://127.0.0.1:8090`, a matching bearer credential, and `POST /v1/systemone`.
Use `jev-lint` for this configuration's automatic route or backend ID `hosted`
for direct requests. Authenticated `GET /v1/models` lists routes;
`GET /v1/capabilities` lists backend capabilities.

## Other included configurations

- `backends.json`: `routing-demo`, with local and hosted services.
- `examples/privacy.backends.json`: `privacy-demo`, with
  `examples/routing.questions.json`. Local inference must be provided separately;
  this is domain-based routing, not a guarantee that all input stays local.
- `examples/local.backends.json`: `local-demo`, using a separately running
  compatible local service.
- `examples/simple-jev.backends.json`: `simple-jev-demo`, using external Simple Jev.

Every backend's `api_key_env` names a required environment variable. Configuring
a backend does not start or install it. Edit a private copy for your service URLs
and set `ONE_SYSTEM_CONFIG` to it, preserving its question-file references. Use
`GET /v1/models` to discover the active automatic route instead of assuming it
matches the project name.

The bundle includes configuration examples, routing questions, third-party
notices, and build information. It does not include private registries,
credentials, source histories, model weights, or developer verification output.
