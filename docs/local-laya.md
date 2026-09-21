# Run Laya locally

Laya runs separately from the One System gateway. This guide starts the local
endpoint used by the [Privacy Demo](../README.md#try-the-local-router). The gateway
bundle does not include the adapter or model weights.

## Prepare the adapter

You need Git, Make, and [uv](https://docs.astral.sh/uv/getting-started/installation/).
The setup command supplies Python 3.12. The adapter supports CPU inference on
glibc-based Linux (x86_64 or ARM64, glibc 2.28 or newer) and Apple Silicon macOS 14
or newer, plus optional MLX GPU inference on Apple Silicon. The pinned PyTorch
wheels do not support Alpine Linux or Intel Macs; use a
separate supported machine for Laya, or a hosted-only gateway configuration.

Clone the repository in a directory separate from the extracted gateway bundle.
Repository access is currently required:

```sh
git clone --recurse-submodules https://github.com/rawwerks/one-system.git
cd one-system
make setup-laya
```

For Apple Silicon GPU inference, use `make setup-laya-mlx` instead. Both commands
use the committed dependency lock and enforce a three-day release-age minimum.
If setup reports an ineligible dependency, wait until the reported eligibility
time; do not change the lockfile just to make installation pass. The adapter
needs neither Go nor Node to run.

## Download the checkpoint

From the adapter checkout:

```sh
.venv/bin/hf download convaiinnovations/laya \
  model.safetensors rl_agent_config.json encoder/config.json \
  tokenizer/tokenizer.json tokenizer/tokenizer_config.json \
  --revision 1c5edc17a7acd8701df6fc341c0d179f1c62c982 \
  --local-dir models/laya
```

This fetches the pinned English checkpoint into ignored `models/laya`. Both CPU
and MLX use these original assets without conversion. Startup requires the
complete local checkpoint and never downloads missing files automatically.

## Start the endpoint

Create `.env` in the **adapter checkout**, then edit it locally:

```sh
(umask 077; set -C; cat > .env <<'ENV'
LOCAL_API_KEY=''
LAYA_MODEL_PATH='models/laya'
LAYA_RUNTIME='torch'
ENV
)
```

Set `LOCAL_API_KEY` to a fresh secret. Use that same value in the gateway's
separate `.env` file. For MLX, set `LAYA_RUNTIME='mlx'` after completing its setup.
Keep these files private; never paste real keys into shared examples or logs.
If `.env` already exists, the creation command fails rather than replacing it;
edit the existing file instead.

Start Laya in this terminal:

```sh
make serve-laya
```

Wait for `local_ready`, then leave it running and return to the
[Linux gateway setup](getting-started-linux.md#3-configure-and-start-the-gateway) or [macOS gateway setup](getting-started-macos.md#3-configure-and-start-the-gateway) in another terminal. The default
endpoint is `http://127.0.0.1:8091`. `LAYA_THREADS` controls CPU threads (default
4); it does not control MLX. Stop the server with Ctrl-C.

The serve target loads `.env` as shell code; use a file you trust. Its assignments
override shell-prefixed values. If you want to switch runtime or checkpoint,
change it in that file and restart.

## Keep all inference local

In the **gateway directory**, change `ONE_SYSTEM_CONFIG` in its `.env` to
`examples/local.backends.json`. Reload that file and restart the gateway:

```sh
set -a; . ./.env; set +a
./one-system
```

If you built the gateway from source, use `./bin/one-system` instead. The
local-only registry requires `ONE_SYSTEM_API_KEY` and `LOCAL_API_KEY`, but no
hosted TypeSafe key. Send the [README request](../README.md#send-your-first-question)
with its `model` changed to `local-demo`. There is no hosted destination in this
configuration, and the single backend does not need a selector call.

Laya uses an English-only checkpoint. It rejects inputs beyond its supported
limits rather than silently truncating them. The gateway does not turn this
model into a multilingual or unlimited-context model.

For adapter development and verification, see
[development checks](development-checks.md#validate-the-laya-adapter).
