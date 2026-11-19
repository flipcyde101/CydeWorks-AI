"""Inert unit tests for the disconnected fixed-synthetic protected fixture verifier."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
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


class ProtectedFixtureVerifierTests(unittest.TestCase):
    def test_scope_label_and_pilot_cases_alignment(self):
        self.assertEqual(verifier.VERIFIER_SCOPE, "fixed-synthetic-only")
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

    def test_ordinary_corrected_fixture_passes_and_binds_raw_hashes(self):
        att = verifier.verify_fixture_bytes(
            ORDINARY_CORRECTED_FILES,
            claim_id=CLAIM_ID,
            base_revision=BASE_REVISION,
            base_files=BASELINE_FILES,
            require_all_files_changed=True,
        )
        self.assertEqual(att["scope"], "fixed-synthetic-only")
        self.assertTrue(att["entryPointDisconnected"])
        self.assertTrue(att["trusted"])
        self.assertTrue(att["passed"])
        self.assertEqual(att["claimId"], CLAIM_ID)
        self.assertEqual(att["baseRevision"], BASE_REVISION)
        self.assertEqual(att["casesDigest"], verifier.CASES_DIGEST)
        self.assertEqual(att["totalCases"], 12)
        self.assertEqual(att["passedCases"], 12)
        self.assertEqual(att["failures"], [])
        self.assertEqual(att["unchangedFiles"], [])

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
        verifier.validate_attestation_shape(att)

    def test_alternative_valid_syntax_with_pure_helpers_and_bounded_ops_passes(self):
        alt_files = {
            "limits.py": (
                b'"""Fixed synthetic clamp helper."""\n'
                b"LOWER = 0\n"
                b"UPPER = 100 + 0\n\n"
                b"def clamp(value):\n"
                b'    """Clamp value into [0, 100]."""\n'
                b"    if 0 <= value <= 100:\n"
                b"        return value\n"
                b"    return max(LOWER, min(UPPER, value))\n"
            ),
            "measurement.py": (
                b"from limits import clamp\n\n"
                b"def normalize(raw):\n"
                b"    if isinstance(raw, bool):\n"
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
        att = verifier.verify_fixture_bytes(
            alt_files,
            claim_id=CLAIM_ID,
            base_revision=BASE_REVISION,
        )
        self.assertTrue(att["trusted"])
        self.assertTrue(att["passed"])
        self.assertEqual(att["passedCases"], 12)
        self.assertEqual(att["failures"], [])

    def test_baseline_fixture_fails_expected_cases(self):
        att = verifier.verify_fixture_bytes(
            BASELINE_FILES,
            claim_id=CLAIM_ID,
            base_revision=BASE_REVISION,
            base_files=BASELINE_FILES,
        )
        self.assertTrue(att["trusted"])
        self.assertFalse(att["passed"])
        self.assertEqual(att["totalCases"], 12)
        self.assertEqual(att["passedCases"], 5)
        self.assertEqual(att["failures"], [1, 5, 6, 8, 10, 11, 12])
        self.assertEqual(att["unchangedFiles"], ["limits.py", "measurement.py"])

    def test_require_all_files_changed_rejects_partial_change(self):
        partial = {
            "limits.py": ORDINARY_CORRECTED_FILES["limits.py"],
            "measurement.py": BASELINE_FILES["measurement.py"],
        }
        att = verifier.verify_fixture_bytes(
            partial,
            claim_id=CLAIM_ID,
            base_revision=BASE_REVISION,
            base_files=BASELINE_FILES,
            require_all_files_changed=True,
        )
        self.assertFalse(att["passed"])
        self.assertEqual(att["unchangedFiles"], ["measurement.py"])

    def test_bool_return_is_rejected_even_when_equal_to_zero_or_one(self):
        bool_files = {
            "limits.py": b"def clamp(value):\n    return False\n",
            "measurement.py": ORDINARY_CORRECTED_FILES["measurement.py"],
        }
        att = verifier.verify_fixture_bytes(
            bool_files,
            claim_id=CLAIM_ID,
            base_revision=BASE_REVISION,
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
            att = verifier.verify_fixture_bytes(
                ORDINARY_CORRECTED_FILES,
                claim_id=CLAIM_ID,
                base_revision=BASE_REVISION,
            )
            self.assertTrue(att["passed"])
            self.assertEqual(len(compile_calls), 2)

    def test_rejects_every_unsupported_syntax_or_escape_attempt(self):
        bad_limits_variants = [
            b"import os\ndef clamp(value):\n    return value\n",
            b"from limits import clamp\ndef clamp(value):\n    return value\n",
            b"TOP = clamp(1)\ndef clamp(value):\n    return value\n",
            b"def clamp(value):\n    return eval('0')\n",
            b"def clamp(value):\n    return __import__('os')\n",
            b"def clamp(value):\n    return open('x', 'w')\n",
            b"def clamp(value):\n    print('{\"value\":0}')\n    return 0\n",
            b"def clamp(value):\n    return (1).__class__\n",
            b"def clamp(value):\n    return [x for x in (1, 2)]\n",
            b"def clamp(value):\n    while True:\n        pass\n    return 0\n",
            b"def clamp(value):\n    for x in (1, 2):\n        pass\n    return 0\n",
            b"def clamp(value):\n    f = lambda x: x\n    return f(value)\n",
            b"class Evil:\n    pass\ndef clamp(value):\n    return value\n",
            b"def clamp(value):\n    return value ** 1000\n",
            b"def clamp(value):\n    return value << 1000\n",
            b"def clamp(value):\n    return value[0]\n",
            b"def clamp(value):\n    if 0 > 1:\n        import sys\n    return value\n",
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
                    verifier.verify_fixture_bytes(
                        {
                            "limits.py": bad_limits,
                            "measurement.py": ORDINARY_CORRECTED_FILES["measurement.py"],
                        },
                        claim_id=CLAIM_ID,
                        base_revision=BASE_REVISION,
                    )

        bad_measurement_variants = [
            b"def normalize(raw):\n    return 0\n",
            b"from limits import clamp as c\ndef normalize(raw):\n    return c(int(raw))\n",
            b"from os import path\ndef normalize(raw):\n    return 0\n",
            b"from limits import clamp\ndef normalize(raw):\n    try:\n        return clamp(int(raw))\n    except:\n        return 0\n",
            b"from limits import clamp\ndef normalize(raw):\n    try:\n        return clamp(int(raw))\n    except Exception:\n        return 0\n",
            b"from limits import clamp\ndef normalize(raw):\n    try:\n        return clamp(int(raw))\n    except (TypeError, ValueError):\n        return 0\n    finally:\n        pass\n",
            b"from limits import clamp\ndef normalize(raw):\n    return clamp(int(raw, base=10))\n",
        ]
        for bad_measurement in bad_measurement_variants:
            with self.subTest(bad_measurement=bad_measurement):
                with self.assertRaises(verifier.UnsupportedSyntaxError):
                    verifier.verify_fixture_bytes(
                        {
                            "limits.py": ORDINARY_CORRECTED_FILES["limits.py"],
                            "measurement.py": bad_measurement,
                        },
                        claim_id=CLAIM_ID,
                        base_revision=BASE_REVISION,
                    )

    def test_rejects_oversized_and_deep_ast(self):
        many_ifs = b"def clamp(value):\n" + b"    if value < 0:\n        return 0\n" * 90 + b"    return value\n"
        with self.assertRaises(verifier.UnsupportedSyntaxError):
            verifier.parse_allowlisted_module(many_ifs, "limits.py")

        deep_expr = b"def clamp(value):\n    return " + b"+".join([b"1"] * 45) + b"\n"
        with self.assertRaises(verifier.UnsupportedSyntaxError):
            verifier.parse_allowlisted_module(deep_expr, "limits.py")

    def test_enforces_bounded_work_on_recursion_steps_and_integer_overflow(self):
        recursive_clamp = {
            "limits.py": b"def clamp(value):\n    return clamp(value)\n",
            "measurement.py": ORDINARY_CORRECTED_FILES["measurement.py"],
        }
        att_rec = verifier.verify_fixture_bytes(
            recursive_clamp,
            claim_id=CLAIM_ID,
            base_revision=BASE_REVISION,
        )
        self.assertFalse(att_rec["passed"])
        # Cases 1..9 invoke clamp and hit MAX_CALL_DEPTH; 10..12 hit int() ValueError/TypeError first.
        self.assertEqual(att_rec["failures"], [1, 2, 3, 4, 5, 6, 7, 8, 9])
        self.assertEqual(att_rec["caseResults"][0]["error"], "execution_limit_exceeded")

        recursive_normalize = {
            "limits.py": ORDINARY_CORRECTED_FILES["limits.py"],
            "measurement.py": b"from limits import clamp\n\ndef normalize(raw):\n    return normalize(raw)\n",
        }
        att_norm_rec = verifier.verify_fixture_bytes(
            recursive_normalize,
            claim_id=CLAIM_ID,
            base_revision=BASE_REVISION,
        )
        self.assertFalse(att_norm_rec["passed"])
        self.assertEqual(att_norm_rec["failures"], [6, 7, 8, 9, 10, 11, 12])
        self.assertEqual(att_norm_rec["caseResults"][5]["error"], "execution_limit_exceeded")

        # Stays within MAX_CALL_DEPTH (8) while exceeding MAX_STEPS_PER_CASE (256).
        step_heavy_files = {
            "limits.py": (
                b"def clamp(value):\n"
                b"    x = 1\n"
                + (b"    x += 1\n" * 20)
                + b"    return clamp(value + 1)\n"
            ),
            "measurement.py": ORDINARY_CORRECTED_FILES["measurement.py"],
        }
        att_steps = verifier.verify_fixture_bytes(
            step_heavy_files,
            claim_id=CLAIM_ID,
            base_revision=BASE_REVISION,
        )
        self.assertFalse(att_steps["passed"])
        self.assertEqual(att_steps["caseResults"][0]["error"], "execution_limit_exceeded")
        self.assertLessEqual(att_steps["workObserved"]["maxCaseCallDepth"], verifier.MAX_CALL_DEPTH)

        overflow_files = {
            "limits.py": (
                b"def clamp(value):\n"
                b"    x = 1000000000000000\n"
                b"    x = x * x\n"
                b"    return x\n"
            ),
            "measurement.py": ORDINARY_CORRECTED_FILES["measurement.py"],
        }
        att_ovf = verifier.verify_fixture_bytes(
            overflow_files,
            claim_id=CLAIM_ID,
            base_revision=BASE_REVISION,
        )
        self.assertFalse(att_ovf["passed"])
        self.assertEqual(att_ovf["caseResults"][0]["error"], "execution_limit_exceeded")

    def test_rejects_invalid_inputs_and_tampered_bindings(self):
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
                verifier.verify_fixture_bytes(
                    bad_files,
                    claim_id=CLAIM_ID,
                    base_revision=BASE_REVISION,
                )

        for bad_claim in ["", ".bad", "bad/id", "a" * 129]:
            with self.assertRaises(verifier.InvalidInputError):
                verifier.verify_fixture_bytes(
                    ORDINARY_CORRECTED_FILES,
                    claim_id=bad_claim,
                    base_revision=BASE_REVISION,
                )

        for bad_rev in ["", "abc", "A" * 40, "0" * 39]:
            with self.assertRaises(verifier.InvalidInputError):
                verifier.verify_fixture_bytes(
                    ORDINARY_CORRECTED_FILES,
                    claim_id=CLAIM_ID,
                    base_revision=bad_rev,
                )

        with self.assertRaises(verifier.InvalidInputError):
            verifier.verify_fixture_bytes(
                ORDINARY_CORRECTED_FILES,
                claim_id=CLAIM_ID,
                base_revision=BASE_REVISION,
                expected_cases_digest="0" * 64,
            )

    def test_candidate_dir_ignores_extra_tests_and_writes_exclusive_attestation(self):
        with tempfile.TemporaryDirectory(prefix="pfv-test-") as tmp:
            root = Path(tmp)
            cand_dir = root / "candidate"
            cand_dir.mkdir()
            for name, raw in ORDINARY_CORRECTED_FILES.items():
                (cand_dir / name).write_bytes(raw)
            # Candidate drops an extra test file; verifier must ignore it completely.
            (cand_dir / "test_limits.py").write_bytes(b"import os; os._exit(99)\n")

            att = verifier.verify_candidate_dir(
                cand_dir,
                claim_id=CLAIM_ID,
                base_revision=BASE_REVISION,
            )
            self.assertTrue(att["passed"])

            att_path = root / "attestation.json"
            verifier.write_attestation_file(att_path, att)
            self.assertTrue(att_path.is_file())
            with self.assertRaises(FileExistsError):
                verifier.write_attestation_file(att_path, att)

            tampered = dict(att, passed=True, passedCases=11, failures=[1])
            with self.assertRaises(verifier.InvalidInputError):
                verifier.validate_attestation_shape(tampered)

    def test_disconnected_cli_exit_codes(self):
        with tempfile.TemporaryDirectory(prefix="pfv-cli-") as tmp:
            root = Path(tmp)
            pass_dir = root / "pass"
            fail_dir = root / "fail"
            bad_dir = root / "bad"
            pass_dir.mkdir()
            fail_dir.mkdir()
            bad_dir.mkdir()

            for name, raw in ORDINARY_CORRECTED_FILES.items():
                (pass_dir / name).write_bytes(raw)
            for name, raw in BASELINE_FILES.items():
                (fail_dir / name).write_bytes(raw)
            (bad_dir / "limits.py").write_bytes(b"import os\ndef clamp(value):\n    return value\n")
            (bad_dir / "measurement.py").write_bytes(ORDINARY_CORRECTED_FILES["measurement.py"])

            out_file = root / "out.json"
            proc_pass = subprocess.run(
                [
                    sys.executable,
                    str(VERIFIER_PATH),
                    "--candidate-dir",
                    str(pass_dir),
                    "--claim-id",
                    CLAIM_ID,
                    "--base-revision",
                    BASE_REVISION,
                    "--output",
                    str(out_file),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(proc_pass.returncode, 0)
            self.assertTrue(json.loads(proc_pass.stdout)["passed"])
            self.assertTrue(out_file.is_file())

            proc_fail = subprocess.run(
                [
                    sys.executable,
                    str(VERIFIER_PATH),
                    "--candidate-dir",
                    str(fail_dir),
                    "--claim-id",
                    CLAIM_ID,
                    "--base-revision",
                    BASE_REVISION,
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(proc_fail.returncode, 1)
            fail_payload = json.loads(proc_fail.stdout)
            self.assertTrue(fail_payload["trusted"])
            self.assertFalse(fail_payload["passed"])

            proc_syntax = subprocess.run(
                [
                    sys.executable,
                    str(VERIFIER_PATH),
                    "--candidate-dir",
                    str(bad_dir),
                    "--claim-id",
                    CLAIM_ID,
                    "--base-revision",
                    BASE_REVISION,
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(proc_syntax.returncode, 3)
            self.assertFalse(json.loads(proc_syntax.stdout)["trusted"])

            proc_invalid = subprocess.run(
                [
                    sys.executable,
                    str(VERIFIER_PATH),
                    "--candidate-dir",
                    str(root / "missing"),
                    "--claim-id",
                    CLAIM_ID,
                    "--base-revision",
                    BASE_REVISION,
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(proc_invalid.returncode, 2)
            self.assertFalse(json.loads(proc_invalid.stdout)["trusted"])

    def test_interoperates_with_verified_patch_helper(self):
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

            att = verifier.verify_fixture_bytes(
                ORDINARY_CORRECTED_FILES,
                claim_id=CLAIM_ID,
                base_revision=base_rev,
                base_files=BASELINE_FILES,
                require_all_files_changed=True,
            )
            att_path = root / "attestation.json"
            verifier.write_attestation_file(att_path, att)

            node_script = """
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const [vpPath, attPath, baseRepoDir, baseRevision, scratchRoot] = process.argv.slice(1);
const vp = await import(pathToFileURL(vpPath).href);
const verification = JSON.parse(readFileSync(attPath, 'utf8'));
const candidateFiles = {
  'limits.py': readFileSync(process.env.CAND_LIMITS),
  'measurement.py': readFileSync(process.env.CAND_MEASUREMENT),
};
const built = vp.buildCandidatePatch({baseRepoDir, baseRevision, candidateFiles, scratchRoot});
const claim = {
  claimId: verification.claimId,
  scopeHash: 'b'.repeat(64),
  baseRevision,
  baseFileDigests: verification.baseFileDigests,
};
const bound = vp.verifyAndBindPatch({
  baseRepoDir,
  baseRevision,
  claim,
  verification,
  patch: built.patch,
  candidateFiles,
  requireAllFilesChanged: true,
  scratchRoot,
});
assert.equal(bound.status, 'verified-patch');
assert.deepEqual(bound.fileDigests, verification.fileDigests);
assert.equal(bound.treeSha256, verification.treeSha256);
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
            }
            proc = subprocess.run(
                [
                    node_bin,
                    "--input-type=module",
                    "-e",
                    node_script,
                    str(PILOT_DIR / "verified-patch.mjs"),
                    str(att_path),
                    str(base_repo),
                    base_rev,
                    str(scratch),
                ],
                env=env,
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
