"""Scripted bridge used by the process.ts unit tests.

Speaks the same NDJSON protocol as src/bridge.py but acts out the scenario
named in the request (or in the FAKE_BRIDGE_SCENARIO environment variable).
Run with: python -u fake-bridge.py
"""

import json
import os
import sys

CATALOG = {
    "type": "catalog",
    "version": "3.1.3",
    "source": "remote",
    "models": [
        {
            "id": "fake-model",
            "name": "Fake Model",
            "context": 1000,
            "output": 100,
            "images": False,
            "efforts": [],
            "authenticated": True,
        },
        {
            "id": "zai-glm-5-3-flash",
            "name": "GLM Flash",
            "context": 2000,
            "output": 200,
            "images": False,
            "efforts": ["low", "high"],
            "authenticated": True,
        },
        {
            "id": "deepseek-v4-1-flash-1017",
            "name": "DeepSeek Flash",
            "context": 2000,
            "output": 200,
            "images": False,
            "efforts": ["low", "medium", "high"],
            "authenticated": True,
        },
        {
            "id": "hidden-model",
            "name": "Hidden Model",
            "context": 1000,
            "output": 100,
            "images": False,
            "efforts": [],
            "authenticated": True,
            "hidden": True,
        },
    ],
}

RESULT = {
    "type": "result",
    "parts": [{"type": "text", "text": "fake answer"}],
    "finish_reason": "stop",
    "usage": {
        "input_tokens": 1,
        "output_tokens": 2,
        "cached_input_tokens": 0,
        "cache_write_tokens": 0,
        "reasoning_tokens": 0,
    },
}


def send(value):
    sys.stdout.write(json.dumps(value) + "\n")


if "--warm" in sys.argv and os.environ.get("FAKE_BRIDGE_WARM_PID_FILE"):
    with open(os.environ["FAKE_BRIDGE_WARM_PID_FILE"], "w") as handle:
        handle.write(str(os.getpid()))

line = sys.stdin.readline()
try:
    request = json.loads(line)
except Exception:  # noqa: BLE001 - any malformed stdin acts out the invalid-json scenario
    request = {"scenario": "invalid-json"}
if not request.get("scenario") and os.environ.get("FAKE_BRIDGE_SCENARIO"):
    request["scenario"] = os.environ["FAKE_BRIDGE_SCENARIO"]

if request.get("pidFile"):
    with open(request["pidFile"], "w") as handle:
        handle.write(str(os.getpid()))

scenario = request.get("scenario")

if scenario == "invalid-json":
    sys.stdout.write("this is not json\n")
elif scenario == "schema-invalid":
    send({"type": "catalog", "version": "3.1.3", "models": [{"id": "x", "authenticated": "not-a-boolean"}]})
elif scenario == "bridge-error":
    send({"type": "error", "message": "boom from fake bridge", "status": 402})
elif scenario == "unauthenticated-catalog":
    send(dict(CATALOG, source="local", models=[dict(CATALOG["models"][0], authenticated=False)]))
elif scenario == "data-after-terminal":
    send(RESULT)
    send({"type": "text", "text": "unexpected"})
elif scenario == "no-terminal":
    pass
elif scenario == "nonzero-exit":
    send({"type": "text", "text": "partial"})
    sys.exit(3)
elif scenario == "trailing-bytes":
    sys.stdout.write(json.dumps(RESULT) + "\ntrailing without newline")
elif scenario == "oversized":
    sys.stdout.write("x" * (33 * 1024 * 1024) + "\n")
elif scenario == "hang":
    send({"type": "text", "text": "working..."})
    import time

    time.sleep(600)
elif scenario == "stream":
    send({"type": "reasoning", "text": "thinking"})
    send({"type": "text", "text": "Hel"})
    send({"type": "text", "text": "lo"})
    send(RESULT)
else:
    send(CATALOG if request.get("type") == "probe" else RESULT)
sys.stdout.flush()
