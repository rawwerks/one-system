# Getting started on Linux

This guide runs the prebuilt Go gateway and the local-Laya/hosted-Jev demo.
The gateway needs no compiler or Go installation. The separate Laya adapter
needs Git, Make, uv, and its downloaded checkpoint. Local Laya requires a
glibc-based x86_64 or ARM64 Linux system with glibc 2.28 or newer; the pinned
PyTorch wheels do not support Alpine Linux.

## 1. Install the gateway

The installer selects Linux amd64 or arm64 and verifies the complete bundle:

```sh
curl -fsSL https://github.com/rawwerks/one-system/releases/latest/download/install.sh | sh
```

No Go, sudo, or model installation is involved. The installer preserves existing
installations by refusing to replace them; it does not change shell profiles or
start the gateway. Review [the installer](../scripts/install.sh) before executing
downloaded code. [Installation options](binary-install.md) cover explicit versions,
custom destinations, offline bundles, and manual extraction.

Enter the installed bundle for the remaining steps:

```sh
cd "$HOME/.local/share/one-system"
```

## 2. Start local Laya

In a separate terminal, follow [local Laya setup](local-laya.md). On Linux, use
`make setup-laya` and the default `LAYA_RUNTIME='torch'`. Wait for `local_ready`
and leave that server running. Its default address is `http://127.0.0.1:8091`.
Use the same `LOCAL_API_KEY` for Laya and the gateway below.

Laya's checkpoint is English-only. Model installation is separate from unpacking
the gateway; no model weights are included in the bundle.

## 3. Configure and start the gateway

Return to the **extracted gateway directory** and create `.env`:

```sh
(umask 077; set -C; cat > .env <<'ENV'
ONE_SYSTEM_API_KEY=''
LOCAL_API_KEY=''
TYPESAFE_API_KEY=''
ONE_SYSTEM_CONFIG='examples/privacy.backends.json'
ENV
)
```

Open that file in your editor. Set `ONE_SYSTEM_API_KEY` to a fresh secret,
`LOCAL_API_KEY` to the running adapter's key, and `TYPESAFE_API_KEY` to your
[TypeSafe API key](https://docs.typesafe.ai/introduction/quickstart). Keep the
file private. If it already exists, the command refuses to overwrite it; edit
that file instead.

```sh
set -a; . ./.env; set +a
./one-system
```

Wait for `listening`. The gateway listens at `http://127.0.0.1:8090` and stays in
the foreground. Stop it with Ctrl-C. It reads environment variables and does not
automatically load `.env`; only source a file you trust.

## 4. Send a request

In another terminal, return to the extracted gateway directory:

```sh
set -a; . ./.env; set +a
curl --fail-with-body \
  -H "Authorization: Bearer $ONE_SYSTEM_API_KEY" \
  http://127.0.0.1:8090/v1/models
```

You should see `privacy-demo`, `local`, and `hosted`. Continue with the
[README's first question](../README.md#send-your-first-question).

The mixed demo can send the full request to hosted Jev and incur charges; it is
not a private-data detector. To keep all requests local, change `.env` to
`ONE_SYSTEM_CONFIG='examples/local.backends.json'`, reload it, restart the gateway,
and use `model: "local-demo"`. No hosted key is required for that configuration.
