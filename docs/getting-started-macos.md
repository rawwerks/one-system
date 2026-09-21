# Getting started on macOS

The prebuilt Go gateway runs on Intel and Apple Silicon Macs with **macOS 13 or
newer**, without Go or a compiler. The local Laya demo needs **Apple Silicon and macOS 14 or newer**.
Intel Macs can use a hosted backend or a separately running compatible server.

## 1. Install the gateway

The installer selects macOS amd64 or arm64 and checks that macOS is at least 13.
Use a native terminal on Apple Silicon; a terminal under Rosetta can report
`x86_64` and select the Intel binary.

Download and run the installer:

```sh
(f=$(mktemp) && trap 'rm -f "$f"' EXIT && curl --proto '=https' --proto-redir '=https' -fsSL https://github.com/rawwerks/one-system/releases/latest/download/install.sh -o "$f" && sh "$f")
```

An authenticated GitHub CLI works as well:

```sh
(f=$(mktemp) && trap 'rm -f "$f"' EXIT && gh release download --repo github.com/rawwerks/one-system --pattern install.sh --output "$f" --clobber && sh "$f")
```

Review [the installer](../scripts/install.sh) before executing downloaded code.
It requires no Go or sudo, refuses existing installation/launcher paths, and
does not edit your shell profile or start services. The executables are not
Developer-ID signed or notarized; the ARM64 binary has been observed with an
ad-hoc signature, not a trusted publisher identity. macOS or device policy may
require approval.
[Installation options](binary-install.md) cover explicit versions, custom
destinations, offline bundles, and manual extraction.

Enter the installed bundle for the remaining steps:

```sh
cd "$HOME/.local/share/one-system"
```

## 2. Choose the inference setup

**Apple Silicon:** follow [local Laya setup](local-laya.md) in a separate terminal.
Use `make setup-laya-mlx` with `LAYA_RUNTIME='mlx'` for GPU inference, or
`make setup-laya` with `LAYA_RUNTIME='torch'` for CPU. Wait for `local_ready` and
leave it running. The adapter needs Git, Make, uv, and a separately downloaded
English checkpoint. Use the same `LOCAL_API_KEY` for Laya and the gateway below.

**Intel:** the pinned local PyTorch wheel is unavailable. Start with the included
hosted-only Jev configuration below; it does not require Laya, Python, or a
checkpoint. Your inference requests will leave the Mac.

## 3. Configure and start the gateway

In the **extracted gateway directory**, create `.env`:

```sh
(umask 077; set -C; cat > .env <<'ENV'
ONE_SYSTEM_API_KEY=''
LOCAL_API_KEY=''
TYPESAFE_API_KEY=''
ONE_SYSTEM_CONFIG='examples/privacy.backends.json'
ENV
)
```

Open the file in your editor. Set `ONE_SYSTEM_API_KEY` to a fresh secret and
`TYPESAFE_API_KEY` to your [TypeSafe API key](https://docs.typesafe.ai/introduction/quickstart).
For the local demo, set `LOCAL_API_KEY` to the running adapter's key.
For **hosted-only** use, change `ONE_SYSTEM_CONFIG` to
`examples/jev-lint.backends.json`; `LOCAL_API_KEY` may remain empty.

Keep `.env` private. The creation command refuses to replace an existing file;
edit it instead. Start the gateway:

```sh
set -a; . ./.env; set +a
./one-system
```

Wait for `listening`. The gateway stays in the foreground at
`http://127.0.0.1:8090`; stop it with Ctrl-C. It does not load `.env` automatically,
so reload that file after changing it. Only source a file you trust.

## 4. Send a request

In another terminal, return to the extracted gateway directory:

```sh
set -a; . ./.env; set +a
curl --fail-with-body \
  -H "Authorization: Bearer $ONE_SYSTEM_API_KEY" \
  http://127.0.0.1:8090/v1/models
```

For the local router, the list includes `privacy-demo`; continue with the
[README's first question](../README.md#send-your-first-question).
For hosted-only use, send the same request with `model` changed to `jev-lint`.

Mixed and hosted-only configurations can send the full request to Jev and incur
charges. To keep all inference on an Apple Silicon Mac, use
`examples/local.backends.json` with `model: "local-demo"`, retain both local keys,
and omit the hosted key. Reload `.env` and restart after changing configuration.
