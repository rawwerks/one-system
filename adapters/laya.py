"""Local Laya adapter for the vendored official TypeSafe System One contract."""

from contextlib import nullcontext
import hmac
import json
import math
import os
import platform
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import sys

# A local path is mandatory. Missing checkpoint assets must never trigger a download.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

from jsonschema import Draft202012Validator

MODEL = "laya-english"
MAX_BODY_BYTES = 1024 * 1024
MAX_QUESTIONS = 16  # Bound simultaneous encoder sequences on this local service.
OPTION_TOKENS = 48  # laya 0.3.3's build_sequence clips each option at this boundary.


class UnsupportedInput(ValueError):
    """A schema-valid request that this checkpoint cannot evaluate losslessly."""


def finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Non-finite JSON number")
    return number


def reject_constant(value):
    raise ValueError("Non-finite JSON constant")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON object key")
        result[key] = value
    return result


class LocalLaya:
    def __init__(self, model_path, threads, runtime="torch"):
        if runtime not in ("torch", "mlx"):
            raise ValueError("LAYA_RUNTIME must be torch or mlx")
        if runtime == "mlx" and (sys.platform != "darwin" or platform.machine() != "arm64"):
            raise ValueError("The MLX runtime requires native Apple Silicon macOS")
        document = json.loads(
            (Path(__file__).resolve().parent.parent / "schema" / "typesafe.openapi.json").read_text()
        )
        self.schemas = document["components"]["schemas"]
        self.validators = {
            name: Draft202012Validator({
                "$ref": f"#/components/schemas/{name}",
                "components": document["components"],
            })
            for name in ("SystemOneRequest", "SystemOneResponse", "ModelMetadataList")
        }
        checkpoint = Path(model_path).expanduser().resolve(strict=True)
        required = (
            "rl_agent_config.json", "model.safetensors", "encoder/config.json",
            "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json",
        )
        if not checkpoint.is_dir() or not all((checkpoint / name).is_file() for name in required):
            raise ValueError("LAYA_MODEL_PATH must contain the complete downloaded checkpoint")
        if threads < 1:
            raise ValueError("LAYA_THREADS must be a positive integer")
        self.runtime = runtime
        if runtime == "mlx":
            import laya_mlx as laya
            from laya_mlx import common

            self.agent = laya.load(str(checkpoint), device="gpu", dtype="float32", batch_size=MAX_QUESTIONS)
            self.inference_context = nullcontext
            self.device = "gpu"
            runtime_description = "MLX GPU FP32"
        else:
            import laya
            from laya import common
            import torch

            torch.set_num_threads(threads)
            torch.set_num_interop_threads(1)
            self.agent = laya.load(str(checkpoint), device="cpu")
            self.agent.model.float().eval()
            self.agent.dtype = torch.float32
            self.inference_context = torch.inference_mode
            self.device = "cpu"
            runtime_description = "CPU FP32"
        self.common = common
        self.max_len = self.agent.cfg.get("max_len", 512)
        self.head_max_len = self.agent.cfg.get("head_max_len", 192)
        self.catalogue = {"models": [{
            "name": MODEL,
            "description": (
                f"Local {runtime_description} Laya English adapter: short English classification, "
                "yes/no (noul), and ordinal scoring; structured JSON accepted. "
                f"At most {MAX_QUESTIONS} questions per batch; Choice/Score needs ≥2 options. "
                f"Each rendered option ≤{OPTION_TOKENS} tokenizer tokens; options with "
                f"markers ≤{self.head_max_len - 16} tokens; instructions/type header plus "
                f"options ≤{self.head_max_len} tokens; full sequence including state and "
                f"special tokens ≤{self.max_len}. Literal mask tokens unsupported. "
                "Requests exceeding any bound return 422, never truncate."
            ),
            # Release of this adapter, not a claim about the upstream checkpoint date.
            "release_date": "2026-09-19",
        }]}
        self.validators["ModelMetadataList"].validate(self.catalogue)

    def prepare(self, request):
        if not self.validators["SystemOneRequest"].is_valid(request):
            raise UnsupportedInput("Request does not match the official SystemOneRequest schema")
        if request["model"] != MODEL:
            raise UnsupportedInput("Local model must be laya-english; use GET /v1/models")
        if len(request["questions"]) > MAX_QUESTIONS:
            raise UnsupportedInput(f"Local memory budget allows at most {MAX_QUESTIONS} questions per request")
        questions = {}
        state = request["state"]
        tok = self.agent.tok
        mask = tok.mask_token
        state_text = self.common.serialize_state(state)
        if mask in state_text:
            raise UnsupportedInput("Local input cannot contain the tokenizer's literal mask token")
        state_ids = tok(state_text, add_special_tokens=False)["input_ids"]
        if len(state_ids) > self.max_len:
            raise UnsupportedInput(f"Local complete formatted context must fit {self.max_len} tokens")
        for qid, original in request["questions"].items():
            question = dict(original)
            if question.get("instructions") is None:
                question["instructions"] = ""
            if question["type"] in ("choice", "score"):
                if len(question["criteria"]) < 2:
                    raise UnsupportedInput("Local Choice/Score requires at least two criteria")
            # Use Laya's exact structured-JSON rendering, not a Python repr or a flattened rubric.
            internal = self.agent._to_internal(question)
            options = self.common.render_options(internal)
            if mask in internal["ins"] or any(mask in option for option in options):
                raise UnsupportedInput("Local input cannot contain the tokenizer's literal mask token")
            head_ids = tok(
                f"{internal['t']} question: {internal['ins']}", add_special_tokens=False
            )["input_ids"]
            option_ids = [
                tok(" " + option, add_special_tokens=False)["input_ids"] for option in options
            ]
            if any(len(ids) > OPTION_TOKENS for ids in option_ids):
                raise UnsupportedInput(
                    f"Each local rendered criterion must fit {OPTION_TOKENS} tokenizer tokens"
                )
            options_size = sum(len(ids) + 1 for ids in option_ids)
            if options_size > self.head_max_len - 16:
                raise UnsupportedInput(
                    f"Local criteria including mask markers must fit {self.head_max_len - 16} tokens"
                )
            if len(head_ids) + options_size > self.head_max_len:
                raise UnsupportedInput(
                    f"Local instructions/type header and criteria must fit {self.head_max_len} tokens"
                )
            # CLS and three SEP tokens surround the header, options, and state.
            if len(head_ids) + options_size + len(state_ids) + 4 > self.max_len:
                raise UnsupportedInput(f"Local complete formatted context must fit {self.max_len} tokens")
            # Guard against sequence-builder changes silently invalidating these capacity checks.
            expected = [tok.cls_token_id, *head_ids, tok.sep_token_id]
            for ids in option_ids:
                expected.extend([tok.mask_token_id, *ids])
            expected.extend([tok.sep_token_id, *state_ids, tok.sep_token_id])
            sequence, markers = self.common.build_sequence(tok, state, internal, self.max_len, self.head_max_len)
            if sequence != expected or len(markers) != len(options):
                raise RuntimeError("Laya sequence construction did not preserve the checked input")
            questions[qid] = question
        return questions

    def system_one(self, request):
        questions = self.prepare(request)
        with self.inference_context():
            result = self.agent.system_one(request["state"], questions)
        if result["answers"].keys() != questions.keys():
            raise RuntimeError("Laya returned mismatched answer identifiers")
        answers = {}
        mapping = self.schemas["Answer"]["discriminator"]["mapping"]
        for qid, question in questions.items():
            answer = result["answers"][qid]
            if answer["type"] != question["type"]:
                raise RuntimeError("Laya returned a mismatched answer type")
            component = mapping[question["type"]].rsplit("/", 1)[-1]
            # Laya's action and noul-confidence extensions are not public answer fields.
            answers[qid] = {
                key: value for key, value in answer.items()
                if key in self.schemas[component]["properties"]
            }
            if question["type"] == "score":
                legend = {str(index): value for index, value in enumerate(question["criteria"])}
                if answers[qid]["legend"] != legend:
                    raise RuntimeError("Laya changed the structured score legend")
        response = {"model": MODEL, "answers": answers, "usage": result["usage"]}
        self.validators["SystemOneResponse"].validate(response)
        return response


class Handler(BaseHTTPRequestHandler):
    server_version = "OneSystemLaya"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def log_message(self, format, *args):
        # BaseHTTPRequestHandler's request-line logging could disclose user-supplied data.
        pass

    def send_json(self, status, body):
        encoded = json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        self.wfile.write(encoded)

    def error(self, status, message):
        self.send_json(status, {"detail": [{"loc": ["body"], "msg": message, "type": "request_error"}]})

    def authorized(self):
        supplied = self.headers.get_all("Authorization", [])
        if len(supplied) != 1 or not hmac.compare_digest(
            supplied[0].encode("utf-8"), self.server.authorization
        ):
            self.error(401, "Bearer authentication required")
            return False
        return True

    def do_GET(self):
        if self.path != "/v1/models":
            self.error(404, "Not found")
        elif self.authorized():
            self.send_json(200, self.server.adapter.catalogue)

    def do_POST(self):
        if self.path != "/v1/systemone":
            self.error(404, "Not found")
            return
        if not self.authorized():
            return
        try:
            lengths = self.headers.get_all("Content-Length", [])
            if self.headers.get("Transfer-Encoding") is not None or len(lengths) != 1:
                raise UnsupportedInput("One Content-Length header is required; chunked bodies unsupported")
            if not lengths[0].isascii() or not lengths[0].isdecimal():
                raise UnsupportedInput("Content-Length must be a nonnegative integer")
            length = int(lengths[0])
            if not 0 < length <= MAX_BODY_BYTES:
                raise UnsupportedInput(f"JSON request body must contain 1–{MAX_BODY_BYTES} bytes")
            body = self.rfile.read(length)
            if len(body) != length:
                raise UnsupportedInput("Incomplete JSON request body")
            try:
                request = json.loads(
                    body.decode("utf-8"), parse_float=finite_float,
                    parse_constant=reject_constant, object_pairs_hook=unique_object,
                )
            except (ValueError, RecursionError):
                raise UnsupportedInput("Body must be valid UTF-8 JSON with unique keys and finite numbers") from None
            response = self.server.adapter.system_one(request)
            self.send_json(200, response)
        except UnsupportedInput as error:
            self.error(422, str(error))  # Only fixed adapter messages, never schema instance values.
        except (BrokenPipeError, ConnectionResetError):
            return
        except TimeoutError:
            self.error(422, "Request body read timed out")
        except Exception as error:
            # Do not expose exceptions, question IDs, state, or credentials in HTTP or logs.
            print(json.dumps({"event": "local_inference_error", "error_type": type(error).__name__}), file=sys.stderr, flush=True)
            self.error(500, "Local model evaluation failed; no fallback was attempted")

    def do_HEAD(self):
        self.send_response(405)
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

    def unsupported_method(self):
        self.error(405, "Method not allowed")

    do_OPTIONS = do_PUT = do_PATCH = do_DELETE = unsupported_method


def main():
    key = os.environ.get("LOCAL_API_KEY")
    if not key:
        raise ValueError("LOCAL_API_KEY is required")
    model_path = os.environ.get("LAYA_MODEL_PATH")
    if not model_path:
        raise ValueError("LAYA_MODEL_PATH is required; checkpoint downloads are disabled")
    address = os.environ.get("LAYA_ADDR", "127.0.0.1:8091")
    host, separator, port = address.rpartition(":")
    if not separator or not host:
        raise ValueError("LAYA_ADDR must be host:port")
    adapter = LocalLaya(
        model_path, int(os.environ.get("LAYA_THREADS", "4")),
        runtime=os.environ.get("LAYA_RUNTIME", "torch"),
    )
    # HTTPServer is intentionally single-threaded: model inference is serialized and
    # concurrent requests cannot oversubscribe the configured CPU thread budget.
    with HTTPServer((host, int(port)), Handler) as server:
        server.authorization = ("Bearer " + key).encode("utf-8")
        server.adapter = adapter
        print(json.dumps({"event": "local_ready", "model": MODEL, "runtime": adapter.runtime, "device": adapter.device}), flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
