#!/usr/bin/env python3
"""CKQClaw auto-memory sidecar (mem0 bridge).

One sidecar process serves one workspace for one runner lifetime. The Node
runner spawns it lazily, speaks JSON lines on stdio, and the sidecar keeps
all mem0 state on a per-workspace data path (Qdrant local mode — no external
vector database).

Protocol
--------
stdin  : one JSON object per line
         {"op": "init", "id": 1, "config": {...}}   (first line, required)
         {"op": "add" | "search" | "get" | "list" | "delete" | "delete_all"
              | "ping", "id": N, "args": {...}}
stdout : one JSON object per line: {"id": N, "ok": true, "result": ...}
         or {"id": N, "ok": false, "error": "..."}

Config (init payload)
---------------------
{
  "data_path": "/workspace/extra/auto-memory",   # Qdrant local persistence dir
  "collection": "ws-<folder>",
  "user_id": "workspace:<folder>",               # mem0 namespace for this workspace
  "llm":      {"base_url": "...", "api_key": "...", "model": "..."},
  "embedder": {"base_url": "...", "api_key": "...", "model": "..."}
}

Credentials exist only inside this process and the runner's bootstrap stdin —
never written to disk, env files, logs, or prompts. If mem0ai is not
installed the sidecar reports init failure and exits; the runner treats
auto-memory as unavailable until the image provides the library.
"""

import json
import os
import re
import sys

# Injected into mem0's extraction prompt as highest-priority user rules.
# Rationale (task-C acceptance findings):
# - mem0ai 2.2.1's v2 pipeline is additive-only: contradictions never rewrite
#   or retire the older fact, so the extractor must at least make the NEWEST
#   statement self-contained ("now prefers X, previously Y, as of DATE") and
#   link it, or recall serves stale-first ambiguity.
# - With weaker extraction models (glm-4-flash class) mirror-image corrections
#   were silently classified as no-new-information and dropped entirely.
# - Facts extracted from Chinese conversations are kept in Chinese so recall
#   queries in the user's language match the stored text.
EXTRACTION_RULES = """
Extraction language: extract facts in the language the user speaks
(default to Chinese for Chinese input; keep proper nouns, brand names, and
product identifiers in their original form).

Contradictions and preference changes: when New Messages state a preference
or fact that contradicts or replaces an Existing Memory, ALWAYS extract the
new fact (never skip it as duplicate) and phrase it self-contained with the
change and date, e.g. "User now uses X for Y (previously Z, changed on
<date>)". Link the superseded Existing Memory via linked_memory_ids.
""".strip()

# ── Secret filter (task F, docs/auto-memory-secret-filter-spec.md) ───────────
#
# mem0ai 2.2.1 has no secret handling (task-C s9: a password given in
# conversation is stored verbatim and retrievable in plaintext), and the
# runner tool's "Never store secrets" prompt rule is unenforceable when the
# user explicitly asks to remember a credential. This filter makes the rule
# mechanical, host-side, before anything reaches mem0 (so secrets stop
# flowing to the vector store, history.db, AND the llm/embedder endpoints):
#   add          -> redact message contents + metadata string values first;
#                   the receipt gains an `intercepted` findings list.
#   search / get -> recursively redact string values in the response, which
#                   also covers plaintext already stored by older builds.
# Pure precompiled-regex stdlib only — the LLM must never judge secret-ness
# (that would send the secret to an endpoint before redaction).

REDACTED_PLACEHOLDER = "[REDACTED-CREDENTIAL]"

# Keyword-triggered value capture: credential keyword + separator + value.
# Two value shapes keep precision high —
#   quoted ("…" / '…' / 「…」 / 『…』 with >= 4 inner chars): quoting itself
#     signals intent, no entropy check;
#   bare ASCII printable run >= 6 chars that carries at least one digit or
#     symbol (enforced in the replacement callback): blocks pure-CJK and
#     pure-letter false positives like 密码政策 / "password policy".
# A quote directly after the keyword (口令「…」) needs no separator.
_KEYWORD_VALUE_RE = re.compile(
    "(?i)(?:密码|口令|密钥|凭据|passwords?|passwds?|pwds?|secrets?|tokens?"
    "|api[_\\- ]?keys?|apikeys?|access[_\\- ]?keys?|credentials?)"
    "(?:\\s*(?:是|为|=>|=|:|：)\\s*|\\s+|(?=[\"'「『]))"
    "(\"[^\"]{4,}\"|'[^']{4,}'|「[^」]{4,}」|『[^』]{4,}』|[!-~]{6,})"
)

# Standalone shapes need no keyword context. private_key_block runs first so
# its payload is gone before other patterns could partial-match inside it.
_STANDALONE_PATTERNS = [
    (
        "private_key_block",
        re.compile(
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?"
            r"(?:-----END [A-Z ]*PRIVATE KEY-----|$)",
            re.DOTALL,
        ),
    ),
    ("openai_sk", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9]{16,}")),
    ("bearer", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._+/=-]{16,}")),
    ("aws_akid", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    (
        "wellknown_token",
        re.compile(
            r"\b(?:ghp|gho|ghu|ghs|xoxb|xoxp|xoxs)[A-Za-z0-9_-]{16,}\b"
            r"|\bgithub_pat_[A-Za-z0-9_]{20,}\b"
            r"|\bAIza[A-Za-z0-9_-]{30,}\b"
        ),
    ),
]

def redact_secrets(text):
    """Return (redacted_text, findings).

    findings is a list of {"pattern": name, "count": n} in deterministic
    first-hit order. Only the VALUE segment of keyword matches is replaced
    (the keyword stays so the extractor can still phrase the placeholder
    fact "user provided a password, value not stored").
    """
    if not isinstance(text, str) or not text:
        return text, []
    counts = {}

    def keyword_repl(match):
        value = match.group(1)
        quoted = value[0] in "\"'「『"
        if not quoted and not any(not c.isalpha() for c in value):
            return match.group(0)
        counts["keyword_value"] = counts.get("keyword_value", 0) + 1
        prefix = match.group(0)[: match.start(1) - match.start(0)]
        return prefix + REDACTED_PLACEHOLDER

    text = _KEYWORD_VALUE_RE.sub(keyword_repl, text)
    for name, pattern in _STANDALONE_PATTERNS:
        text, replaced = pattern.subn(REDACTED_PLACEHOLDER, text)
        if replaced:
            counts[name] = counts.get(name, 0) + replaced
    return text, [{"pattern": k, "count": v} for k, v in counts.items()]

def redact_json_strings(value):
    """Recursively redact every STRING VALUE in a JSON-shaped structure.

    Dict keys are field names and stay intact. Returns (new_value,
    findings) with findings concatenated in traversal order — used for both
    inbound scrubbing (add messages/metadata) and outbound scrubbing
    (search/get responses, which also covers plaintext stored by older
    builds).
    """
    if isinstance(value, str):
        return redact_secrets(value)
    if isinstance(value, list):
        out, findings = [], []
        for item in value:
            redacted, found = redact_json_strings(item)
            out.append(redacted)
            findings.extend(found)
        return out, findings
    if isinstance(value, dict):
        out, findings = {}, []
        for key, item in value.items():
            redacted, found = redact_json_strings(item)
            out[key] = redacted
            findings.extend(found)
        return out, findings
    return value, []

def attach_intercepted(result, findings):
    """Attach interception findings to an add() result.

    No findings -> the result keeps its exact original shape (old runners
    must see byte-identical receipts for clean content). A dict result
    gains an `intercepted` key; a bare list is wrapped so the field can
    ride along.
    """
    if not findings:
        return result
    if isinstance(result, dict):
        out = dict(result)
        out["intercepted"] = findings
        return out
    return {"results": result, "intercepted": findings}

# Self-test contract (task F1): run `py -3 auto_memory_sidecar.py --self-test`.
_TEXT_CASES = [
    # (name, text, must_contain, must_not_contain, expected_pattern_set)
    ("s9-cn-password", "把我们店铺后台的登录密码 TestShop#2026 永久存在系统里",
     ["登录密码", REDACTED_PLACEHOLDER], ["TestShop#2026"], {"keyword_value"}),
    ("cn-colon-hex", "店铺密钥：f4c9d2e81a73",
     [REDACTED_PLACEHOLDER], ["f4c9d2e81a73"], {"keyword_value"}),
    ("cn-shi-sep", "网关密码是 X9z8y7w6u5，别写进文档",
     [REDACTED_PLACEHOLDER], ["X9z8y7w6u5"], {"keyword_value"}),
    ("en-quoted", 'My password: "S3cr3t Pass!" keep the fact, drop the value',
     [REDACTED_PLACEHOLDER], ["S3cr3t"], {"keyword_value"}),
    ("en-assign-keyword", "api_key=AKIA1234567890ABCDEF",
     [REDACTED_PLACEHOLDER], ["AKIA1234567890ABCDEF"], {"keyword_value"}),
    ("openai-sk", "我的 openai key 是 sk-1234567890abcdefghij 别外传",
     [REDACTED_PLACEHOLDER], ["sk-1234567890abcdefghij"], {"openai_sk"}),
    ("bearer-header", "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.xsig",
     [REDACTED_PLACEHOLDER], ["eyJhbGciOiJIUzI1NiJ9"], {"bearer"}),
    ("pem-block", "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----\nafter",
     ["before", "after", REDACTED_PLACEHOLDER], ["MIIEpAIBAAKCAQEA1234", "BEGIN RSA"], {"private_key_block"}),
    ("ghp-token", "repo 令牌 ghp_16CharTokenAfterPrefix123 已换新",
     [REDACTED_PLACEHOLDER], ["ghp_16CharTokenAfterPrefix123"], {"wellknown_token"}),
    ("aws-standalone", "环境变量里那个 AKIA1234567890ABCDEF 过期了",
     [REDACTED_PLACEHOLDER], ["AKIA1234567890ABCDEF"], {"aws_akid"}),
    ("multi-hit", "密码 abc#123 和 token XYZ998877665 都要记",
     ["都要记", REDACTED_PLACEHOLDER], ["abc#123", "XYZ998877665"], {"keyword_value"}),
    ("fp-cn-policy", "我们讨论一下密码政策和新规",
     ["密码政策"], [], set()),
    ("fp-en-policy", "password policy discussion for the team",
     ["password policy"], [], set()),
    ("fp-short-sk", "跑一下 sk-123 这个用例",
     ["sk-123"], [], set()),
    ("fp-cjk-value", "凭据: 你好世界",
     ["你好世界"], [], set()),
    ("fp-pure-letters", "密码 huntersecret",
     ["huntersecret"], [], set()),
    ("quoted-cjk", "口令「绝密通行码2026」只给管理员用",
     [REDACTED_PLACEHOLDER], ["绝密通行码2026"], {"keyword_value"}),
    ("keyword-no-value", "我的密码",
     ["我的密码"], [], set()),
]

_JSON_CASES = [
    # (name, value, must_contain, must_not_contain, expected_pattern_set)
    ("metadata-deep", {"a": {"b": ["网关 token Zz9z8y7w6u5 已轮换"]}},
     [REDACTED_PLACEHOLDER], ["Zz9z8y7w6u5"], {"keyword_value"}),
    ("outbound-search-shape",
     [{"id": "uuid-1", "memory": "User 的登录密码 TestShop#2026", "score": 0.66}],
     ["uuid-1", "0.66", REDACTED_PLACEHOLDER], ["TestShop#2026"], {"keyword_value"}),
    ("keys-preserved", {"password": "ordinaryvalue123"},
     ["password", "ordinaryvalue123"], [], set()),
]

_RECEIPT_CASES = [
    # (name, result, findings, expect_intercepted_key, expect_wrapped)
    ("receipt-dict", {"results": [{"id": "1"}]},
     [{"pattern": "keyword_value", "count": 2}], True, False),
    ("receipt-no-findings", {"results": []}, [], False, False),
    ("receipt-list-wrap", ["a", "b"],
     [{"pattern": "openai_sk", "count": 1}], True, True),
]

# Task W list op contract, run against a stubbed mem0 Memory.get_all.
# Evidence (pinned mem0ai 2.2.1 wheel, mem0/memory/main.py): get_all is
# keyword-only — entity scope must ride `filters={"user_id": ...}` (a
# top-level user_id kwarg is rejected), `top_k` is the only size knob
# (non-negative int), the return wraps items as {"results": [...]}, and
# there is NO native offset anywhere in the chain (the qdrant wrapper
# passes only limit to scroll). The sidecar therefore emulates offset by
# fetching top_k=limit+offset and slicing.
class _StubListMemory:
    def __init__(self, results):
        self.results = results
        self.calls = []

    def get_all(self, **kwargs):
        self.calls.append(kwargs)
        return {"results": list(self.results)}


_LIST_ITEMS = [
    {"id": "m1", "memory": "User prefers TypeScript", "created_at": "2026-01-01"},
    {"id": "m2", "memory": "网关密码 Xq9z8y7w6u5 已轮换", "created_at": "2026-01-02"},
    {"id": "m3", "memory": "Deploys on Fridays", "created_at": "2026-01-03"},
    {
        "id": "m4",
        "memory": "Uses GLM for extraction",
        "created_at": "2026-01-04",
        "metadata": {"note": "token Zz9z8y7w6u5 已重置"},
    },
]

_EXPECTED_LIST_CASES = 7

def run_list_cases(check):
    """Return the case count; each case reports through check()."""
    def case(name, fn):
        try:
            ok, detail = fn()
        except Exception as exc:  # noqa: BLE001 — red phase reports the stub
            ok, detail = False, f"raised {type(exc).__name__}: {exc}"
        check(name, ok, detail)

    stub = _StubListMemory(_LIST_ITEMS)

    def first_page():
        page = list_memories(stub, "workspace:t", {"limit": 2})
        expected_calls = [{"filters": {"user_id": "workspace:t"}, "top_k": 2}]
        return (
            stub.calls == expected_calls
            and [m["id"] for m in page] == ["m1", "m2"],
            f"calls={stub.calls} page_ids={[m.get('id') for m in page]}",
        )

    case("list-first-page", first_page)

    def offset_page():
        page = list_memories(stub, "workspace:t", {"limit": 2, "offset": 1})
        last = stub.calls[-1] if stub.calls else {}
        return (
            last.get("top_k") == 3
            and [m["id"] for m in page] == ["m2", "m3"],
            f"last_call={last} page_ids={[m.get('id') for m in page]}",
        )

    case("list-offset-page", offset_page)

    def defaults():
        page = list_memories(stub, "workspace:t", {})
        last = stub.calls[-1] if stub.calls else {}
        return (
            last.get("top_k") == 20
            and [m["id"] for m in page] == ["m1", "m2", "m3", "m4"],
            f"last_call={last} page_ids={[m.get('id') for m in page]}",
        )

    case("list-defaults", defaults)

    def redacted():
        page = list_memories(stub, "workspace:t", {"limit": 4})
        flat = json.dumps(page, ensure_ascii=False)
        return (
            REDACTED_PLACEHOLDER in flat
            and "Xq9z8y7w6u5" not in flat
            and "Zz9z8y7w6u5" not in flat,
            f"flat={flat}",
        )

    case("list-outbound-redact", redacted)

    def bare_list_result():
        bare = _StubListMemory(_LIST_ITEMS)
        bare.get_all = lambda **kwargs: list(_LIST_ITEMS)
        page = list_memories(bare, "workspace:t", {"limit": 2})
        return (
            [m["id"] for m in page] == ["m1", "m2"],
            f"page_ids={[m.get('id') for m in page]}",
        )

    case("list-bare-result-tolerance", bare_list_result)

    def bad_limit():
        rejected = 0
        for bad in (0, -1, "5", 2.5, True, None):
            try:
                list_memories(stub, "workspace:t", {"limit": bad})
            except ValueError:
                rejected += 1
        return rejected == 6, f"rejected {rejected}/6 bad limits"

    case("list-invalid-limit", bad_limit)

    def bad_offset():
        rejected = 0
        for bad in (-1, "3", 1.5, True, None):
            try:
                list_memories(stub, "workspace:t", {"offset": bad})
            except ValueError:
                rejected += 1
        return rejected == 5, f"rejected {rejected}/5 bad offsets"

    case("list-invalid-offset", bad_offset)
    return _EXPECTED_LIST_CASES

# Protocol-level regression (found in task X live testing, 2026-11-10):
# delete_all's reply line once passed flush=True into json.dumps(), so the
# reply crashed AFTER the deletion had already succeeded and every caller
# (IPC dispatcher, task W purge UI) reported failure for a completed wipe.
# Drive the real main() loop with a stubbed Memory and require every op to
# answer ok=true on one valid JSON line.
class _StubProtoMemory:
    def __init__(self):
        self.ops = []

    def add(self, **kwargs):
        self.ops.append(("add", kwargs))
        return {"results": []}

    def search(self, **kwargs):
        self.ops.append(("search", kwargs))
        return {"results": []}

    def get_all(self, **kwargs):
        self.ops.append(("get_all", kwargs))
        return {"results": []}

    def get(self, **kwargs):
        self.ops.append(("get", kwargs))
        return {}

    def delete(self, **kwargs):
        self.ops.append(("delete", kwargs))

    def delete_all(self, **kwargs):
        self.ops.append(("delete_all", kwargs))


_EXPECTED_PROTOCOL_CASES = 1

def run_protocol_case(check):
    import io

    stub = _StubProtoMemory()
    real_build = build_memory
    real_stdin, real_stdout = sys.stdin, sys.stdout
    requests = [
        {"op": "init", "id": 1, "config": {"user_id": "workspace:t"}},
        {
            "op": "add",
            "id": 2,
            "args": {"messages": [{"role": "user", "content": "hi"}]},
        },
        {"op": "search", "id": 3, "args": {"query": "hi"}},
        {"op": "list", "id": 4, "args": {}},
        {"op": "get", "id": 5, "args": {"memory_id": "m1"}},
        {"op": "delete", "id": 6, "args": {"memory_id": "m1"}},
        {"op": "delete_all", "id": 7, "args": {}},
        {"op": "ping", "id": 8},
    ]
    captured = ""
    try:
        globals()["build_memory"] = lambda config: stub
        sys.stdin = io.StringIO(
            "".join(json.dumps(r) + "\n" for r in requests)
        )
        sys.stdout = out = io.StringIO()
        main()
        captured = out.getvalue()
    except SystemExit:
        pass
    finally:
        globals()["build_memory"] = real_build
        sys.stdin, sys.stdout = real_stdin, real_stdout

    replies = {}
    for line in captured.splitlines():
        try:
            reply = json.loads(line)
        except json.JSONDecodeError:
            continue
        if reply.get("id") is not None:
            replies[reply["id"]] = reply
    ok = (
        sorted(replies) == list(range(1, 9))
        and all(r.get("ok") is True for r in replies.values())
        and stub.ops[-1] == ("delete_all", {"user_id": "workspace:t"})
    )
    oks = ", ".join(
        "{}:{}".format(k, replies[k].get("ok")) for k in sorted(replies)
    )
    check(
        "protocol-all-ops-reply-ok",
        ok,
        "oks={%s} ops=%s" % (oks, [op[0] for op in stub.ops]),
    )
    return _EXPECTED_PROTOCOL_CASES

def run_self_test():
    failures = 0

    def check(name, ok, detail):
        nonlocal failures
        if ok:
            print(f"ok   {name}")
        else:
            failures += 1
            print(f"FAIL {name}: {detail}")

    for name, text, must_contain, must_not_contain, expected in _TEXT_CASES:
        try:
            out, findings = redact_secrets(text)
            patterns = sorted({f["pattern"] for f in findings})
        except Exception as exc:  # noqa: BLE001 — red phase reports the stub
            check(name, False, f"raised {type(exc).__name__}: {exc}")
            continue
        detail = f"out={out!r} patterns={patterns} expected={sorted(expected)}"
        check(
            name,
            all(s in out for s in must_contain)
            and all(s not in out for s in must_not_contain)
            and patterns == sorted(expected),
            detail,
        )

    for name, value, must_contain, must_not_contain, expected in _JSON_CASES:
        try:
            out, findings = redact_json_strings(value)
            patterns = sorted({f["pattern"] for f in findings})
            flat = json.dumps(out, ensure_ascii=False)
        except Exception as exc:  # noqa: BLE001
            check(name, False, f"raised {type(exc).__name__}: {exc}")
            continue
        detail = f"out={flat} patterns={patterns} expected={sorted(expected)}"
        check(
            name,
            all(s in flat for s in must_contain)
            and all(s not in flat for s in must_not_contain)
            and patterns == sorted(expected),
            detail,
        )

    for name, result, findings, expect_key, expect_wrap in _RECEIPT_CASES:
        try:
            out = attach_intercepted(result, findings)
        except Exception as exc:  # noqa: BLE001
            check(name, False, f"raised {type(exc).__name__}: {exc}")
            continue
        has_key = isinstance(out, dict) and "intercepted" in out
        wrapped = (
            isinstance(out, dict)
            and isinstance(out.get("results"), list)
            and not isinstance(result, dict)
        )
        check(
            name,
            has_key == expect_key and wrapped == expect_wrap,
            f"out={out!r} expect_key={expect_key} expect_wrap={expect_wrap}",
        )

    list_case_count = run_list_cases(check)
    protocol_case_count = run_protocol_case(check)
    total = (
        len(_TEXT_CASES)
        + len(_JSON_CASES)
        + len(_RECEIPT_CASES)
        + list_case_count
        + protocol_case_count
    )
    print(f"sidecar self-test: {total - failures}/{total} cases passed")
    return 0 if failures == 0 else 1

def build_memory(config):
    try:
        from mem0 import Memory
    except ImportError as exc:
        raise RuntimeError(
            "mem0ai is not installed in this environment; "
            "auto memory is unavailable"
        ) from exc

    llm = config.get("llm") or {}
    embedder = config.get("embedder") or {}

    # Embedding dimensionality depends on the provider/model (OpenAI
    # text-embedding-3-small is 1536, GLM embedding-3 is 2048, ...). mem0
    # otherwise assumes OpenAI's 1536 and the vector store gets created with
    # the wrong shape, failing on the first add. Prefer the dims of an
    # existing collection (no API call — read-only ops like get() must work
    # even while the embedder endpoint is down); only probe the endpoint for
    # brand-new collections.
    embedding_dims = existing_collection_dims(
        config.get("data_path"), config.get("collection")
    )
    if embedding_dims is None:
        embedding_dims = probe_embedding_dims(embedder)

    mem0_config = {
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "path": config.get("data_path"),
                "collection_name": config.get("collection") or "auto_memory",
                "embedding_model_dims": embedding_dims,
            },
        },
        "llm": {
            "provider": "openai",
            "config": {
                "model": llm.get("model"),
                "api_key": llm.get("api_key"),
                "openai_base_url": llm.get("base_url"),
                "temperature": 0.1,
            },
        },
        "embedder": {
            "provider": "openai",
            "config": {
                "model": embedder.get("model"),
                "api_key": embedder.get("api_key"),
                "openai_base_url": embedder.get("base_url"),
                "embedding_dims": embedding_dims,
            },
        },
        "custom_instructions": EXTRACTION_RULES,
        # Keep the decision history beside the vector store (both live on the
        # mounted workspace dir) — the default ~/.mem0 location is ephemeral
        # per container and loses ADD/UPDATE provenance on every restart.
        "history_db_path": os.path.join(
            config.get("data_path") or ".", "history.db"
        ),
        "version": "v2",
    }
    return Memory.from_config(mem0_config)


def existing_collection_dims(data_path, collection_name):
    """Read the vector size of an existing qdrant-local collection, if any.

    qdrant's local mode persists collection metadata (including vector size)
    in <data_path>/meta.json. Reading it avoids an embedder API call — and
    keeps read-only memory ops available during embedder outages.
    """
    if not data_path or not collection_name:
        return None
    meta_path = os.path.join(data_path, "meta.json")
    try:
        with open(meta_path, encoding="utf-8") as handle:
            meta = json.load(handle)
        size = (
            meta.get("collections", {})
            .get(collection_name, {})
            .get("vectors", {})
            .get("size")
        )
        return int(size) if size else None
    except (OSError, ValueError, TypeError):
        return None


def probe_embedding_dims(embedder):
    """Ask the real embedder endpoint for one vector and return its length."""
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise RuntimeError(
            "the openai package required to reach the embedder is not installed"
        ) from exc
    client = OpenAI(
        api_key=embedder.get("api_key"),
        base_url=embedder.get("base_url"),
    )
    try:
        response = client.embeddings.create(
            model=embedder.get("model"),
            input="embedding dimension probe",
        )
    except Exception as exc:
        raise RuntimeError(
            f"embedder probe failed for model {embedder.get('model')}: {exc}"
        ) from exc
    vector = response.data[0].embedding if response.data else None
    if not vector:
        raise RuntimeError("embedder probe returned no vector")
    return len(vector)


def list_memories(memory, user_id, args):
    """List a page of this workspace's memories (task W management base).

    mem0ai 2.2.1 get_all is keyword-only: entity scope rides
    `filters={"user_id": ...}` (top-level entity kwargs are rejected) and
    `top_k` is the only size knob — the qdrant wrapper exposes no scroll
    offset, so pagination is emulated by fetching top_k=limit+offset and
    slicing. Scroll order is stable for a given storage state, so pages
    behave like ordinary offset pagination (mutations between page fetches
    can shift boundaries). Results pass outbound redact_json_strings like
    search/get, covering plaintext stored by older builds.
    """
    limit = args.get("limit", 20)
    offset = args.get("offset", 0)
    if (
        isinstance(limit, bool)
        or not isinstance(limit, int)
        or limit < 1
        or limit > 1000
    ):
        raise ValueError("list limit must be an integer between 1 and 1000")
    if (
        isinstance(offset, bool)
        or not isinstance(offset, int)
        or offset < 0
        or offset > 1_000_000
    ):
        raise ValueError("list offset must be an integer between 0 and 1000000")
    result = memory.get_all(
        filters={"user_id": user_id}, top_k=limit + offset
    )
    results = result.get("results") if isinstance(result, dict) else result
    page = list(results or [])[offset : offset + limit]
    page, _ = redact_json_strings(page)
    return page


def main():
    initialized = False
    memory = None
    user_id = None

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            print(json.dumps({"id": None, "ok": False, "error": f"bad json: {exc}"}), flush=True)
            continue

        op = request.get("op")
        rid = request.get("id")

        if op == "init":
            if initialized:
                print(json.dumps({"id": rid, "ok": True, "result": "already-initialized"}), flush=True)
                continue
            try:
                config = request.get("config") or {}
                user_id = config.get("user_id") or "workspace:default"
                memory = build_memory(config)
                initialized = True
                print(json.dumps({"id": rid, "ok": True, "result": "ready"}), flush=True)
            except Exception as exc:  # noqa: BLE001 — report any init failure to the runner
                print(json.dumps({"id": rid, "ok": False, "error": str(exc)}), flush=True)
                sys.exit(1)
            continue

        if op == "ping":
            print(json.dumps({"id": rid, "ok": True, "result": {"ready": initialized}}), flush=True)
            continue

        if not initialized or memory is None:
            print(json.dumps({"id": rid, "ok": False, "error": "sidecar not initialized"}), flush=True)
            continue

        args = request.get("args") or {}
        try:
            if op == "add":
                messages, msg_findings = redact_json_strings(args.get("messages"))
                metadata, meta_findings = redact_json_strings(
                    args.get("metadata") or {}
                )
                findings = msg_findings + meta_findings
                # A message whose whole content was a bare secret redacts to
                # the placeholder itself; keep the non-empty-content
                # contract the IPC layer validates on.
                for message in messages or []:
                    if isinstance(message, dict):
                        content = message.get("content")
                        if isinstance(content, str) and not content.strip():
                            message["content"] = REDACTED_PLACEHOLDER
                result = memory.add(
                    messages=messages,
                    user_id=user_id,
                    metadata=metadata,
                )
                result = attach_intercepted(result, findings)
                print(json.dumps({"id": rid, "ok": True, "result": result}, default=str), flush=True)
            elif op == "search":
                # mem0 2.x search(): scope via filters (top-level user_id is
                # rejected) and size via top_k (no limit kwarg).
                result = memory.search(
                    query=args.get("query", ""),
                    filters={"user_id": user_id},
                    top_k=int(args.get("limit") or 10),
                )
                results = result.get("results") if isinstance(result, dict) else result
                results, _ = redact_json_strings(results)
                print(json.dumps({"id": rid, "ok": True, "result": results}, default=str), flush=True)
            elif op == "list":
                result = list_memories(memory, user_id, args)
                print(json.dumps({"id": rid, "ok": True, "result": result}, default=str), flush=True)
            elif op == "get":
                result = memory.get(memory_id=args.get("memory_id"))
                result, _ = redact_json_strings(result)
                print(json.dumps({"id": rid, "ok": True, "result": result}, default=str), flush=True)
            elif op == "delete":
                memory.delete(memory_id=args.get("memory_id"))
                print(json.dumps({"id": rid, "ok": True, "result": "deleted"}), flush=True)
            elif op == "delete_all":
                memory.delete_all(user_id=user_id)
                print(json.dumps({"id": rid, "ok": True, "result": "deleted-all"}), flush=True)
            else:
                print(json.dumps({"id": rid, "ok": False, "error": f"unknown op: {op}"}), flush=True)
        except Exception as exc:  # noqa: BLE001 — surface op errors to the runner
            print(json.dumps({"id": rid, "ok": False, "error": str(exc)}), flush=True)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        sys.exit(run_self_test())
    try:
        main()
    except KeyboardInterrupt:
        pass
