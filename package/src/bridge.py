"""One model call through the installed Vibe runtime; never starts its tool loop.

Stdio is a private NDJSON transport. Credentials are resolved by Vibe and never
leave this process. This adapter targets mistral-vibe 3.1.x's Python interfaces.
"""

import asyncio
import json
import os
import re
import sys
from importlib.metadata import version


def emit(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


_TOKEN_PATTERNS = (
    re.compile(r"mstrl_[A-Za-z0-9_\-]+"),
    re.compile(r"sk-[A-Za-z0-9_\-]+"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]+"),
    # Bare OIDC ID token (JWT) echoed without a Bearer prefix, e.g. in a URL.
    re.compile(r"eyJ[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}"),
)


def redact_secrets(text):
    """Keep the real error text, but never leak credentials embedded in it."""
    for pattern in _TOKEN_PATTERNS:
        text = pattern.sub("Bearer <redacted>" if "bearer" in pattern.pattern.lower() else "<redacted>", text)
    return text


def bridge_error_message(error):
    """Turn an exception into an error event with the real cause, status included.

    OpenCode surfaces this text directly in its retry banner, so masking it
    behind a generic "run vibe --setup" hint hides real failures such as 402
    quota, timeouts or auth errors.
    """
    status = getattr(error, "status_code", None)
    response = getattr(error, "response", None)
    if not isinstance(status, int) and response is not None:
        status = getattr(response, "status_code", None)
    message = redact_secrets(f"{type(error).__name__}: {error}")
    event = {"type": "error", "message": message}
    if isinstance(status, int):
        event["status"] = status
    return event


def login_command():
    """The vibe executable shipped with the interpreter in use, when present.

    Naming it keeps the login on the runtime actually serving requests (the
    plugin-managed one when bootstrapped), not whatever is first on PATH.
    """
    candidate = os.path.join(os.path.dirname(sys.executable), "vibe.exe" if os.name == "nt" else "vibe")
    return candidate if os.access(candidate, os.X_OK) else "vibe"


def no_credential_message():
    """Explain exactly which credential sources were checked and came up empty."""
    api_key = "set" if os.environ.get("MISTRAL_API_KEY") else "not set"
    oidc = os.environ.get("VIBE_CLI_OIDC_ENABLED") or "not set"
    backend = os.environ.get("PYTHON_KEYRING_BACKEND") or "system default"
    return (
        f"No Mistral credential available. Checked - MISTRAL_API_KEY env: {api_key}; "
        f"VIBE_CLI_OIDC_ENABLED: {oidc}; Python keyring backend: {backend} "
        f"(stored Vibe login: not found). "
        f"Run '{login_command()}' --setup to sign in to the Vibe plan, then retry; if the login "
        "exists, the server's keyring backend may not be able to read it."
    )


# OIDC token resolution/refresh performs network I/O; without a bound a hang
# before the completion starts would bypass every other timeout in the bridge.
CREDENTIAL_TIMEOUT_S = 30


async def bounded(awaitable, timeout_s):
    """Await with a bound so a hang surfaces as a real TimeoutError, not a stuck bridge."""
    async with asyncio.timeout(timeout_s):
        return await awaitable


def extract_oidc_token(extra_headers):
    """Remove and return the bearer token the Vibe runtime supplies via OIDC.

    Fails with a real cause when the headers do not carry the expected
    'Authorization: Bearer <token>' entry, instead of a bare KeyError or a
    silently mangled credential.
    """
    value = extra_headers.pop("Authorization", None)
    if not isinstance(value, str) or not value.startswith("Bearer "):
        raise ValueError("OIDC headers from the Vibe runtime are missing the 'Authorization: Bearer <token>' entry")
    return value[len("Bearer ") :]


async def main():
    release = version("mistral-vibe")
    if not release.startswith("3.1."):
        emit(
            {
                "type": "error",
                "message": "This integration requires mistral-vibe 3.1.x. Install it with uv tool install mistral-vibe==3.1.3.",
            }
        )
        return

    from pydantic import TypeAdapter
    from vibe.core.config import (
        DEFAULT_ACTIVE_MODEL_CONFIG,
        build_default_orchestrator,
        load_dotenv_values,
    )
    from vibe.core.config.harness_files import init_harness_files_manager
    from vibe.utils.api_keys import resolve_api_key
    from vibe.utils.oidc_marker import is_oidc_marker
    from vibe.utils.http import with_user_agent

    if "--warm" in sys.argv:
        # Pre-warmed worker: load every heavy module now and wait for the request
        # on stdin. Config, credentials and the catalog are still read per request.
        from mistralai_vibe_local_harness.protocol import RustMessage, RustToolDefinition  # noqa: F401
        from mistralai_vibe_local_harness.vibe import LocalRuntimeAdapterConfig  # noqa: F401
        from mistralai_vibe_local_harness.vibe.adapters.mistral import (  # noqa: F401
            execute_mistral_completion,
        )
        from vibe.core.config.layers.model_catalog import apply_model_catalog  # noqa: F401
        from vibe.core.llm.completion import _compile_reasoning  # noqa: F401
        from vibe.core.llm.reasoning import profile_thinking  # noqa: F401
        from vibe.core.model_catalog import load_cached_model_catalog  # noqa: F401

    line = sys.stdin.readline()
    if not line:
        return  # Parent went away before sending a request.
    request = json.loads(line)
    init_harness_files_manager("user")
    load_dotenv_values()
    # Only user model/connection settings; project tools, hooks and instructions
    # belong to OpenCode. No Vibe session or agent manager is constructed.
    orchestrator = await build_default_orchestrator()
    config = orchestrator.config
    from vibe.core import model_catalog
    from vibe.core.config.layers.model_catalog import apply_model_catalog

    # Building Vibe's config leaves its model-catalog layer empty. Populate it
    # exactly as the CLI does, without persisting an experimental flag in Vibe.
    # The catalog helpers changed within 3.1.x: since 3.1.2 fetching and storing
    # are separate calls and the on-disk cache is keyed by the fetching account
    # and endpoint.
    if hasattr(model_catalog, "fetch_and_cache_model_catalog"):
        # 3.1.0/3.1.1: one call fetches and stores, keyed by the user config.
        catalog = model_catalog.load_cached_model_catalog(config)
        source = "cache" if catalog is not None else "local"
        if request["type"] == "probe" or catalog is None:
            try:
                async with asyncio.timeout(5):
                    latest = await model_catalog.fetch_and_cache_model_catalog(
                        config.model_copy(update={"experimental_enable_model_catalog": True})
                    )
            except TimeoutError:
                latest = None
            if latest is not None:
                catalog = latest
                source = "remote"
    else:
        # 3.1.2+: resolve the credential once, pin it, and key the disk cache
        # the way the CLI does (principal, principal@api_base off-default).
        from vibe.core.config._defaults import DEFAULT_MISTRAL_API_BASE
        from vibe.core.model_catalog import (
            load_cached_model_catalog,
            store_cached_model_catalog,
        )
        from vibe.core.model_catalog.client import fetch_model_catalog
        from vibe.core.platform_auth._mistral import (
            mistral_credentials,
            resolve_principal,
        )

        mistral = mistral_credentials(config, None)
        if mistral is not None:
            api_base = mistral.provider.api_base.rstrip("/")
            credential = mistral.credentials.pinned()
            principal = await oidc_with_diagnosis(bounded(resolve_principal(mistral), CREDENTIAL_TIMEOUT_S), api_base)
            disk_key = (
                None
                if principal is None
                else principal
                if api_base == DEFAULT_MISTRAL_API_BASE
                else f"{principal}@{api_base}"
            )
            record = load_cached_model_catalog(disk_key) if disk_key else None
            catalog = record[0] if record is not None else None
            source = "cache" if catalog is not None else "local"
        else:
            api_base = ""
            credential = None
            disk_key = None
            catalog = None
            source = "local"
        if request["type"] == "probe" or catalog is None:
            latest = None
            try:
                async with asyncio.timeout(5):
                    latest = await fetch_model_catalog(api_base, credential) if credential is not None else None
            except TimeoutError:
                pass
            if latest is not None:
                catalog = latest
                source = "remote"
                if disk_key:
                    store_cached_model_catalog(disk_key, latest)
    if catalog is not None:
        await apply_model_catalog(orchestrator, catalog)
        config = orchestrator.config

    models = {
        alias: model
        for alias, model in config.available_models().items()
        if str(config.get_provider_for_model(model).backend) == "mistral"
    }
    # Keep the built-in route resolvable for existing sessions, but do not offer
    # it twice when the catalog identifies its canonical replacement. A user's
    # changed model settings are a distinct choice, even with the same label.
    legacy = DEFAULT_ACTIVE_MODEL_CONFIG
    shadowed = (
        catalog is not None
        and models.get(legacy.alias) == legacy
        and any(
            entry.id != legacy.alias
            and entry.id in models
            and models[entry.id].provider == legacy.provider
            and (legacy.alias in entry.aliases or legacy.name in entry.aliases)
            for entry in catalog.models
        )
    )
    if request["type"] == "probe":
        emit(
            {
                "type": "catalog",
                "version": release,
                "source": source,
                "models": [
                    {
                        "id": alias,
                        "name": model.display_name or alias,
                        "context": model.max_context_length or 0,
                        "output": model.max_output_tokens or 0,
                        "images": bool(model.supports_images),
                        "efforts": model.thinking_levels or [],
                        "hidden": shadowed and alias == legacy.alias,
                        "authenticated": bool(resolve_api_key(config.get_provider_for_model(model).api_key_env_var)),
                    }
                    for alias, model in models.items()
                ],
            }
        )
        return

    from mistralai_vibe_local_harness.protocol import RustMessage, RustToolDefinition
    from mistralai_vibe_local_harness.vibe import (
        LocalModelRoute,
        LocalRuntimeAdapterConfig,
        ProviderCredentialSnapshot,
    )
    from mistralai_vibe_local_harness.vibe.adapters.mistral import (
        execute_mistral_completion,
    )
    from vibe.core.llm.completion import _compile_reasoning
    from vibe.core.llm.reasoning import profile_thinking

    model = models.get(request["model"])
    if model is None:
        emit(
            {
                "type": "error",
                "message": "Model is no longer available in Vibe. Reconnect Mistral Vibe to refresh the model list.",
            }
        )
        return
    provider = config.get_provider_for_model(model)
    token = resolve_api_key(provider.api_key_env_var)
    extra_headers = {}
    if token and is_oidc_marker(token):
        # OIDC mode: the marker is not a real key; swap in the live ID token
        # plus tenant headers, like the Vibe host does in
        # vibe/app_server/_provider_credentials.py.
        from vibe.setup.auth._oidc_runtime import oidc_headers

        extra_headers = dict(
            await oidc_with_diagnosis(bounded(oidc_headers(provider.api_base), CREDENTIAL_TIMEOUT_S), provider.api_base)
        )
        token = extract_oidc_token(extra_headers)
    if not token:
        emit({"type": "error", "message": no_credential_message()})
        return
    effort = request.get("effort")
    if effort is not None:
        if effort not in (model.thinking_levels or []):
            emit(
                {
                    "type": "error",
                    "message": "The selected reasoning effort is not supported by this Vibe model.",
                }
            )
            return
        model = model.model_copy(update={"thinking": effort})
    adapter = LocalRuntimeAdapterConfig(
        provider=provider.name,
        backend="mistral",
        base_url=provider.api_base,
        max_tokens=request.get("maxTokens"),
        extra_headers=with_user_agent(provider.extra_headers, provider.backend),
        emits_finish_reason=provider.emits_finish_reason,
        timeout_s=config.api_timeout,
        stream_idle_timeout_s=config.api_stream_idle_timeout or None,
        # OpenCode owns retries; replaying a partially emitted stream duplicates it.
        retry_max_elapsed_time_s=0,
        enable_system_trust_store=config.enable_system_trust_store,
    )
    compiled = _compile_reasoning(model, adapter)
    route = LocalModelRoute(
        model=model.name,
        temperature=request.get("temperature", model.temperature),
        top_p=request.get("topP", model.top_p),
        thinking=profile_thinking(compiled),
        reasoning=compiled.profile.format.reasoning,
        max_output_tokens=model.max_output_tokens,
    )

    async def delta(value):
        if value.text:
            emit({"type": "text", "text": value.text})
        if value.reasoning:
            emit({"type": "reasoning", "text": value.reasoning})

    result = await execute_mistral_completion(
        TypeAdapter(list[RustMessage]).validate_python(request["messages"]),
        TypeAdapter(list[RustToolDefinition]).validate_python(request["tools"]),
        adapter,
        ProviderCredentialSnapshot(token=token, headers=extra_headers, revision="vibe"),
        route,
        metadata=completion_metadata(release),
        on_delta=delta,
    )
    emit({"type": "result", **result.model_dump(mode="json", by_alias=True)})


async def network_diagnostic(api_base):
    """Actually try to reach the endpoint so the reported cause is observed, never guessed."""
    import urllib.parse

    parsed = urllib.parse.urlparse(api_base if "://" in api_base else f"https://{api_base}")
    host, port = parsed.hostname, parsed.port or (80 if parsed.scheme == "http" else 443)
    if not host:
        return f"network check skipped: no host in {api_base!r}"
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), 3)
        writer.close()
        return (
            f"network check: {host}:{port} reachable; the failure is inside the Vibe "
            "credential store (stale login or refused refresh), not the network"
        )
    except Exception as error:  # noqa: BLE001 - the probe's own failure IS the diagnostic
        return f"network check to {host}:{port} failed: {type(error).__name__}: {error}"


async def oidc_with_diagnosis(awaitable, api_base):
    """Surface the real cause when the Vibe runtime masks an OIDC failure.

    mistral-vibe's _resolve_id_token catches every exception and re-raises
    OidcError("OIDC credential resolution failed; explicitly re-login") from
    None, destroying the cause chain: offline DNS failures, refused
    connections and hangs all look identical to the user. Probe the endpoint
    ourselves and append what is actually observed. The runtime's message is
    kept verbatim; the cause is never invented.
    """
    try:
        return await awaitable
    except Exception as error:
        diagnostic = await network_diagnostic(api_base)
        try:
            enriched = type(error)(f"{error or type(error).__name__} ({diagnostic})")
        except TypeError:
            enriched = RuntimeError(f"{type(error).__name__}: {error} ({diagnostic})")
        raise enriched from error


def completion_metadata(release):
    """Metadata that routes the completion to the Vibe plan budget.

    Mistral routes the request to the Vibe plan budget (instead of the
    pay-per-token API budget) only when the completion body carries
    call_source "vibe_code", like the Vibe host's own requests do.
    """
    return {
        "agent_entrypoint": "programmatic",
        "agent_version": release,
        "client_name": "opencode-mistral-vibe",
        "client_version": release,
        "call_type": "main_call",
        "call_source": "vibe_code",
        "host_kind": "local",
    }


def crash_dump_path():
    """Best-effort diagnostics file holding the last bridge crash traceback."""
    import pathlib

    return pathlib.Path.home().joinpath(".vibe", "bridge-last-error.txt")


def report_crash(error):
    """Emit the real cause first, then write a REDACTED traceback to disk.

    The emitted event is what the user sees in OpenCode's retry banner, so it
    must go out even when the diagnostics dump fails (unwritable home, disk
    full). The dump is debug material only: it must never leak credentials
    embedded in the traceback (AGENTS.md privacy rule).
    """
    import traceback

    emit(bridge_error_message(error))
    try:
        path = crash_dump_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            redact_secrets(traceback.format_exc()) + "\nstatus_code=" + str(getattr(error, "status_code", None)),
            encoding="utf-8",
        )
    except Exception:  # noqa: BLE001 - diagnostics are best-effort; the real error already reached the user
        pass


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:  # noqa: BLE001 - every failure crosses the process boundary with its real cause
        report_crash(error)
        sys.exit(1)
