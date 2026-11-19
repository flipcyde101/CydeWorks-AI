"""Inert unit tests for the disconnected fixed-synthetic protected fixture verifier."""

import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from types import MappingProxyType
from unittest import mock


PILOT_DIR = Path(__file__).resolve().parent
VERIFIER_PATH = PILOT_DIR / "protected-fixture-verifier.py"


def _load_verifier():
    spec = importlib.util.spec_from_file_location("protected_fixture_verifier", VERIFIER_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


verifier = _load_verifier()

BASELINE_FILES = {
    "limits.py": (PILOT_DIR / "fixtures" / "limits.py").read_bytes(),
    "measurement.py": (PILOT_DIR / "fixtures" / "measurement.py").read_bytes(),
}

ORDINARY_CORRECTED_FILES = {
    "limits.py": (
        b"def clamp(value):\n"
        b"    if value < 0:\n"
        b"        return 0\n"
        b"    if value > 100:\n"
        b"        return 100\n"
        b"    return value\n"
    ),
    "measurement.py": (
        b"from limits import clamp\n\n\n"
        b"def normalize(raw):\n"
        b"    try:\n"
        b"        return clamp(int(raw))\n"
        b"    except (TypeError, ValueError):\n"
        b"        return 0\n"
    ),
}

CLAIM_ID = "claim-20261118-001"
BASE_REVISION = "a" * 40
TEST_HMAC_KEY = b"controller-test-hmac-key-32bytes"
TEST_NONCE = "nonce-20261118-0001"


def _make_claim(base_revision: str = BASE_REVISION, base_snapshot=None, claim_id: str = CLAIM_ID):
    snap = base_snapshot or verifier.freeze_file_snapshot(BASELINE_FILES, label="base")
    scope, scope_hash = verifier.build_scope(base_revision, snap)
    return {"claimId": claim_id, "scope": scope, "scopeHash": scope_hash}


def _make_cli_envelope(
    cand_files: dict[str, bytes],
    *,
    base_files: dict[str, bytes] = BASELINE_FILES,
    claim: dict[str, object] | None = None,
    nonce: str = TEST_NONCE,
) -> bytes:
    base_snap = verifier.freeze_file_snapshot(base_files, label="base")
    bound_claim = claim if claim is not None else _make_claim(BASE_REVISION, base_snap)
    payload = {
        "candidateFilesBase64": {
            k: base64.b64encode(v).decode("ascii") for k, v in cand_files.items()
        },
        "baseFilesBase64": {
            k: base64.b64encode(v).decode("ascii") for k, v in base_files.items()
        },
        "claim": bound_claim,
        "invocationNonce": nonce,
    }
    return json.dumps(payload).encode("utf-8")


class ProtectedFixtureVerifierTests(unittest.TestCase):
    def setUp(self) -> None:
        self.base_snap = verifier.freeze_file_snapshot(BASELINE_FILES, label="base")
        self.cand_snap = verifier.freeze_file_snapshot(ORDINARY_CORRECTED_FILES, label="candidate")
        self.claim = _make_claim(BASE_REVISION, self.base_snap, CLAIM_ID)

    def test_scope_label_and_pilot_cases_alignment(self):
        self.assertEqual(verifier.VERIFIER_SCOPE, "fixed-synthetic-only")
        self.assertEqual(verifier.VERIFIER_VERSION, "protected-fixture-verifier-ast-v2")
        self.assertEqual(verifier.APPROVED_FILES, ("limits.py", "measurement.py"))
        self.assertEqual(len(verifier.CASES), 12)
        expected_cases = [
            ["clamp", -8, 0],
            ["clamp", 0, 0],
            ["clamp", 56, 56],
            ["clamp", 100, 100],
            ["clamp", 164, 100],
            ["normalize", "-12", 0],
            ["normalize", " 42 ", 42],
            ["normalize", "150", 100],
            ["normalize", 75, 75],
            ["normalize", "bad", 0],
            ["normalize", None, 0],
            ["normalize", "", 0],
        ]
        expected_digest = hashlib.sha256(
            json.dumps(expected_cases, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        ).hexdigest()
        self.assertEqual(verifier.CASES_DIGEST, expected_digest)

    def test_build_scope_and_journal_claim_loading(self):
        scope, scope_hash = verifier.build_scope(BASE_REVISION, self.base_snap)
        self.assertEqual(
            list(scope.keys()),
            ["files", "baseRevision", "baseFileDigests", "casesDigest", "totalCases"],
        )
        self.assertEqual(
            scope_hash,
            hashlib.sha256(
                json.dumps(scope, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            ).hexdigest(),
        )

        with tempfile.TemporaryDirectory(prefix="pfv-journal-") as tmp:
            jpath = Path(tmp) / "run.jsonl"
            row0 = {"id": CLAIM_ID, "state": "claimed", "scope": scope, "scopeHash": scope_hash}
            jpath.write_bytes((json.dumps(row0) + "\n").encode("utf-8"))
            loaded = verifier.load_controller_claim_from_journal(
                jpath, CLAIM_ID, base_snapshot=self.base_snap
            )
            self.assertEqual(loaded, self.claim)

            # Truncated (no trailing newline) or wrong claimId fails closed.
            jpath.write_bytes(json.dumps(row0).encode("utf-8"))
            with self.assertRaises(verifier.InvalidInputError):
                verifier.load_controller_claim_from_journal(
                    jpath, CLAIM_ID, base_snapshot=self.base_snap
                )

    def test_ordinary_corrected_fixture_passes_and_binds_provenance(self):
        att = verifier.verify_fixture_snapshot(
            self.cand_snap,
            base_snapshot=self.base_snap,
            claim=self.claim,
            invocation_nonce=TEST_NONCE,
            attestation_key=TEST_HMAC_KEY,
            require_all_files_changed=True,
        )
        self.assertEqual(att["scope"], "fixed-synthetic-only")
        self.assertTrue(att["entryPointDisconnected"])
        self.assertTrue(att["trusted"])
        self.assertTrue(att["passed"])
        self.assertEqual(att["claimId"], CLAIM_ID)
        self.assertEqual(att["scopeHash"], self.claim["scopeHash"])
        self.assertEqual(att["claimScope"], self.claim["scope"])
        self.assertEqual(att["baseRevision"], BASE_REVISION)
        self.assertEqual(att["casesDigest"], verifier.CASES_DIGEST)
        self.assertEqual(att["totalCases"], 12)
        self.assertEqual(att["passedCases"], 12)
        self.assertEqual(att["failures"], [])
        self.assertEqual(att["unchangedFiles"], [])
        self.assertEqual(
            att["results"],
            [{"value": exp} for _fn, _inp, exp in verifier.CASES],
        )

        expected_limits_sha = hashlib.sha256(ORDINARY_CORRECTED_FILES["limits.py"]).hexdigest()
        expected_meas_sha = hashlib.sha256(ORDINARY_CORRECTED_FILES["measurement.py"]).hexdigest()
        self.assertEqual(
            att["fileDigests"],
            {"limits.py": expected_limits_sha, "measurement.py": expected_meas_sha},
        )
        expected_tree_sha = hashlib.sha256(
            json.dumps(
                [["limits.py", expected_limits_sha], ["measurement.py", expected_meas_sha]],
                separators=(",", ":"),
                ensure_ascii=False,
            ).encode("utf-8")
        ).hexdigest()
        self.assertEqual(att["treeSha256"], expected_tree_sha)
        self.assertEqual(att["provenance"]["claimBound"], True)
        self.assertEqual(att["provenance"]["invocationNonce"], TEST_NONCE)
        verifier.verify_attestation(
            att,
            expected_claim=self.claim,
            expected_invocation_nonce=TEST_NONCE,
            attestation_key=TEST_HMAC_KEY,
            require_all_files_changed=True,
        )

    def test_alternative_valid_syntax_with_pure_helpers_and_none_check_passes(self):
        alt_files = {
            "limits.py": (
                b'"""Fixed synthetic clamp helper."""\n'
                b"def clamp(value):\n"
                b'    """Clamp value into [0, 100]."""\n'
                b"    lo = 0\n"
                b"    hi = 100 + lo\n"
                b"    if 0 <= value <= 100:\n"
                b"        return abs(value) // 1\n"
                b"    return max(lo, min(hi, +value))\n"
            ),
            "measurement.py": (
                b"from limits import clamp\n\n"
                b"def normalize(raw):\n"
                b"    if raw is None or isinstance(raw, bool):\n"
                b"        return 0\n"
                b"    try:\n"
                b"        parsed = int(raw)\n"
                b"    except TypeError:\n"
                b"        return 0\n"
                b"    except ValueError:\n"
                b"        return 0\n"
                b"    return 0 if parsed < 0 else (100 if parsed > 100 else clamp(parsed))\n"
            ),
        }
        alt_snap = verifier.freeze_file_snapshot(alt_files, label="alt")
        att = verifier.verify_fixture_snapshot(
            alt_snap,
            base_snapshot=self.base_snap,
            claim=self.claim,
            invocation_nonce=TEST_NONCE,
            attestation_key=TEST_HMAC_KEY,
        )
        self.assertTrue(att["trusted"])
        self.assertTrue(att["passed"])
        self.assertEqual(att["passedCases"], 12)
        self.assertEqual(att["failures"], [])

    def test_baseline_fixture_fails_expected_cases(self):
        att = verifier.verify_fixture_snapshot(
            self.base_snap,
            base_snapshot=self.base_snap,
            claim=self.claim,
            invocation_nonce=TEST_NONCE,
            attestation_key=TEST_HMAC_KEY,
            require_all_files_changed=False,
        )
        self.assertTrue(att["trusted"])
        self.assertFalse(att["passed"])
        self.assertEqual(att["totalCases"], 12)
        self.assertEqual(att["passedCases"], 5)
        self.assertEqual(att["failures"], [1, 5, 6, 8, 10, 11, 12])
        self.assertEqual(att["unchangedFiles"], ["limits.py", "measurement.py"])
        verifier.verify_attestation(
            att,
            expected_claim=self.claim,
            expected_invocation_nonce=TEST_NONCE,
            attestation_key=TEST_HMAC_KEY,
            require_all_files_changed=False,
        )
        with self.assertRaises(verifier.InvalidInputError):
            # Tampered passed=True on failed baseline must fail verification.
            verifier.verify_attestation(
                {**att, "passed": True},
                expected_claim=self.claim,
                expected_invocation_nonce=TEST_NONCE,
                attestation_key=TEST_HMAC_KEY,
                require_all_files_changed=False,
            )

    def test_require_all_files_changed_rejects_partial_change(self):
        partial = verifier.freeze_file_snapshot(
            {
                "limits.py": ORDINARY_CORRECTED_FILES["limits.py"],
                "measurement.py": BASELINE_FILES["measurement.py"],
            },
            label="partial",
        )
        att = verifier.verify_fixture_snapshot(
            partial,
            base_snapshot=self.base_snap,
            claim=self.claim,
            invocation_nonce=TEST_NONCE,
            attestation_key=TEST_HMAC_KEY,
            require_all_files_changed=True,
        )
        self.assertFalse(att["passed"])
        self.assertEqual(att["unchangedFiles"], ["measurement.py"])

    def test_bool_return_is_rejected_even_when_equal_to_zero_or_one(self):
        bool_snap = verifier.freeze_file_snapshot(
            {
                "limits.py": b"def clamp(value):\n    return False\n",
                "measurement.py": ORDINARY_CORRECTED_FILES["measurement.py"],
            },
            label="bool",
        )
        att = verifier.verify_fixture_snapshot(
            bool_snap,
            base_snapshot=self.base_snap,
            claim=self.claim,
            invocation_nonce=TEST_NONCE,
            attestation_key=TEST_HMAC_KEY,
        )
        self.assertFalse(att["passed"])
        self.assertIn(1, att["failures"])
        self.assertEqual(att["caseResults"][0]["error"], "invalid_return_type:bool")

    def test_candidate_never_evals_compiles_or_executes_python(self):
        real_compile = compile
        compile_calls = []

        def guarded_compile(source, filename, mode, flags=0, *args, **kwargs):
            if not (flags & verifier.ast.PyCF_ONLY_AST):
                raise AssertionError("bytecode compile called")
            compile_calls.append((filename, mode, flags))
            return real_compile(source, filename, mode, flags, *args, **kwargs)

        with (
            mock.patch("builtins.eval", side_effect=AssertionError("eval called")),
            mock.patch("builtins.exec", side_effect=AssertionError("exec called")),
            mock.patch("builtins.compile", side_effect=guarded_compile),
            mock.patch("builtins.__import__", side_effect=AssertionError("__import__ called")),
        ):
            att = verifier.verify_fixture_snapshot(
                self.cand_snap,
                base_snapshot=self.base_snap,
                claim=self.claim,
                invocation_nonce=TEST_NONCE,
                attestation_key=TEST_HMAC_KEY,
            )
            self.assertTrue(att["passed"])
            self.assertEqual(len(compile_calls), 2)

    def test_python_semantic_parity_encodings_locals_and_exceptions(self):
        # 1. UTF-8 BOM and PEP 263 coding cookies are rejected cleanly.
        for bad_limits in [
            b"\xef\xbb\xbfdef clamp(value):\n    return value\n",
            b"# -*- coding: latin-1 -*-\ndef clamp(value):\n    return value\n",
            b"# pilot\n# coding=utf-8\ndef clamp(value):\n    return value\n",
        ]:
            with self.assertRaises(verifier.UnsupportedSyntaxError):
                verifier.parse_allowlisted_module(bad_limits, "limits.py")

        # 2. Reading a function-local variable before assignment raises UnboundLocalError (never global fallback).
        unbound_local_snap = verifier.freeze_file_snapshot(
            {
                "limits.py": (
                    b"def clamp(value):\n"
                    b"    if value > 999:\n"
                    b"        res = value\n"
                    b"    return res\n"
                ),
                "measurement.py": ORDINARY_CORRECTED_FILES["measurement.py"],
            },
            label="unbound",
        )
        att_unbound = verifier.verify_fixture_snapshot(
            unbound_local_snap,
            base_snapshot=self.base_snap,
            claim=self.claim,
            invocation_nonce=TEST_NONCE,
            attestation_key=TEST_HMAC_KEY,
        )
        self.assertFalse(att_unbound["passed"])
        self.assertEqual(att_unbound["caseResults"][0]["error"], "unhandled_UnboundLocalError")

        # 3. String operations / oversized int strings outside integer domain raise execution_limit_exceeded
        # instead of being swallowed by except (TypeError, ValueError).
        str_format_snap = verifier.freeze_file_snapshot(
            {
                "limits.py": ORDINARY_CORRECTED_FILES["limits.py"],
                "measurement.py": (
                    b"from limits import clamp\n\n"
                    b"def normalize(raw):\n"
                    b"    try:\n"
                    b"        if isinstance(raw, str):\n"
                    b"            bad = raw % raw\n"
                    b"        return clamp(int(raw))\n"
                    b"    except (TypeError, ValueError):\n"
                    b"        return 0\n"
                ),
            },
            label="str-mod",
        )
        att_str_mod = verifier.verify_fixture_snapshot(
            str_format_snap,
            base_snapshot=self.base_snap,
            claim=self.claim,
            invocation_nonce=TEST_NONCE,
            attestation_key=TEST_HMAC_KEY,
        )
        self.assertFalse(att_str_mod["passed"])
        self.assertEqual(att_str_mod["caseResults"][5]["error"], "execution_limit_exceeded")

    def test_rejects_reduced_subset_and_escape_syntax(self):
        bad_limits_variants = [
            b"import os\ndef clamp(value):\n    return value\n",
            b"from limits import clamp\ndef clamp(value):\n    return value\n",
            b"LOWER = 0\ndef clamp(value):\n    return value\n",
            b"def clamp(value):\n    pass\n",
            b"def clamp(value):\n    x = 1\n    x += 1\n    return value\n",
            b"def clamp(value):\n    return value is 0\n",
            b"def clamp(value):\n    return clamp(value)\n",
            b"def clamp(value):\n    return int()\n",
            b"def clamp(value):\n    return abs()\n",
            b"def clamp(value):\n    return min(value)\n",
            b"def clamp(value):\n    return max(value)\n",
            b"def clamp(value):\n    return eval('0')\n",
            b"def clamp(value):\n    return __import__('os')\n",
            b"def clamp(value):\n    return open('x', 'w')\n",
            b"def clamp(value):\n    print('{\"value\":0}')\n    return 0\n",
            b"def clamp(value):\n    return (1).__class__\n",
            b"def clamp(value):\n    return [x for x in (1, 2)]\n",
            b"def clamp(value):\n    while True:\n        return 0\n",
            b"def clamp(value):\n    for x in (1, 2):\n        return 0\n",
            b"def clamp(value):\n    f = lambda x: x\n    return f(value)\n",
            b"class Evil:\n    x = 1\ndef clamp(value):\n    return value\n",
            b"def clamp(value):\n    return value ** 1000\n",
            b"def clamp(value):\n    return value << 1000\n",
            b"def clamp(value):\n    return value[0]\n",
            b"def clamp(value: int) -> int:\n    return value\n",
            b"def clamp(value, extra=0):\n    return value\n",
            b"def clamp(value):\n    _secret = 1\n    return value\n",
            b"def clamp(value):\n    int = 1\n    return value\n",
            b"def clamp(value):\n    return f'{value}'\n",
            b"def clamp(value):\n    if (x := value):\n        return x\n    return 0\n",
            b"def clamp(value):\n    return 1.5\n",
            b"def clamp(value):\n    def inner():\n        return 0\n    return inner()\n",
            b"def clamp(value):\n    raise ValueError('bad')\n",
            b"def clamp(value:\n",
        ]
        for bad_limits in bad_limits_variants:
            with self.subTest(bad_limits=bad_limits):
                with self.assertRaises(verifier.UnsupportedSyntaxError):
                    verifier.parse_allowlisted_module(bad_limits, "limits.py")

        bad_measurement_variants = [
            b"def normalize(raw):\n    return 0\n",
            b"from limits import clamp as c\ndef normalize(raw):\n    return c(int(raw))\n",
            b"from os import path\ndef normalize(raw):\n    return 0\n",
            b"from limits import clamp\ndef normalize(raw):\n    return normalize(raw)\n",
            b"from limits import clamp\ndef normalize(raw):\n    return clamp(1, 2)\n",
            b"from limits import clamp\ndef normalize(raw):\n    try:\n        return clamp(int(raw))\n    except:\n        return 0\n",
            b"from limits import clamp\ndef normalize(raw):\n    try:\n        return clamp(int(raw))\n    except Exception:\n        return 0\n",
            b"from limits import clamp\ndef normalize(raw):\n    try:\n        return clamp(int(raw))\n    except ValueError as err:\n        return 0\n",
            b"from limits import clamp\ndef normalize(raw):\n    try:\n        return clamp(int(raw))\n    except ValueError:\n        return 0\n    else:\n        return 1\n",
            b"from limits import clamp\ndef normalize(raw):\n    try:\n        return clamp(int(raw))\n    except (TypeError, ValueError):\n        return 0\n    finally:\n        return 1\n",
            b"from limits import clamp\ndef normalize(raw):\n    return clamp(int(raw, base=10))\n",
        ]
        for bad_measurement in bad_measurement_variants:
            with self.subTest(bad_measurement=bad_measurement):
                with self.assertRaises(verifier.UnsupportedSyntaxError):
                    verifier.parse_allowlisted_module(bad_measurement, "measurement.py")

    def test_rejects_oversized_and_deep_ast(self):
        many_ifs = b"def clamp(value):\n" + b"    if value < 0:\n        return 0\n" * 90 + b"    return value\n"
        with self.assertRaises(verifier.UnsupportedSyntaxError):
            verifier.parse_allowlisted_module(many_ifs, "limits.py")

        deep_expr = b"def clamp(value):\n    return " + b"+".join([b"1"] * 45) + b"\n"
        with self.assertRaises(verifier.UnsupportedSyntaxError):
            verifier.parse_allowlisted_module(deep_expr, "limits.py")

    def test_enforces_bounded_work_on_steps_and_integer_overflow(self):
        step_snap = verifier.freeze_file_snapshot(
            {
                "limits.py": (
                    b"def clamp(value):\n"
                    + b"    value = value + 1 - 1\n" * 10
                    + b"    return value\n"
                ),
                "measurement.py": (
                    b"from limits import clamp\n\n"
                    b"def normalize(raw):\n"
                    b"    x = int(raw)\n"
                    b"    return clamp(x) + clamp(0) + clamp(0) + clamp(0) + clamp(0)\n"
                ),
            },
            label="steps-budget",
        )
        att_steps = verifier.verify_fixture_snapshot(
            step_snap,
            base_snapshot=self.base_snap,
            claim=self.claim,
            invocation_nonce=TEST_NONCE,
            attestation_key=TEST_HMAC_KEY,
        )
        self.assertFalse(att_steps["passed"])
        # Case 6 invokes normalize("-12") -> multiple clamp calls exceed MAX_STEPS_PER_CASE.
        self.assertEqual(att_steps["caseResults"][5]["error"], "execution_limit_exceeded")

        overflow_snap = verifier.freeze_file_snapshot(
            {
                "limits.py": (
                    b"def clamp(value):\n"
                    b"    x = 1000000000000000\n"
                    b"    x = x * x\n"
                    b"    return x\n"
                ),
                "measurement.py": ORDINARY_CORRECTED_FILES["measurement.py"],
            },
            label="overflow",
        )
        att_ovf = verifier.verify_fixture_snapshot(
            overflow_snap,
            base_snapshot=self.base_snap,
            claim=self.claim,
            invocation_nonce=TEST_NONCE,
            attestation_key=TEST_HMAC_KEY,
        )
        self.assertFalse(att_ovf["passed"])
        self.assertEqual(att_ovf["caseResults"][0]["error"], "execution_limit_exceeded")

    def test_forged_snapshot_metadata_is_rejected(self):
        real_digests = {
            name: hashlib.sha256(ORDINARY_CORRECTED_FILES[name]).hexdigest()
            for name in verifier.APPROVED_FILES
        }
        real_tree = hashlib.sha256(
            json.dumps(
                [[name, real_digests[name]] for name in verifier.APPROVED_FILES],
                separators=(",", ":"),
                ensure_ascii=False,
            ).encode("utf-8")
        ).hexdigest()
        base_digests = dict(self.base_snap.file_digests)
        forged_digests = {name: "0" * 64 for name in verifier.APPROVED_FILES}
        forged_tree = hashlib.sha256(
            json.dumps(
                [[name, forged_digests[name]] for name in verifier.APPROVED_FILES],
                separators=(",", ":"),
                ensure_ascii=False,
            ).encode("utf-8")
        ).hexdigest()

        digest_forgery = verifier.FileSnapshot(
            raw_bytes=MappingProxyType(dict(ORDINARY_CORRECTED_FILES)),
            file_digests=MappingProxyType(forged_digests),
            tree_sha256=forged_tree,
        )
        tree_forgery = verifier.FileSnapshot(
            raw_bytes=MappingProxyType(dict(ORDINARY_CORRECTED_FILES)),
            file_digests=MappingProxyType(dict(real_digests)),
            tree_sha256="ab" * 32,
        )
        # Bytes differ from the claim, but the declared digests copy the claim.
        claim_digest_forgery = verifier.FileSnapshot(
            raw_bytes=MappingProxyType(dict(ORDINARY_CORRECTED_FILES)),
            file_digests=MappingProxyType(base_digests),
            tree_sha256=self.base_snap.tree_sha256,
        )
        for bad_snap in (digest_forgery, tree_forgery, claim_digest_forgery):
            with self.subTest(kind=bad_snap.tree_sha256[:8]):
                with self.assertRaises(verifier.InvalidInputError):
                    verifier.build_scope(BASE_REVISION, bad_snap)
                with self.assertRaises(verifier.InvalidInputError):
                    verifier.validate_controller_claim(self.claim, base_snapshot=bad_snap)
                with self.assertRaises(verifier.InvalidInputError):
                    verifier.verify_fixture_snapshot(
                        bad_snap,
                        base_snapshot=self.base_snap,
                        claim=self.claim,
                        invocation_nonce=TEST_NONCE,
                        attestation_key=TEST_HMAC_KEY,
                    )
                with self.assertRaises(verifier.InvalidInputError):
                    verifier.verify_fixture_snapshot(
                        self.cand_snap,
                        base_snapshot=bad_snap,
                        claim=self.claim,
                        invocation_nonce=TEST_NONCE,
                        attestation_key=TEST_HMAC_KEY,
                    )

        mutable_raw = dict(ORDINARY_CORRECTED_FILES)
        mutable_snap = verifier.FileSnapshot(
            raw_bytes=MappingProxyType(mutable_raw),
            file_digests=MappingProxyType(dict(real_digests)),
            tree_sha256=real_tree,
        )
        mutable_raw["limits.py"] = b"def clamp(value):\n    return 1\n"
        with self.assertRaises(verifier.InvalidInputError):
            verifier.verify_fixture_snapshot(
                mutable_snap,
                base_snapshot=self.base_snap,
                claim=self.claim,
                invocation_nonce=TEST_NONCE,
                attestation_key=TEST_HMAC_KEY,
            )

        class _SecondReadFlip(dict):
            def __init__(self) -> None:
                super().__init__(ORDINARY_CORRECTED_FILES)
                self.limit_reads = 0

            def __getitem__(self, key: str) -> bytes:
                value = super().__getitem__(key)
                if key == "limits.py":
                    self.limit_reads += 1
                    if self.limit_reads >= 2:
                        return b"import os\ndef clamp(value):\n    return value\n"
                return value

        flipped = _SecondReadFlip()
        substituted = verifier.FileSnapshot(
            raw_bytes=flipped,
            file_digests=MappingProxyType(dict(real_digests)),
            tree_sha256=real_tree,
        )
        with self.assertRaises(verifier.InvalidInputError):
            verifier.verify_fixture_snapshot(
                substituted,
                base_snapshot=self.base_snap,
                claim=self.claim,
                invocation_nonce=TEST_NONCE,
                attestation_key=TEST_HMAC_KEY,
            )

        class _LaterReadFlip(dict):
            def __init__(self) -> None:
                super().__init__(ORDINARY_CORRECTED_FILES)
                self.limit_reads = 0

            def __getitem__(self, key: str) -> bytes:
                value = super().__getitem__(key)
                if key == "limits.py":
                    self.limit_reads += 1
                    if self.limit_reads > 2:
                        return b"import os\ndef clamp(value):\n    return value\n"
                return value

        delayed = _LaterReadFlip()
        consistent_direct = verifier.FileSnapshot(
            raw_bytes=delayed,
            file_digests=MappingProxyType(dict(real_digests)),
            tree_sha256=real_tree,
        )
        att = verifier.verify_fixture_snapshot(
            consistent_direct,
            base_snapshot=self.base_snap,
            claim=self.claim,
            invocation_nonce=TEST_NONCE,
            attestation_key=TEST_HMAC_KEY,
        )
        self.assertEqual(delayed.limit_reads, 2)
        self.assertTrue(att["passed"])
        self.assertEqual(att["fileDigests"], real_digests)
        self.assertEqual(att["treeSha256"], real_tree)
        self.assertEqual(att["baseFileDigests"], base_digests)
        self.assertEqual(att["baseTreeSha256"], self.base_snap.tree_sha256)
        verifier.verify_attestation(
            att,
            expected_claim=self.claim,
            expected_invocation_nonce=TEST_NONCE,
            attestation_key=TEST_HMAC_KEY,
        )

        with tempfile.TemporaryDirectory(prefix="pfv-forged-journal-") as tmp:
            jpath = Path(tmp) / "run.jsonl"
            row0 = {
                "id": CLAIM_ID,
                "state": "claimed",
                "scope": self.claim["scope"],
                "scopeHash": self.claim["scopeHash"],
            }
            jpath.write_bytes((json.dumps(row0) + "\n").encode("utf-8"))
            with self.assertRaises(verifier.InvalidInputError):
                verifier.load_controller_claim_from_journal(
                    jpath, CLAIM_ID, base_snapshot=claim_digest_forgery
                )

    def test_step_limit_failure_is_authenticated_and_saved(self):
        step_snap = verifier.freeze_file_snapshot(
            {
                "limits.py": (
                    b"def clamp(value):\n"
                    + b"    value = value + 1 - 1\n" * 10
                    + b"    return value\n"
                ),
                "measurement.py": (
                    b"from limits import clamp\n\n"
                    b"def normalize(raw):\n"
                    b"    x = int(raw)\n"
                    b"    return clamp(x) + clamp(0) + clamp(0) + clamp(0) + clamp(0)\n"
                ),
            },
            label="steps-budget-authenticated",
        )
        att = verifier.verify_fixture_snapshot(
            step_snap,
            base_snapshot=self.base_snap,
            claim=self.claim,
            invocation_nonce=TEST_NONCE,
            attestation_key=TEST_HMAC_KEY,
        )
        self.assertFalse(att["passed"])
        self.assertEqual(att["caseResults"][5]["error"], "execution_limit_exceeded")
        self.assertEqual(att["caseResults"][5]["steps"], verifier.MAX_STEPS_PER_CASE)
        self.assertLessEqual(att["workObserved"]["maxCaseSteps"], verifier.MAX_STEPS_PER_CASE)
        for row in att["caseResults"]:
            self.assertIsInstance(row["steps"], int)
            self.assertGreaterEqual(row["steps"], 0)
            self.assertLessEqual(row["steps"], verifier.MAX_STEPS_PER_CASE)
        verifier.verify_attestation(
            att,
            expected_claim=self.claim,
            expected_invocation_nonce=TEST_NONCE,
            attestation_key=TEST_HMAC_KEY,
        )
        with tempfile.TemporaryDirectory(prefix="pfv-steps-") as tmp:
            att_path = Path(tmp) / "step-limit.json"
            verifier.write_attestation_file(
                att_path,
                att,
                expected_claim=self.claim,
                expected_invocation_nonce=TEST_NONCE,
                attestation_key=TEST_HMAC_KEY,
            )
            saved = json.loads(att_path.read_text(encoding="utf-8"))
            self.assertEqual(saved["caseResults"][5]["steps"], verifier.MAX_STEPS_PER_CASE)
            self.assertEqual(saved["caseResults"][5]["error"], "execution_limit_exceeded")
            verifier.verify_attestation(
                saved,
                expected_claim=self.claim,
                expected_invocation_nonce=TEST_NONCE,
                attestation_key=TEST_HMAC_KEY,
            )

    def test_finding2_rejects_unauthenticated_and_substituted_attestations(self):
        att = verifier.verify_fixture_snapshot(
            self.cand_snap,
            base_snapshot=self.base_snap,
            claim=self.claim,
            invocation_nonce=TEST_NONCE,
            attestation_key=TEST_HMAC_KEY,
        )

        # Bare trusted=True / wrong HMAC / wrong nonce / wrong key all fail.
        for bad_att in [
            {**att, "passed": False},
            {**att, "trusted": False},
            {**att, "provenance": {**att["provenance"], "hmacSha256": "0" * 64}},
            {**att, "provenance": {**att["provenance"], "invocationNonce": "other-nonce-123456"}},
            {**att, "results": att["results"][:-1]},
            {**att, "caseResults": att["caseResults"][:-1]},
            {**att, "passedCases": 11, "failures": [1]},
        ]:
            with self.assertRaises(verifier.InvalidInputError):
                verifier.verify_attestation(
                    bad_att,
                    expected_claim=self.claim,
                    expected_invocation_nonce=TEST_NONCE,
                    attestation_key=TEST_HMAC_KEY,
                )

        # Wrong HMAC key fails closed.
        with self.assertRaises(verifier.InvalidInputError):
            verifier.verify_attestation(
                att,
                expected_claim=self.claim,
                expected_invocation_nonce=TEST_NONCE,
                attestation_key=b"wrong-controller-key-32-bytes!!",
            )

        # Dual claim+verifier substitution (self-consistent bogus claim + signed bogus attestation)
        # must still be rejected when compared against controller's expected_claim.
        other_claim = _make_claim("b" * 40, self.base_snap, "attacker-claim-999")
        other_att = verifier.verify_fixture_snapshot(
            self.cand_snap,
            base_snapshot=self.base_snap,
            claim=other_claim,
            invocation_nonce=TEST_NONCE,
            attestation_key=TEST_HMAC_KEY,
        )
        with self.assertRaises(verifier.InvalidInputError):
            verifier.verify_attestation(
                other_att,
                expected_claim=self.claim,
                expected_invocation_nonce=TEST_NONCE,
                attestation_key=TEST_HMAC_KEY,
            )

    def test_finding3_immutable_file_snapshot_prevents_mutation_races(self):
        # Mutable directory-loading helpers were removed completely.
        self.assertFalse(hasattr(verifier, "load_candidate_dir"))
        self.assertFalse(hasattr(verifier, "verify_candidate_dir"))

        mutable_dict = dict(ORDINARY_CORRECTED_FILES)
        snap = verifier.freeze_file_snapshot(mutable_dict, label="cand")
        mutable_dict["limits.py"] = b"import os\n"
        self.assertEqual(snap.raw_bytes["limits.py"], ORDINARY_CORRECTED_FILES["limits.py"])
        with self.assertRaises(TypeError):
            snap.raw_bytes["limits.py"] = b"tamper"  # type: ignore[index]

    def test_rejects_invalid_inputs_and_tampered_claims(self):
        for bad_files in [
            {"limits.py": ORDINARY_CORRECTED_FILES["limits.py"]},
            {**ORDINARY_CORRECTED_FILES, "extra.py": b"x = 1\n"},
            {**ORDINARY_CORRECTED_FILES, "limits.py": "def clamp(value):\n    return 0\n"},
            {**ORDINARY_CORRECTED_FILES, "limits.py": b""},
            {**ORDINARY_CORRECTED_FILES, "limits.py": b"   \n\t "},
            {**ORDINARY_CORRECTED_FILES, "limits.py": b"x" * (verifier.MAX_FILE_BYTES + 1)},
            {**ORDINARY_CORRECTED_FILES, "limits.py": b"def clamp(value):\n    return 0\x00\n"},
            {**ORDINARY_CORRECTED_FILES, "limits.py": b"\xff\xfe\n"},
        ]:
            with self.assertRaises(verifier.InvalidInputError):
                verifier.freeze_file_snapshot(bad_files, label="bad")

        for bad_claim_id in ["", ".bad", "bad/id", "a" * 129]:
            with self.assertRaises(verifier.InvalidInputError):
                verifier.verify_fixture_snapshot(
                    self.cand_snap,
                    base_snapshot=self.base_snap,
                    claim={**self.claim, "claimId": bad_claim_id},
                    invocation_nonce=TEST_NONCE,
                    attestation_key=TEST_HMAC_KEY,
                )

        with self.assertRaises(verifier.InvalidInputError):
            verifier.verify_fixture_snapshot(
                self.cand_snap,
                base_snapshot=self.base_snap,
                claim={**self.claim, "scopeHash": "0" * 64},
                invocation_nonce=TEST_NONCE,
                attestation_key=TEST_HMAC_KEY,
            )

        with self.assertRaises(verifier.InvalidInputError):
            verifier.verify_fixture_snapshot(
                self.cand_snap,
                base_snapshot=self.base_snap,
                claim=self.claim,
                invocation_nonce="short",
                attestation_key=TEST_HMAC_KEY,
            )

        with self.assertRaises(verifier.InvalidInputError):
            verifier.verify_fixture_snapshot(
                self.cand_snap,
                base_snapshot=self.base_snap,
                claim=self.claim,
                invocation_nonce=TEST_NONCE,
                attestation_key=b"too-short",
            )

    def test_write_attestation_file_exclusive_and_authenticated(self):
        att = verifier.verify_fixture_snapshot(
            self.cand_snap,
            base_snapshot=self.base_snap,
            claim=self.claim,
            invocation_nonce=TEST_NONCE,
            attestation_key=TEST_HMAC_KEY,
        )
        with tempfile.TemporaryDirectory(prefix="pfv-write-") as tmp:
            root = Path(tmp)
            att_path = root / "attestation.json"
            verifier.write_attestation_file(
                att_path,
                att,
                expected_claim=self.claim,
                expected_invocation_nonce=TEST_NONCE,
                attestation_key=TEST_HMAC_KEY,
            )
            self.assertTrue(att_path.is_file())
            with self.assertRaises(FileExistsError):
                verifier.write_attestation_file(
                    att_path,
                    att,
                    expected_claim=self.claim,
                    expected_invocation_nonce=TEST_NONCE,
                    attestation_key=TEST_HMAC_KEY,
                )

            tampered = dict(att, passedCases=11, failures=[1])
            with self.assertRaises(verifier.InvalidInputError):
                verifier.write_attestation_file(
                    root / "tampered.json",
                    tampered,
                    expected_claim=self.claim,
                    expected_invocation_nonce=TEST_NONCE,
                    attestation_key=TEST_HMAC_KEY,
                )

    def test_cli_fail_closed_and_key_channels(self):
        with tempfile.TemporaryDirectory(prefix="pfv-cli-") as tmp:
            root = Path(tmp)
            key_file = root / "hmac.key"
            key_file.write_bytes(TEST_HMAC_KEY)
            if os.name == "posix":
                os.chmod(key_file, 0o600)

            out_file = root / "att.json"

            def run_cli(stdin_bytes: bytes, extra_args: list[str]) -> tuple[int, dict[str, object]]:
                fake_stdin = mock.MagicMock()
                fake_stdin.buffer = io.BytesIO(stdin_bytes)
                fake_stdout = io.StringIO()
                with mock.patch.object(sys, "stdin", fake_stdin), mock.patch.object(sys, "stdout", fake_stdout):
                    rc = verifier._main(["--key-file", str(key_file), *extra_args])
                return rc, json.loads(fake_stdout.getvalue())

            rc_pass, pass_payload = run_cli(
                _make_cli_envelope(ORDINARY_CORRECTED_FILES),
                ["--output", str(out_file)],
            )
            self.assertEqual(rc_pass, 0)
            self.assertTrue(pass_payload["passed"])
            self.assertTrue(out_file.is_file())

            # Exclusive output prevents overwrite and fails closed with JSON error.
            rc_dup, dup_payload = run_cli(
                _make_cli_envelope(ORDINARY_CORRECTED_FILES),
                ["--output", str(out_file)],
            )
            self.assertEqual(rc_dup, 2)
            self.assertFalse(dup_payload["trusted"])

            rc_fail, fail_payload = run_cli(
                _make_cli_envelope(BASELINE_FILES),
                [],
            )
            self.assertEqual(rc_fail, 1)
            self.assertTrue(fail_payload["trusted"])
            self.assertFalse(fail_payload["passed"])

            rc_syn, syn_payload = run_cli(
                _make_cli_envelope(
                    {
                        "limits.py": b"import os\ndef clamp(value):\n    return value\n",
                        "measurement.py": ORDINARY_CORRECTED_FILES["measurement.py"],
                    }
                ),
                [],
            )
            self.assertEqual(rc_syn, 3)
            self.assertFalse(syn_payload["trusted"])

            rc_bad, bad_payload = run_cli(b"{not-json", [])
            self.assertEqual(rc_bad, 2)
            self.assertFalse(bad_payload["trusted"])

            # Verify --key-fd pipe reader rejects stdio fds and accepts bounded keys.
            with self.assertRaises(verifier.InvalidInputError):
                verifier._read_key_from_fd(0)
            r_fd, w_fd = os.pipe()
            try:
                os.write(w_fd, TEST_HMAC_KEY)
                os.close(w_fd)
                w_fd = -1
                self.assertEqual(verifier._read_key_from_fd(r_fd), TEST_HMAC_KEY)
            finally:
                if w_fd >= 0:
                    os.close(w_fd)
                os.close(r_fd)

    def test_interoperates_with_verified_patch_helper(self):
        vp_path = PILOT_DIR / "verified-patch.mjs"
        if not vp_path.is_file():
            self.skipTest("verified-patch.mjs absent")
        vp_source = vp_path.read_text(encoding="utf-8", errors="replace")
        self.assertIn("buildScope", vp_source)
        self.assertIn("createVerifiedPatchController", vp_source)

        node_bin = shutil.which("node")
        git_bin = shutil.which("git")
        if not node_bin or not git_bin:
            self.skipTest("node or git unavailable for verified-patch interop test")

        with tempfile.TemporaryDirectory(prefix="pfv-vp-interop-") as tmp:
            root = Path(tmp)
            base_repo = root / "base-repo"
            scratch = root / "scratch"
            base_repo.mkdir()
            scratch.mkdir()
            for name, raw in BASELINE_FILES.items():
                (base_repo / name).write_bytes(raw)

            null_dev = "NUL" if os.name == "nt" else "/dev/null"
            git_env = {
                **os.environ,
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": null_dev,
                "GIT_TERMINAL_PROMPT": "0",
            }
            git_prefix = [
                git_bin,
                "--no-optional-locks",
                "-c",
                f"core.hooksPath={null_dev}",
                "-c",
                "core.autocrlf=false",
                "-c",
                "core.eol=lf",
                "-c",
                "core.symlinks=false",
            ]
            subprocess.run([*git_prefix, "init", "--quiet", "--initial-branch=pilot", "--template="], cwd=base_repo, env=git_env, check=True)
            subprocess.run([*git_prefix, "add", "--", "limits.py", "measurement.py"], cwd=base_repo, env=git_env, check=True)
            subprocess.run(
                [*git_prefix, "-c", "user.name=Synthetic", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--no-verify", "-m", "Baseline"],
                cwd=base_repo,
                env=git_env,
                check=True,
            )
            base_rev = subprocess.check_output([*git_prefix, "rev-parse", "HEAD"], cwd=base_repo, env=git_env, text=True).strip()

            claim = _make_claim(base_rev, self.base_snap, CLAIM_ID)
            att = verifier.verify_fixture_snapshot(
                self.cand_snap,
                base_snapshot=self.base_snap,
                claim=claim,
                invocation_nonce=TEST_NONCE,
                attestation_key=TEST_HMAC_KEY,
                require_all_files_changed=True,
            )
            att_path = root / "attestation.json"
            verifier.write_attestation_file(
                att_path,
                att,
                expected_claim=claim,
                expected_invocation_nonce=TEST_NONCE,
                attestation_key=TEST_HMAC_KEY,
                require_all_files_changed=True,
            )

            node_script = """
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const [vpPath, attPath, baseRepoDir, baseRevision, scratchRoot] = process.argv.slice(1);
const vp = await import(pathToFileURL(vpPath).href);
// This synthetic host fixture is supplied independently from verifier evidence.
const host = JSON.parse(readFileSync(0, 'utf8'));
const verification = JSON.parse(readFileSync(attPath, 'utf8'));
const candidateFiles = {
  'limits.py': readFileSync(process.env.CAND_LIMITS),
  'measurement.py': readFileSync(process.env.CAND_MEASUREMENT),
};
const built = vp.buildCandidatePatch({baseRepoDir, baseRevision, candidateFiles, scratchRoot});
const {scope, scopeHash} = vp.buildScope({
  baseRevision,
  baseFileDigests: host.claim.scope.baseFileDigests,
  cases: JSON.parse(process.env.APPROVED_CASES_JSON),
});
assert.deepEqual(scope, host.claim.scope);
assert.equal(scopeHash, host.claim.scopeHash);
const makeController = () => vp.createVerifiedPatchController({
  attestationKey: Buffer.from(host.keyHex, 'hex'),
  expectedInvocationNonce: host.nonce,
  claimRecord: host.claim,
});
const controller = makeController();
const bound = vp.verifyAndBindPatch({
  controller,
  baseRepoDir,
  baseRevision,
  approvedCases: JSON.parse(process.env.APPROVED_CASES_JSON),
  evidence: verification,
  patch: built.patch,
  candidateFiles,
  scratchRoot,
});
assert.equal(bound.status, 'verified-patch');
assert.deepEqual(bound.fileDigests, verification.fileDigests);
assert.equal(bound.treeSha256, verification.treeSha256);

assert.throws(() => vp.verifyAndBindPatch({
  controller,
  baseRepoDir,
  baseRevision,
  approvedCases: JSON.parse(process.env.APPROVED_CASES_JSON),
  evidence: verification,
  patch: built.patch,
  candidateFiles,
  scratchRoot,
}), /Replayed invocation nonce/);
const tampered = {...verification, treeSha256: '0'.repeat(64)};
assert.throws(() => vp.verifyAndBindPatch({
  controller: makeController(),
  baseRepoDir,
  baseRevision,
  approvedCases: JSON.parse(process.env.APPROVED_CASES_JSON),
  evidence: tampered,
  patch: built.patch,
  candidateFiles,
  scratchRoot,
}), /HMAC verification failed/);
console.log(JSON.stringify({status: bound.status, treeSha256: bound.treeSha256}));
"""
            cand_limits = root / "cand_limits.py"
            cand_meas = root / "cand_measurement.py"
            cand_limits.write_bytes(ORDINARY_CORRECTED_FILES["limits.py"])
            cand_meas.write_bytes(ORDINARY_CORRECTED_FILES["measurement.py"])
            env = {
                **os.environ,
                "CAND_LIMITS": str(cand_limits),
                "CAND_MEASUREMENT": str(cand_meas),
                "APPROVED_CASES_JSON": json.dumps([[f, i, e] for f, i, e in verifier.CASES]),
            }
            proc = subprocess.run(
                [
                    node_bin,
                    "--input-type=module",
                    "-e",
                    node_script,
                    str(vp_path),
                    str(att_path),
                    str(base_repo),
                    base_rev,
                    str(scratch),
                ],
                env=env,
                input=json.dumps({"claim": claim, "nonce": TEST_NONCE, "keyHex": TEST_HMAC_KEY.hex()}),
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, msg=proc.stderr)
            out = json.loads(proc.stdout)
            self.assertEqual(out["status"], "verified-patch")
            self.assertEqual(out["treeSha256"], att["treeSha256"])


if __name__ == "__main__":
    unittest.main()
