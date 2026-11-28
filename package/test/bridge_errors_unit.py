"""Unit tests for bridge.py error reporting. Run by bridge.errors.test.mjs."""

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.normpath(os.path.join(HERE, "..", "src", "bridge.py"))

failures = []


def check(name, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    print(f"{status} {name}" + ("" if condition or detail == "" else f": {detail}"))
    if not condition:
        failures.append(name)


def main():
    spec = importlib.util.spec_from_file_location("bridge_under_test", BRIDGE)
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)

    # 1. The real exception text must reach the user, not a canned mask.
    result = bridge.bridge_error_message(Exception('HTTP 402: {"message":"billing_api_budget_exhausted"}'))
    check("real exception text is preserved", "billing_api_budget_exhausted" in result["message"], result)
    check("no canned installation mask", "Check the Vibe installation" not in result["message"], result)
    check("exception class name is preserved", "Exception" in result["message"], result)

    # 2. HTTP status codes pass through so OpenCode can show them.
    class WithStatus(Exception):
        status_code = 402

        def __str__(self):
            return "quota exceeded"

    result = bridge.bridge_error_message(WithStatus())
    check("http status passes through", result.get("status") == 402, result)
    check("status error text is preserved", "quota exceeded" in result["message"], result)

    # 3. Credentials leaked into an exception must be redacted.
    leaked = Exception("auth failed for key mstrl_SuperSecretToken_123 header Bearer abc.def.ghi junk sk-xyz")
    result = bridge.bridge_error_message(leaked)
    check("raw api key redacted", "SuperSecretToken" not in result["message"], result)
    check("bearer token redacted", "abc.def.ghi" not in result["message"], result)
    check("sk token redacted", "sk-xyz" not in result["message"], result)
    check("non-secret text survives redaction", "auth failed" in result["message"], result)

    # 4. The no-credential message must say what was actually checked.
    message = bridge.no_credential_message()
    check("mentions MISTRAL_API_KEY", "MISTRAL_API_KEY" in message, message)
    check("mentions VIBE_CLI_OIDC_ENABLED", "VIBE_CLI_OIDC_ENABLED" in message, message)
    check("mentions keyring backend", "keyring" in message.lower(), message)
    check("still actionable", "--setup" in message and "vibe" in message, message)

    # 11. The login command must name the vibe executable shipped next to the
    #     interpreter in use, so the login runs on the plugin-managed runtime
    #     (not whatever happens to be first on the user's PATH).
    import pathlib as _pl
    import tempfile as _tf
    import types as _types

    original_sys = bridge.sys
    bin_dir = "Scripts" if os.name == "nt" else "bin"
    py_name = "python.exe" if os.name == "nt" else "python"
    vibe_name = "vibe.exe" if os.name == "nt" else "vibe"
    login_dir = _tf.mkdtemp()
    _pl.Path(login_dir, bin_dir).mkdir(parents=True, exist_ok=True)
    _pl.Path(login_dir, bin_dir, py_name).write_text("", encoding="utf-8")
    _pl.Path(login_dir, bin_dir, vibe_name).write_text("", encoding="utf-8")
    bridge.sys = _types.SimpleNamespace(executable=str(_pl.Path(login_dir, bin_dir, py_name)))
    try:
        message = bridge.no_credential_message()
        expected = str(_pl.Path(login_dir, bin_dir, vibe_name))
        check("login command names the runtime-local vibe executable", expected in message, message)
    finally:
        bridge.sys = original_sys
        _pl.Path(login_dir).exists() and __import__("shutil").rmtree(login_dir, ignore_errors=True)

    # 5. The crash path must emit the real error even when the diagnostics
    #    dump cannot be written, and the dump itself must be redacted.
    import contextlib
    import io
    import pathlib
    import tempfile

    with tempfile.NamedTemporaryFile(delete=False) as blocker:
        blocker.write(b"")
    original_dump = getattr(bridge, "crash_dump_path", None)
    captured = io.StringIO()
    try:
        raise RuntimeError("real bridge failure")
    except RuntimeError as error:
        # A file used as a directory parent: every mkdir/write below it fails.
        bridge.crash_dump_path = lambda: pathlib.Path(blocker.name) / "nested" / "bridge-last-error.txt"
        try:
            with contextlib.redirect_stdout(captured):
                bridge.report_crash(error)  # must not raise despite the unwritable dump location
        finally:
            if original_dump is None:
                del bridge.crash_dump_path
            else:
                bridge.crash_dump_path = original_dump
    emitted = captured.getvalue()
    check("crash path emits the real error when the dump fails", "real bridge failure" in emitted, emitted)

    dump_dir = tempfile.mkdtemp()
    dump_path = pathlib.Path(dump_dir) / "bridge-last-error.txt"
    captured = io.StringIO()
    try:
        raise RuntimeError("auth failed for key mstrl_SecretKey_123 header Bearer abc.def.ghi")
    except RuntimeError as error:
        bridge.crash_dump_path = lambda: dump_path
        try:
            with contextlib.redirect_stdout(captured):
                bridge.report_crash(error)
        finally:
            if original_dump is None:
                del bridge.crash_dump_path
            else:
                bridge.crash_dump_path = original_dump
    text = dump_path.read_text(encoding="utf-8")
    check("crash dump keeps the real error", "auth failed" in text, text)
    check("crash dump redacts api keys", "SecretKey" not in text, text)
    check("crash dump redacts bearer tokens", "abc.def.ghi" not in text, text)
    check("crash dump records the status code", "status_code=" in text, text)
    emitted = captured.getvalue()
    check("crash path emits the redacted error", "auth failed" in emitted and "SecretKey" not in emitted, emitted)

    # 6. Raw OIDC JWTs (no Bearer prefix) must be redacted too.
    leaked = Exception(
        "rejected token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    )
    result = bridge.bridge_error_message(leaked)
    check("raw jwt redacted without bearer prefix", "SflKxw" not in result["message"], result)
    check("non-secret text survives jwt redaction", "rejected token" in result["message"], result)

    # 7. The Authorization swap must fail with a real cause on malformed headers.
    try:
        bridge.extract_oidc_token({"Authorization": "Token abc"})
        check("malformed authorization rejected", False, "no error raised")
    except ValueError as error:
        check("malformed authorization rejected with real cause", "Authorization" in str(error), str(error))
    try:
        bridge.extract_oidc_token({})
        check("missing authorization rejected", False, "no error raised")
    except ValueError as error:
        check("missing authorization rejected with real cause", "missing" in str(error).lower(), str(error))
    headers = {"Authorization": "Bearer live-token", "x-other": "y"}
    check(
        "valid bearer token extracted and removed from headers",
        bridge.extract_oidc_token(headers) == "live-token" and "Authorization" not in headers,
        headers,
    )

    # 8. Credential awaits must be bounded so a hang surfaces as a real timeout.
    import asyncio as _asyncio

    async def _hang():
        await _asyncio.sleep(30)

    try:
        _asyncio.run(bridge.bounded(_hang(), 0.05))
        check("hanging credential await is bounded", False, "no timeout raised")
    except TimeoutError:
        check("hanging credential await is bounded", True)

    # 9. The completion metadata must route billing to the Vibe plan.
    metadata = bridge.completion_metadata("3.1.3")
    check("metadata routes billing to the vibe plan", metadata.get("call_source") == "vibe_code", metadata)
    check("metadata identifies the client", metadata.get("client_name") == "opencode-mistral-vibe", metadata)
    check("metadata pins the release", metadata.get("agent_version") == "3.1.3", metadata)

    # 10. An OIDC failure must carry an observed network diagnostic, because
    #     mistral-vibe's _resolve_id_token swallows the real cause
    #     ("raise OidcError(...) from None"): a bare OidcError hides the
    #     offline/refused/hung root cause from the user.
    async def _oidc_boom():
        raise ValueError("original cause")

    try:
        _asyncio.run(bridge.oidc_with_diagnosis(_oidc_boom(), "not a url"))
        check("oidc failures are enriched, not passed through bare", False, "no error raised")
    except ValueError as error:
        message = str(error)
        check("oidc failure keeps the real error", "original cause" in message, message)
        check("oidc failure carries a network diagnostic", "network check" in message, message)

    async def _oidc_ok():
        return 42

    check(
        "oidc_with_diagnosis passes success through untouched",
        _asyncio.run(bridge.oidc_with_diagnosis(_oidc_ok(), "https://x.example")) == 42,
    )

    if failures:
        print(f"FAILED: {len(failures)}")
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    main()
