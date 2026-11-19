"""Trusted allowlisted AST verifier for the fixed synthetic limits/measurement fixture.

Scope: fixed synthetic only (limits.py + measurement.py, 12 pilot CASES).
Entry point status: disconnected standalone module; not wired into pilot.mjs,
guest.py, sandbox.py, or harness/ until integration review.

Trust model and limits:
- Consumes immutable controller-owned byte snapshots (no mutable directory reads).
- Never imports, compiles to bytecode, evals, or executes candidate Python.
- Rejects UTF-8 BOMs and PEP 263 coding declarations so raw-byte decoding
  matches Python's source decoder.
- Enforces a minimal AST subset whose accepted semantics match Python:
  if/return, try/except on (TypeError, ValueError) without 'as' target or else/
  finally, local variable assignments with Python UnboundLocalError tracking,
  bounded integer arithmetic, comparisons (is/is not None only), and known pure
  helpers (int, min, max, abs, isinstance).
- Binds every attestation to a controller-owned claim (claimId, scope, scopeHash),
  mandatory base-file snapshot digests, a per-invocation nonce, and an HMAC-SHA256
  MAC; caller-visible `trusted: true` is an acceptance gate only and does not
  prove provenance without verify_attestation().
- Passing 12 fixed synthetic cases does not prove general fixture behavior.
"""

from __future__ import annotations

import argparse
import ast
import base64
import binascii
from collections.abc import Mapping
from dataclasses import dataclass
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import stat
import sys
from types import MappingProxyType


VERIFIER_SCOPE = "fixed-synthetic-only"
VERIFIER_TARGET = "limits.py+measurement.py"
VERIFIER_VERSION = "protected-fixture-verifier-ast-v2"
APPROVED_FILES = ("limits.py", "measurement.py")

MAX_FILE_BYTES = 8192
MAX_STDIN_BYTES = 65536
MAX_AST_NODES = 192
MAX_AST_DEPTH = 24
MAX_STEPS_PER_CASE = 256
MAX_INT_ABS = 10**18
MAX_STR_LEN = 64
MAX_DOCSTRING_LEN = 512
MIN_HMAC_KEY_BYTES = 16
MAX_HMAC_KEY_BYTES = 256

CLAIM_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
HEX_REV_RE = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
HEX_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
NONCE_RE = re.compile(r"^[A-Za-z0-9._-]{16,128}$")
SAFE_IDENT_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
PEP263_CODING_RE = re.compile(rb"^[ \t\f]*#.*?coding[:=][ \t]*([-_.a-zA-Z0-9]+)")

ALLOWED_EXCEPTION_NAMES = frozenset({"TypeError", "ValueError"})
ALLOWED_TYPE_NAMES = frozenset({"int", "str", "bool"})
PURE_HELPER_NAMES = frozenset({"int", "min", "max", "abs", "isinstance"})
RESERVED_NAMES = frozenset(
    {
        "True",
        "False",
        "None",
        "clamp",
        "normalize",
        *PURE_HELPER_NAMES,
        *ALLOWED_EXCEPTION_NAMES,
        *ALLOWED_TYPE_NAMES,
    }
)

# Exact protected case vector matching research/isolated-runner-20261118/pilot.mjs.
CASES = (
    ("clamp", -8, 0),
    ("clamp", 0, 0),
    ("clamp", 56, 56),
    ("clamp", 100, 100),
    ("clamp", 164, 100),
    ("normalize", "-12", 0),
    ("normalize", " 42 ", 42),
    ("normalize", "150", 100),
    ("normalize", 75, 75),
    ("normalize", "bad", 0),
    ("normalize", None, 0),
    ("normalize", "", 0),
)


def _canonical_json(value: object) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _json_sha256(value: object) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


CASES_DIGEST = _json_sha256([[fn, inp, exp] for fn, inp, exp in CASES])


def trusted_oracle_clamp(value: object) -> int:
    if type(value) is not int:
        raise TypeError("clamp oracle expects an exact int")
    if value < 0:
        return 0
    if value > 100:
        return 100
    return value


def trusted_oracle_normalize(raw: object) -> int:
    if type(raw) is int:
        converted = raw
    elif type(raw) is str:
        if len(raw) > MAX_STR_LEN:
            raise ValueError("oracle string exceeds length bound")
        try:
            converted = int(raw)
        except ValueError:
            return 0
    else:
        return 0
    return trusted_oracle_clamp(converted)


def _verify_oracle_matches_cases() -> None:
    for index, (fn_name, arg, expected) in enumerate(CASES, start=1):
        actual = trusted_oracle_clamp(arg) if fn_name == "clamp" else trusted_oracle_normalize(arg)
        if type(actual) is not int or actual != expected:
            raise AssertionError(f"Oracle mismatch at case {index}: {actual!r} != {expected!r}")


_verify_oracle_matches_cases()


class VerifierError(Exception):
    """Base error for protected fixture verification failures."""


class InvalidInputError(VerifierError, ValueError):
    """Raised when snapshot bytes, claims, or attestation inputs fail validation."""


class UnsupportedSyntaxError(VerifierError, ValueError):
    """Raised when candidate source contains syntax or AST nodes outside the allowlist."""


class ExecutionLimitError(VerifierError, RuntimeError):
    """Raised when candidate AST evaluation exceeds bounded work or domain limits."""


class _ReturnSignal(Exception):
    def __init__(self, value: object) -> None:
        super().__init__()
        self.value = value


class _GuestException(Exception):
    def __init__(self, exc_name: str, detail: str) -> None:
        super().__init__(detail)
        self.exc_name = exc_name
        self.detail = detail


@dataclass(frozen=True)
class FileSnapshot:
    """Immutable controller-owned two-file byte snapshot."""

    raw_bytes: MappingProxyType[str, bytes]
    file_digests: MappingProxyType[str, str]
    tree_sha256: str


@dataclass(frozen=True)
class ValidatedModule:
    filename: str
    function_def: ast.FunctionDef
    param_name: str
    local_names: frozenset[str]
    node_count: int
    max_depth: int


_ALLOWED_BINOPS = (ast.Add, ast.Sub, ast.Mult, ast.FloorDiv, ast.Mod)
_ALLOWED_UNARYOPS = (ast.UAdd, ast.USub, ast.Not)
_ALLOWED_BOOLOPS = (ast.And, ast.Or)
_ALLOWED_VALUE_CMPOPS = (ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE)
_ALLOWED_IDENTITY_CMPOPS = (ast.Is, ast.IsNot)


def freeze_file_snapshot(files: Mapping[str, bytes], *, label: str = "snapshot") -> FileSnapshot:
    """Validate raw two-file bytes and freeze them into an immutable snapshot."""
    if not isinstance(files, Mapping):
        raise InvalidInputError(f"{label} must be a mapping object.")
    if tuple(sorted(files.keys())) != APPROVED_FILES:
        raise InvalidInputError(f"{label} must match exact allowlist {APPROVED_FILES}.")

    copied: dict[str, bytes] = {}
    digests: dict[str, str] = {}
    for name in APPROVED_FILES:
        raw = files[name]
        if type(raw) is not bytes:
            raise InvalidInputError(f"{label}[{name}] must be raw bytes.")
        if len(raw) == 0 or len(raw) > MAX_FILE_BYTES:
            raise InvalidInputError(f"{label}[{name}] byte length out of bounds (1..{MAX_FILE_BYTES}).")
        if b"\x00" in raw:
            raise InvalidInputError(f"{label}[{name}] contains a NUL byte.")
        try:
            text = raw.decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            raise InvalidInputError(f"{label}[{name}] is not valid UTF-8.") from error
        if not text.strip():
            raise InvalidInputError(f"{label}[{name}] cannot be whitespace-only.")
        raw_copy = bytes(raw)
        copied[name] = raw_copy
        digests[name] = hashlib.sha256(raw_copy).hexdigest()

    tree_sha256 = _json_sha256([[name, digests[name]] for name in APPROVED_FILES])
    return FileSnapshot(
        raw_bytes=MappingProxyType(copied),
        file_digests=MappingProxyType(digests),
        tree_sha256=tree_sha256,
    )


def _check_source_encoding(raw: bytes, filename: str) -> str:
    """Reject UTF-8 BOMs and PEP 263 coding cookies so UTF-8 decode matches Python."""
    if raw.startswith(b"\xef\xbb\xbf"):
        raise UnsupportedSyntaxError(f"{filename} cannot start with a UTF-8 BOM.")
    lines = raw.splitlines()[:2]
    for line in lines:
        if PEP263_CODING_RE.match(line):
            raise UnsupportedSyntaxError(f"{filename} cannot declare a PEP 263 coding cookie.")
    return raw.decode("utf-8", errors="strict")


def _check_identifier(name: object, *, allow_reserved: bool, context: str) -> str:
    if type(name) is not str or name.startswith("_") or not SAFE_IDENT_RE.fullmatch(name):
        raise UnsupportedSyntaxError(f"Disallowed identifier in {context}: {name!r}")
    if not allow_reserved and name in RESERVED_NAMES:
        raise UnsupportedSyntaxError(f"Cannot shadow reserved name in {context}: {name}")
    return name


def _is_docstring_expr(node: ast.stmt) -> bool:
    return (
        type(node) is ast.Expr
        and type(node.value) is ast.Constant
        and type(node.value.value) is str
        and len(node.value.value) <= MAX_DOCSTRING_LEN
    )


class _AstValidator:
    def __init__(self, filename: str) -> None:
        self.filename = filename
        self.node_count = 0
        self.max_depth = 0
        self.local_names: set[str] = set()
        self.allowed_calls = frozenset(
            PURE_HELPER_NAMES if filename == "limits.py" else {*PURE_HELPER_NAMES, "clamp"}
        )

    def _enter(self, node: ast.AST, depth: int) -> None:
        self.node_count += 1
        if self.node_count > MAX_AST_NODES:
            raise UnsupportedSyntaxError(f"{self.filename} exceeds max AST node count ({MAX_AST_NODES}).")
        if depth > MAX_AST_DEPTH:
            raise UnsupportedSyntaxError(f"{self.filename} exceeds max AST depth ({MAX_AST_DEPTH}).")
        if depth > self.max_depth:
            self.max_depth = depth

    def validate_module(self, tree: ast.AST) -> ValidatedModule:
        if type(tree) is not ast.Module or getattr(tree, "type_ignores", []):
            raise UnsupportedSyntaxError(f"{self.filename} must be a plain ast.Module.")
        self._enter(tree, 1)
        if not tree.body:
            raise UnsupportedSyntaxError(f"{self.filename} has an empty module body.")

        expected_fn = "clamp" if self.filename == "limits.py" else "normalize"
        saw_import = False
        function_def: ast.FunctionDef | None = None

        for index, stmt in enumerate(tree.body):
            stmt_type = type(stmt)
            if index == 0 and _is_docstring_expr(stmt):
                self._enter(stmt, 2)
                self._enter(stmt.value, 3)
                continue
            if stmt_type is ast.ImportFrom:
                if self.filename != "measurement.py" or saw_import:
                    raise UnsupportedSyntaxError(f"Unexpected ImportFrom in {self.filename}.")
                self._validate_import_from(stmt, 2)
                saw_import = True
                continue
            if stmt_type is ast.FunctionDef:
                if function_def is not None or stmt.name != expected_fn:
                    raise UnsupportedSyntaxError(f"{self.filename} must define only {expected_fn}().")
                self._validate_function_def(stmt, 2)
                function_def = stmt
                continue
            raise UnsupportedSyntaxError(
                f"Unsupported top-level statement {stmt_type.__name__} in {self.filename}."
            )

        if self.filename == "measurement.py" and not saw_import:
            raise UnsupportedSyntaxError("measurement.py must include 'from limits import clamp'.")
        if function_def is None:
            raise UnsupportedSyntaxError(f"{self.filename} must define {expected_fn}().")

        param_name = function_def.args.args[0].arg
        return ValidatedModule(
            filename=self.filename,
            function_def=function_def,
            param_name=param_name,
            local_names=frozenset(self.local_names),
            node_count=self.node_count,
            max_depth=self.max_depth,
        )

    def _validate_import_from(self, node: ast.ImportFrom, depth: int) -> None:
        self._enter(node, depth)
        if node.module != "limits" or node.level != 0 or len(node.names) != 1:
            raise UnsupportedSyntaxError("Only 'from limits import clamp' is allowed.")
        alias = node.names[0]
        if type(alias) is not ast.alias or alias.name != "clamp" or alias.asname is not None:
            raise UnsupportedSyntaxError("Only 'from limits import clamp' is allowed.")
        self._enter(alias, depth + 1)

    def _validate_function_def(self, node: ast.FunctionDef, depth: int) -> None:
        self._enter(node, depth)
        if node.decorator_list or node.returns is not None or getattr(node, "type_params", []):
            raise UnsupportedSyntaxError("Decorators, return annotations, and type params are rejected.")
        if getattr(node, "type_comment", None) is not None:
            raise UnsupportedSyntaxError("Type comments are rejected.")
        args = node.args
        if type(args) is not ast.arguments:
            raise UnsupportedSyntaxError("Invalid function arguments node.")
        self._enter(args, depth + 1)
        if (
            args.posonlyargs
            or args.kwonlyargs
            or args.vararg is not None
            or args.kwarg is not None
            or args.defaults
            or args.kw_defaults
            or len(args.args) != 1
        ):
            raise UnsupportedSyntaxError(f"{node.name} must accept exactly one positional parameter.")
        arg = args.args[0]
        if type(arg) is not ast.arg or arg.annotation is not None or getattr(arg, "type_comment", None) is not None:
            raise UnsupportedSyntaxError("Parameter annotations are rejected.")
        self._enter(arg, depth + 2)
        param = _check_identifier(arg.arg, allow_reserved=False, context="parameter")
        self.local_names.add(param)
        if not node.body:
            raise UnsupportedSyntaxError(f"{node.name} body cannot be empty.")
        self._validate_stmt_list(node.body, depth + 1, allow_docstring=True)

    def _validate_stmt_list(
        self, stmts: list[ast.stmt], depth: int, *, allow_docstring: bool = False
    ) -> None:
        if not stmts:
            raise UnsupportedSyntaxError("Statement block cannot be empty.")
        for index, stmt in enumerate(stmts):
            if allow_docstring and index == 0 and _is_docstring_expr(stmt):
                self._enter(stmt, depth)
                self._enter(stmt.value, depth + 1)
                continue
            self._validate_stmt(stmt, depth)

    def _validate_stmt(self, node: ast.stmt, depth: int) -> None:
        node_type = type(node)
        if node_type is ast.If:
            self._enter(node, depth)
            self._validate_expr(node.test, depth + 1)
            self._validate_stmt_list(node.body, depth + 1)
            if node.orelse:
                self._validate_stmt_list(node.orelse, depth + 1)
            return
        if node_type is ast.Return:
            self._enter(node, depth)
            if node.value is not None:
                self._validate_expr(node.value, depth + 1)
            return
        if node_type is ast.Try:
            self._enter(node, depth)
            if node.finalbody or node.orelse or not node.handlers:
                raise UnsupportedSyntaxError("Try supports only body and except handlers.")
            self._validate_stmt_list(node.body, depth + 1)
            for handler in node.handlers:
                self._validate_except_handler(handler, depth + 1)
            return
        if node_type is ast.Assign:
            self._validate_assign(node, depth)
            return
        raise UnsupportedSyntaxError(
            f"Unsupported statement node {node_type.__name__} in {self.filename}."
        )

    def _validate_except_handler(self, handler: ast.ExceptHandler, depth: int) -> None:
        if type(handler) is not ast.ExceptHandler:
            raise UnsupportedSyntaxError("Invalid exception handler.")
        self._enter(handler, depth)
        if handler.type is None or handler.name is not None:
            raise UnsupportedSyntaxError("Except requires explicit TypeError/ValueError without 'as' binding.")
        exc_type = handler.type
        if type(exc_type) is ast.Name:
            self._enter(exc_type, depth + 1)
            if type(exc_type.ctx) is not ast.Load or exc_type.id not in ALLOWED_EXCEPTION_NAMES:
                raise UnsupportedSyntaxError("Only TypeError or ValueError may be caught.")
        elif type(exc_type) is ast.Tuple:
            self._enter(exc_type, depth + 1)
            if type(exc_type.ctx) is not ast.Load or not exc_type.elts:
                raise UnsupportedSyntaxError("Exception tuple cannot be empty.")
            for elt in exc_type.elts:
                if (
                    type(elt) is not ast.Name
                    or type(elt.ctx) is not ast.Load
                    or elt.id not in ALLOWED_EXCEPTION_NAMES
                ):
                    raise UnsupportedSyntaxError("Except tuple elements must be TypeError or ValueError.")
                self._enter(elt, depth + 2)
        else:
            raise UnsupportedSyntaxError(f"Unsupported except type {type(exc_type).__name__}.")
        self._validate_stmt_list(handler.body, depth + 1)

    def _validate_assign(self, node: ast.Assign, depth: int) -> None:
        self._enter(node, depth)
        if getattr(node, "type_comment", None) is not None or len(node.targets) != 1:
            raise UnsupportedSyntaxError("Only single-target unannotated assignments are allowed.")
        target = node.targets[0]
        if type(target) is not ast.Name or type(target.ctx) is not ast.Store:
            raise UnsupportedSyntaxError("Assignment target must be a simple variable name.")
        self._enter(target, depth + 1)
        ident = _check_identifier(target.id, allow_reserved=False, context="assignment target")
        self.local_names.add(ident)
        self._validate_expr(node.value, depth + 1)

    def _validate_isinstance_type_arg(self, node: ast.expr, depth: int) -> None:
        if type(node) is ast.Name:
            self._enter(node, depth)
            if type(node.ctx) is not ast.Load or node.id not in ALLOWED_TYPE_NAMES:
                raise UnsupportedSyntaxError(f"Unsupported isinstance target type {node.id!r}.")
            return
        if type(node) is ast.Tuple:
            self._enter(node, depth)
            if type(node.ctx) is not ast.Load or not node.elts:
                raise UnsupportedSyntaxError("isinstance type tuple cannot be empty.")
            for elt in node.elts:
                if (
                    type(elt) is not ast.Name
                    or type(elt.ctx) is not ast.Load
                    or elt.id not in ALLOWED_TYPE_NAMES
                ):
                    raise UnsupportedSyntaxError("isinstance tuple elements must be int, str, or bool.")
                self._enter(elt, depth + 1)
            return
        raise UnsupportedSyntaxError("isinstance second argument must be int, str, bool, or a tuple of them.")

    def _validate_expr(self, node: ast.expr, depth: int) -> None:
        node_type = type(node)
        if node_type is ast.Constant:
            self._enter(node, depth)
            val = node.value
            val_type = type(val)
            if val_type is int:
                if abs(val) > MAX_INT_ABS:
                    raise UnsupportedSyntaxError("Integer literal exceeds allowed bound.")
            elif val_type is str:
                if len(val) > MAX_STR_LEN:
                    raise UnsupportedSyntaxError("String literal exceeds allowed bound.")
            elif val_type is not bool and val is not None:
                raise UnsupportedSyntaxError(f"Unsupported constant type {val_type.__name__}.")
            return
        if node_type is ast.Name:
            self._enter(node, depth)
            if type(node.ctx) is not ast.Load:
                raise UnsupportedSyntaxError("Invalid Name context.")
            _check_identifier(node.id, allow_reserved=True, context="name load")
            return
        if node_type is ast.UnaryOp:
            self._enter(node, depth)
            if type(node.op) not in _ALLOWED_UNARYOPS:
                raise UnsupportedSyntaxError(f"Unsupported unary operator {type(node.op).__name__}.")
            self._enter(node.op, depth + 1)
            self._validate_expr(node.operand, depth + 1)
            return
        if node_type is ast.BinOp:
            self._enter(node, depth)
            if type(node.op) not in _ALLOWED_BINOPS:
                raise UnsupportedSyntaxError(f"Unsupported binary operator {type(node.op).__name__}.")
            self._enter(node.op, depth + 1)
            self._validate_expr(node.left, depth + 1)
            self._validate_expr(node.right, depth + 1)
            return
        if node_type is ast.BoolOp:
            self._enter(node, depth)
            if type(node.op) not in _ALLOWED_BOOLOPS or len(node.values) < 2:
                raise UnsupportedSyntaxError("Unsupported boolean operator.")
            self._enter(node.op, depth + 1)
            for value in node.values:
                self._validate_expr(value, depth + 1)
            return
        if node_type is ast.Compare:
            self._enter(node, depth)
            if not node.ops or len(node.ops) != len(node.comparators):
                raise UnsupportedSyntaxError("Invalid comparison node.")
            self._validate_expr(node.left, depth + 1)
            prev_expr = node.left
            for op, comp in zip(node.ops, node.comparators):
                op_type = type(op)
                if op_type in _ALLOWED_IDENTITY_CMPOPS:
                    is_none_pair = (
                        (type(prev_expr) is ast.Constant and prev_expr.value is None)
                        or (type(comp) is ast.Constant and comp.value is None)
                    )
                    if not is_none_pair:
                        raise UnsupportedSyntaxError("'is' and 'is not' are only allowed against None.")
                elif op_type not in _ALLOWED_VALUE_CMPOPS:
                    raise UnsupportedSyntaxError(f"Unsupported comparison operator {op_type.__name__}.")
                self._enter(op, depth + 1)
                self._validate_expr(comp, depth + 1)
                prev_expr = comp
            return
        if node_type is ast.IfExp:
            self._enter(node, depth)
            self._validate_expr(node.test, depth + 1)
            self._validate_expr(node.body, depth + 1)
            self._validate_expr(node.orelse, depth + 1)
            return
        if node_type is ast.Call:
            self._enter(node, depth)
            if node.keywords:
                raise UnsupportedSyntaxError("Keyword arguments in calls are rejected.")
            if type(node.func) is not ast.Name or type(node.func.ctx) is not ast.Load:
                raise UnsupportedSyntaxError("Call target must be a direct function name.")
            self._enter(node.func, depth + 1)
            callee = _check_identifier(node.func.id, allow_reserved=True, context="call")
            if callee not in self.allowed_calls:
                raise UnsupportedSyntaxError(f"Call to unallowlisted function {callee!r} is rejected.")
            if len(node.args) > 16:
                raise UnsupportedSyntaxError("Call exceeds argument count bound.")
            for arg in node.args:
                if type(arg) is ast.Starred:
                    raise UnsupportedSyntaxError("Starred call arguments are rejected.")
            if callee == "isinstance":
                if len(node.args) != 2:
                    raise UnsupportedSyntaxError("isinstance requires exactly 2 arguments.")
                self._validate_expr(node.args[0], depth + 1)
                self._validate_isinstance_type_arg(node.args[1], depth + 1)
            else:
                if callee in ("int", "abs", "clamp") and len(node.args) != 1:
                    raise UnsupportedSyntaxError(f"{callee}() requires exactly 1 positional argument.")
                if callee in ("min", "max") and len(node.args) < 2:
                    raise UnsupportedSyntaxError(f"{callee}() requires at least 2 positional arguments.")
                for arg in node.args:
                    self._validate_expr(arg, depth + 1)
            return
        raise UnsupportedSyntaxError(
            f"Unsupported expression node {node_type.__name__} in {self.filename}."
        )


def parse_allowlisted_module(source_bytes: bytes, filename: str) -> ValidatedModule:
    """Parse and validate immutable candidate bytes against the minimal AST subset."""
    if filename not in APPROVED_FILES:
        raise InvalidInputError(f"Unsupported fixture filename: {filename!r}")
    if type(source_bytes) is not bytes:
        raise InvalidInputError(f"{filename} source must be raw bytes.")
    if len(source_bytes) == 0 or len(source_bytes) > MAX_FILE_BYTES:
        raise InvalidInputError(f"{filename} byte length must be between 1 and {MAX_FILE_BYTES}.")
    if b"\x00" in source_bytes:
        raise InvalidInputError(f"{filename} contains a NUL byte.")
    try:
        source_text = _check_source_encoding(source_bytes, filename)
    except UnicodeDecodeError as error:
        raise InvalidInputError(f"{filename} is not valid UTF-8.") from error
    if not source_text.strip():
        raise InvalidInputError(f"{filename} cannot be whitespace-only.")
    try:
        tree = ast.parse(source_text, filename=filename, mode="exec")
    except (SyntaxError, RecursionError, MemoryError, ValueError) as error:
        raise UnsupportedSyntaxError(f"{filename} failed safe AST parse: {error}") from error
    return _AstValidator(filename).validate_module(tree)


class _BoundedInterpreter:
    """Pure AST interpreter enforcing step and value bounds with Python-exact scoping."""

    _BUILTINS = {"int": int, "str": str, "bool": bool}

    def __init__(self, limits_mod: ValidatedModule, measurement_mod: ValidatedModule) -> None:
        self.limits_mod = limits_mod
        self.measurement_mod = measurement_mod
        self.steps = 0

    def _tick(self) -> None:
        self.steps += 1
        if self.steps > MAX_STEPS_PER_CASE:
            raise ExecutionLimitError(f"Case exceeded step budget ({MAX_STEPS_PER_CASE}).")

    @staticmethod
    def _check_int_bound(value: int) -> int:
        if abs(value) > MAX_INT_ABS:
            raise ExecutionLimitError(f"Integer result exceeded magnitude bound ({MAX_INT_ABS}).")
        return value

    def invoke(self, fn_name: str, arg: object) -> object:
        if fn_name == "clamp":
            return self._call_user_fn(self.limits_mod, arg)
        if fn_name == "normalize":
            return self._call_user_fn(self.measurement_mod, arg)
        raise InvalidInputError(f"Unknown fixture entry function: {fn_name!r}")

    def _call_user_fn(self, module: ValidatedModule, arg: object) -> object:
        self._tick()
        locals_env: dict[str, object] = {module.param_name: arg}
        try:
            self._exec_block(module.function_def.body, locals_env, module)
            return None
        except _ReturnSignal as ret:
            return ret.value

    def _exec_block(
        self, stmts: list[ast.stmt], locals_env: dict[str, object], module: ValidatedModule
    ) -> None:
        for index, stmt in enumerate(stmts):
            if index == 0 and _is_docstring_expr(stmt):
                continue
            self._exec_stmt(stmt, locals_env, module)

    def _exec_stmt(
        self, stmt: ast.stmt, locals_env: dict[str, object], module: ValidatedModule
    ) -> None:
        self._tick()
        stmt_type = type(stmt)
        if stmt_type is ast.Return:
            value = (
                self._eval_expr(stmt.value, locals_env, module)
                if stmt.value is not None
                else None
            )
            raise _ReturnSignal(value)
        if stmt_type is ast.Assign:
            locals_env[stmt.targets[0].id] = self._eval_expr(stmt.value, locals_env, module)
            return
        if stmt_type is ast.If:
            cond = self._eval_expr(stmt.test, locals_env, module)
            if bool(cond):
                self._exec_block(stmt.body, locals_env, module)
            elif stmt.orelse:
                self._exec_block(stmt.orelse, locals_env, module)
            return
        if stmt_type is ast.Try:
            try:
                self._exec_block(stmt.body, locals_env, module)
            except _GuestException as guest_exc:
                matched = self._match_handler(stmt.handlers, guest_exc.exc_name)
                if matched is None:
                    raise
                self._exec_block(matched.body, locals_env, module)
            return
        raise UnsupportedSyntaxError(f"Unsupported runtime statement {stmt_type.__name__}.")

    @staticmethod
    def _match_handler(
        handlers: list[ast.ExceptHandler], exc_name: str
    ) -> ast.ExceptHandler | None:
        for handler in handlers:
            exc_type = handler.type
            if type(exc_type) is ast.Name and exc_type.id == exc_name:
                return handler
            if type(exc_type) is ast.Tuple and any(
                type(elt) is ast.Name and elt.id == exc_name for elt in exc_type.elts
            ):
                return handler
        return None

    @staticmethod
    def _lookup(name: str, locals_env: dict[str, object], module: ValidatedModule) -> object:
        if name in locals_env:
            return locals_env[name]
        if name in module.local_names:
            raise _GuestException("UnboundLocalError", f"Local variable {name!r} referenced before assignment.")
        raise _GuestException("NameError", f"Undefined name {name!r}.")

    def _eval_expr(
        self, node: ast.expr, locals_env: dict[str, object], module: ValidatedModule
    ) -> object:
        self._tick()
        node_type = type(node)
        if node_type is ast.Constant:
            return node.value
        if node_type is ast.Name:
            return self._lookup(node.id, locals_env, module)
        if node_type is ast.UnaryOp:
            operand = self._eval_expr(node.operand, locals_env, module)
            op_type = type(node.op)
            if op_type is ast.Not:
                return not bool(operand)
            if not isinstance(operand, int):
                raise _GuestException("TypeError", "Unary arithmetic requires integer operand.")
            return self._check_int_bound(+operand if op_type is ast.UAdd else -operand)
        if node_type is ast.BinOp:
            left = self._eval_expr(node.left, locals_env, module)
            right = self._eval_expr(node.right, locals_env, module)
            return self._apply_binop(node.op, left, right)
        if node_type is ast.BoolOp:
            op_type = type(node.op)
            result: object = None
            for expr in node.values:
                result = self._eval_expr(expr, locals_env, module)
                if op_type is ast.And and not bool(result):
                    return result
                if op_type is ast.Or and bool(result):
                    return result
            return result
        if node_type is ast.Compare:
            left = self._eval_expr(node.left, locals_env, module)
            for op, comp in zip(node.ops, node.comparators):
                right = self._eval_expr(comp, locals_env, module)
                if not self._apply_cmp(op, left, right):
                    return False
                left = right
            return True
        if node_type is ast.IfExp:
            cond = self._eval_expr(node.test, locals_env, module)
            branch = node.body if bool(cond) else node.orelse
            return self._eval_expr(branch, locals_env, module)
        if node_type is ast.Call:
            callee = node.func.id
            if callee == "isinstance":
                arg_val = self._eval_expr(node.args[0], locals_env, module)
                type_node = node.args[1]
                if type(type_node) is ast.Name:
                    return isinstance(arg_val, self._BUILTINS[type_node.id])
                return isinstance(arg_val, tuple(self._BUILTINS[elt.id] for elt in type_node.elts))
            args = [self._eval_expr(arg, locals_env, module) for arg in node.args]
            return self._call_allowed_function(callee, args, module.filename)
        raise UnsupportedSyntaxError(f"Unsupported runtime expression {node_type.__name__}.")

    def _apply_binop(self, op: ast.operator, left: object, right: object) -> int:
        op_type = type(op)
        # Do not synthesize TypeError for string operations Python would evaluate.
        if (
            (type(left) is str and type(right) is str and op_type is ast.Add)
            or (
                ((type(left) is str and isinstance(right, int)) or (isinstance(left, int) and type(right) is str))
                and op_type is ast.Mult
            )
            or (type(left) is str and op_type is ast.Mod)
        ):
            raise ExecutionLimitError("String binary operation is outside the bounded integer domain.")
        if not isinstance(left, int) or not isinstance(right, int):
            raise _GuestException("TypeError", "Arithmetic requires integer operands.")
        if op_type is ast.Add:
            res = left + right
        elif op_type is ast.Sub:
            res = left - right
        elif op_type is ast.Mult:
            res = left * right
        elif op_type is ast.FloorDiv:
            if right == 0:
                raise _GuestException("ZeroDivisionError", "Integer division by zero.")
            res = left // right
        elif op_type is ast.Mod:
            if right == 0:
                raise _GuestException("ZeroDivisionError", "Integer modulo by zero.")
            res = left % right
        else:
            raise UnsupportedSyntaxError(f"Unsupported binary operator {op_type.__name__}.")
        return self._check_int_bound(res)

    @staticmethod
    def _apply_cmp(op: ast.cmpop, left: object, right: object) -> bool:
        op_type = type(op)
        if op_type is ast.Eq:
            return left == right
        if op_type is ast.NotEq:
            return left != right
        if op_type is ast.Is:
            return left is right
        if op_type is ast.IsNot:
            return left is not right
        try:
            if op_type is ast.Lt:
                return bool(left < right)
            if op_type is ast.LtE:
                return bool(left <= right)
            if op_type is ast.Gt:
                return bool(left > right)
            if op_type is ast.GtE:
                return bool(left >= right)
        except TypeError as error:
            raise _GuestException("TypeError", str(error)) from error
        raise UnsupportedSyntaxError(f"Unsupported comparison operator {op_type.__name__}.")

    def _call_allowed_function(self, callee: str, args: list[object], filename: str) -> object:
        if callee == "int":
            if len(args) != 1:
                raise _GuestException("TypeError", "int() expects exactly 1 argument.")
            return self._pure_int(args[0])
        if callee in ("min", "max"):
            if len(args) < 2:
                raise _GuestException("TypeError", f"{callee}() requires at least 2 numeric arguments.")
            if all(type(item) is str for item in args):
                raise ExecutionLimitError(f"{callee}() on strings is outside the bounded integer domain.")
            for item in args:
                if not isinstance(item, int):
                    raise _GuestException("TypeError", f"{callee}() requires integer arguments.")
            return min(args) if callee == "min" else max(args)
        if callee == "abs":
            if len(args) != 1 or not isinstance(args[0], int):
                raise _GuestException("TypeError", "abs() requires one integer argument.")
            return self._check_int_bound(abs(args[0]))
        if callee == "clamp" and filename == "measurement.py":
            if len(args) != 1:
                raise _GuestException("TypeError", "clamp() takes exactly 1 argument.")
            return self._call_user_fn(self.limits_mod, args[0])
        raise UnsupportedSyntaxError(f"Disallowed call target {callee!r} in {filename}.")

    def _pure_int(self, arg: object) -> int:
        arg_type = type(arg)
        if arg_type is int:
            return self._check_int_bound(arg)
        if arg_type is bool:
            return 1 if arg else 0
        if arg_type is str:
            if len(arg) > MAX_STR_LEN:
                raise ExecutionLimitError("int() string exceeds length bound.")
            try:
                parsed = int(arg)
            except ValueError as error:
                raise _GuestException("ValueError", "Invalid integer string.") from error
            return self._check_int_bound(parsed)
        raise _GuestException("TypeError", "int() argument must be a string or integer.")


def build_scope(base_revision: str, base_snapshot: FileSnapshot) -> tuple[dict[str, object], str]:
    """Build canonical scope matching verified-patch.mjs buildScope()."""
    if type(base_revision) is not str or not HEX_REV_RE.fullmatch(base_revision):
        raise InvalidInputError("Invalid baseRevision commit SHA.")
    if not isinstance(base_snapshot, FileSnapshot):
        raise InvalidInputError("base_snapshot must be a FileSnapshot.")
    scope: dict[str, object] = {
        "files": list(APPROVED_FILES),
        "baseRevision": base_revision,
        "baseFileDigests": {
            "limits.py": base_snapshot.file_digests["limits.py"],
            "measurement.py": base_snapshot.file_digests["measurement.py"],
        },
        "casesDigest": CASES_DIGEST,
        "totalCases": len(CASES),
    }
    return scope, _json_sha256(scope)


def validate_controller_claim(
    claim: Mapping[str, object], *, base_snapshot: FileSnapshot
) -> tuple[str, dict[str, object], str]:
    """Validate and recompute canonical scopeHash for a controller-owned claim."""
    if not isinstance(claim, Mapping):
        raise InvalidInputError("Controller claim must be a mapping.")
    claim_id = claim.get("claimId")
    if type(claim_id) is not str or not CLAIM_ID_RE.fullmatch(claim_id):
        raise InvalidInputError("Invalid claimId format.")
    scope = claim.get("scope")
    scope_hash = claim.get("scopeHash")
    if not isinstance(scope, Mapping) or type(scope_hash) is not str or not HEX_SHA256_RE.fullmatch(scope_hash):
        raise InvalidInputError("Controller claim must include valid scope and scopeHash.")
    expected_keys = ("files", "baseRevision", "baseFileDigests", "casesDigest", "totalCases")
    if set(scope.keys()) != set(expected_keys):
        raise InvalidInputError("Controller claim scope keys do not match required schema.")
    if list(scope.get("files", [])) != list(APPROVED_FILES):
        raise InvalidInputError("Controller claim scope.files mismatch.")
    base_rev = scope.get("baseRevision")
    if type(base_rev) is not str or not HEX_REV_RE.fullmatch(base_rev):
        raise InvalidInputError("Invalid scope.baseRevision commit SHA.")
    if scope.get("casesDigest") != CASES_DIGEST or scope.get("totalCases") != len(CASES):
        raise InvalidInputError("Controller claim check binding does not match fixed pilot CASES.")
    base_digests = scope.get("baseFileDigests")
    if not isinstance(base_digests, Mapping) or tuple(sorted(base_digests.keys())) != APPROVED_FILES:
        raise InvalidInputError("Controller claim scope.baseFileDigests invalid.")
    for name in APPROVED_FILES:
        if base_digests[name] != base_snapshot.file_digests[name]:
            raise InvalidInputError(f"Controller claim base digest mismatch for {name}.")

    canonical_scope, recomputed_hash = build_scope(base_rev, base_snapshot)
    if _json_sha256(dict(scope)) != scope_hash or recomputed_hash != scope_hash:
        raise InvalidInputError("Controller claim scopeHash does not match canonical scope digest.")
    return claim_id, canonical_scope, scope_hash


def load_controller_claim_from_journal(
    journal_path: str | Path, claim_id: str, *, base_snapshot: FileSnapshot
) -> dict[str, object]:
    """Read and validate line 0 of a runner-lifecycle.mjs claimRun() JSONL journal."""
    path = Path(journal_path)
    if path.is_symlink() or not path.is_file():
        raise InvalidInputError("Claim journal must be a regular non-symlink file.")
    raw = path.read_bytes()
    if not raw.endswith(b"\n"):
        raise InvalidInputError("Claim journal is truncated.")
    lines = raw.decode("utf-8", errors="strict").splitlines()
    if not lines:
        raise InvalidInputError("Claim journal is empty.")
    row0 = json.loads(lines[0])
    if not isinstance(row0, dict) or row0.get("state") != "claimed" or row0.get("id") != claim_id:
        raise InvalidInputError("Claim journal initial row does not match claimId.")
    claim = {"claimId": row0["id"], "scope": row0.get("scope"), "scopeHash": row0.get("scopeHash")}
    validate_controller_claim(claim, base_snapshot=base_snapshot)
    return claim


def _validate_invocation_inputs(invocation_nonce: str, attestation_key: bytes) -> None:
    if type(invocation_nonce) is not str or not NONCE_RE.fullmatch(invocation_nonce):
        raise InvalidInputError("Invalid invocation_nonce format.")
    if type(attestation_key) is not bytes or len(attestation_key) < MIN_HMAC_KEY_BYTES:
        raise InvalidInputError(f"attestation_key must be bytes of at least {MIN_HMAC_KEY_BYTES} bytes.")


def _compute_attestation_hmac(payload: Mapping[str, object], attestation_key: bytes) -> str:
    signable = {key: value for key, value in payload.items() if key != "provenance"}
    prov = payload.get("provenance")
    if isinstance(prov, Mapping):
        signable["provenance"] = {
            "claimBound": prov.get("claimBound"),
            "invocationNonce": prov.get("invocationNonce"),
        }
    return hmac.new(
        attestation_key,
        _canonical_json(signable).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def verify_fixture_snapshot(
    candidate_snapshot: FileSnapshot,
    *,
    base_snapshot: FileSnapshot,
    claim: Mapping[str, object],
    invocation_nonce: str,
    attestation_key: bytes,
    require_all_files_changed: bool = True,
) -> dict[str, object]:
    """Verify an immutable candidate byte snapshot against fixed CASES and bind provenance."""
    if not isinstance(candidate_snapshot, FileSnapshot):
        raise InvalidInputError("candidate_snapshot must be an immutable FileSnapshot.")
    if not isinstance(base_snapshot, FileSnapshot):
        raise InvalidInputError("base_snapshot must be an immutable FileSnapshot.")
    _validate_invocation_inputs(invocation_nonce, attestation_key)
    claim_id, canonical_scope, scope_hash = validate_controller_claim(
        claim, base_snapshot=base_snapshot
    )
    base_revision = str(canonical_scope["baseRevision"])

    limits_mod = parse_allowlisted_module(candidate_snapshot.raw_bytes["limits.py"], "limits.py")
    measurement_mod = parse_allowlisted_module(
        candidate_snapshot.raw_bytes["measurement.py"], "measurement.py"
    )

    failures: list[int] = []
    results: list[dict[str, object]] = []
    case_results: list[dict[str, object]] = []
    max_case_steps = 0

    for index, (fn_name, arg, expected) in enumerate(CASES, start=1):
        interpreter = _BoundedInterpreter(limits_mod, measurement_mod)
        error_label: str | None = None
        actual_int: int | None = None
        case_passed = False
        try:
            actual = interpreter.invoke(fn_name, arg)
            if type(actual) is int:
                actual_int = actual
                if actual == expected:
                    case_passed = True
                else:
                    error_label = "value_mismatch"
            else:
                error_label = f"invalid_return_type:{type(actual).__name__}"
        except _GuestException as guest_exc:
            error_label = f"unhandled_{guest_exc.exc_name}"
        except ExecutionLimitError:
            error_label = "execution_limit_exceeded"

        if interpreter.steps > max_case_steps:
            max_case_steps = interpreter.steps
        if not case_passed:
            failures.append(index)

        results.append({"value": actual_int} if actual_int is not None else {"error": error_label})
        row: dict[str, object] = {
            "case": index,
            "function": fn_name,
            "passed": case_passed,
            "expected": expected,
            "steps": interpreter.steps,
        }
        if actual_int is not None:
            row["actual"] = actual_int
        if error_label is not None:
            row["error"] = error_label
        case_results.append(row)

    unchanged_files = [
        name
        for name in APPROVED_FILES
        if candidate_snapshot.file_digests[name] == base_snapshot.file_digests[name]
    ]
    passed = len(failures) == 0 and (not require_all_files_changed or len(unchanged_files) == 0)

    attestation: dict[str, object] = {
        "scope": VERIFIER_SCOPE,
        "target": VERIFIER_TARGET,
        "verifier": VERIFIER_VERSION,
        "entryPointDisconnected": True,
        # Caller-visible gate flag for verified-patch.mjs; provenance requires verify_attestation().
        "trusted": True,
        "passed": passed,
        "claimId": claim_id,
        "scopeHash": scope_hash,
        "claimScope": canonical_scope,
        "baseRevision": base_revision,
        "baseFileDigests": dict(base_snapshot.file_digests),
        "baseTreeSha256": base_snapshot.tree_sha256,
        "casesDigest": CASES_DIGEST,
        "totalCases": len(CASES),
        "passedCases": len(CASES) - len(failures),
        "failures": failures,
        "results": results,
        "caseResults": case_results,
        "fileDigests": dict(candidate_snapshot.file_digests),
        "treeSha256": candidate_snapshot.tree_sha256,
        "unchangedFiles": unchanged_files,
        "workBounds": {
            "maxFileBytes": MAX_FILE_BYTES,
            "maxAstNodes": MAX_AST_NODES,
            "maxAstDepth": MAX_AST_DEPTH,
            "maxStepsPerCase": MAX_STEPS_PER_CASE,
            "maxIntAbs": MAX_INT_ABS,
            "maxStrLen": MAX_STR_LEN,
        },
        "workObserved": {
            "astNodes": {
                "limits.py": limits_mod.node_count,
                "measurement.py": measurement_mod.node_count,
            },
            "astDepth": {
                "limits.py": limits_mod.max_depth,
                "measurement.py": measurement_mod.max_depth,
            },
            "maxCaseSteps": max_case_steps,
        },
        "provenance": {
            "claimBound": True,
            "invocationNonce": invocation_nonce,
        },
    }
    attestation["provenance"]["hmacSha256"] = _compute_attestation_hmac(attestation, attestation_key)
    return attestation


def verify_attestation(
    attestation: Mapping[str, object],
    *,
    expected_claim: Mapping[str, object],
    expected_invocation_nonce: str,
    attestation_key: bytes,
    require_all_files_changed: bool = True,
) -> None:
    """Verify full attestation provenance, HMAC binding, claim scope, and complete case rows."""
    _validate_invocation_inputs(expected_invocation_nonce, attestation_key)
    if not isinstance(attestation, Mapping):
        raise InvalidInputError("Attestation must be a mapping.")
    if attestation.get("scope") != VERIFIER_SCOPE or attestation.get("entryPointDisconnected") is not True:
        raise InvalidInputError("Attestation scope metadata mismatch.")
    if attestation.get("trusted") is not True or type(attestation.get("passed")) is not bool:
        raise InvalidInputError("Attestation gate flags are invalid.")

    passed = attestation["passed"]
    base_digests = attestation.get("baseFileDigests")
    if not isinstance(base_digests, Mapping) or tuple(sorted(base_digests.keys())) != APPROVED_FILES:
        raise InvalidInputError("Attestation baseFileDigests missing or invalid.")
    for name in APPROVED_FILES:
        if type(base_digests[name]) is not str or not HEX_SHA256_RE.fullmatch(base_digests[name]):
            raise InvalidInputError(f"Invalid base digest for {name}.")
    expected_base_tree = _json_sha256([[name, base_digests[name]] for name in APPROVED_FILES])
    if attestation.get("baseTreeSha256") != expected_base_tree:
        raise InvalidInputError("Attestation baseTreeSha256 mismatch.")

    # Validate claim binding against expected_claim and attestation claim fields.
    if not isinstance(expected_claim, Mapping):
        raise InvalidInputError("expected_claim must be a mapping.")
    if attestation.get("claimId") != expected_claim.get("claimId"):
        raise InvalidInputError("Attestation claimId mismatch.")
    if attestation.get("scopeHash") != expected_claim.get("scopeHash"):
        raise InvalidInputError("Attestation scopeHash mismatch.")
    att_scope = attestation.get("claimScope")
    exp_scope = expected_claim.get("scope")
    if not isinstance(att_scope, Mapping) or not isinstance(exp_scope, Mapping):
        raise InvalidInputError("Attestation claimScope missing.")
    if _canonical_json(dict(att_scope)) != _canonical_json(dict(exp_scope)):
        raise InvalidInputError("Attestation claimScope differs from expected controller claim.")
    if attestation.get("baseRevision") != exp_scope.get("baseRevision"):
        raise InvalidInputError("Attestation baseRevision mismatch.")
    if attestation.get("casesDigest") != CASES_DIGEST or exp_scope.get("casesDigest") != CASES_DIGEST:
        raise InvalidInputError("Attestation casesDigest mismatch.")
    if exp_scope.get("baseFileDigests") != dict(base_digests):
        raise InvalidInputError("Attestation baseFileDigests differs from expected claim.")
    if _json_sha256(dict(att_scope)) != attestation.get("scopeHash"):
        raise InvalidInputError("Attestation scopeHash does not match claimScope digest.")

    # Verify HMAC provenance and invocation nonce.
    prov = attestation.get("provenance")
    if not isinstance(prov, Mapping) or prov.get("claimBound") is not True:
        raise InvalidInputError("Attestation provenance missing claimBound=True.")
    if prov.get("invocationNonce") != expected_invocation_nonce:
        raise InvalidInputError("Attestation invocationNonce mismatch.")
    mac = prov.get("hmacSha256")
    if type(mac) is not str or not HEX_SHA256_RE.fullmatch(mac):
        raise InvalidInputError("Attestation provenance HMAC missing or malformed.")
    expected_mac = _compute_attestation_hmac(attestation, attestation_key)
    if not hmac.compare_digest(mac, expected_mac):
        raise InvalidInputError("Attestation provenance HMAC verification failed.")

    # Verify file digests and unchanged check.
    file_digests = attestation.get("fileDigests")
    if not isinstance(file_digests, Mapping) or tuple(sorted(file_digests.keys())) != APPROVED_FILES:
        raise InvalidInputError("Attestation fileDigests invalid.")
    for name in APPROVED_FILES:
        if type(file_digests[name]) is not str or not HEX_SHA256_RE.fullmatch(file_digests[name]):
            raise InvalidInputError(f"Invalid file digest for {name}.")
    expected_tree = _json_sha256([[name, file_digests[name]] for name in APPROVED_FILES])
    if attestation.get("treeSha256") != expected_tree:
        raise InvalidInputError("Attestation treeSha256 mismatch.")
    unchanged = [name for name in APPROVED_FILES if file_digests[name] == base_digests[name]]
    if attestation.get("unchangedFiles") != unchanged:
        raise InvalidInputError("Attestation unchangedFiles inconsistent.")

    # Verify complete, consistent results and caseResults rows.
    total_cases = attestation.get("totalCases")
    passed_cases = attestation.get("passedCases")
    failures = attestation.get("failures")
    results = attestation.get("results")
    case_results = attestation.get("caseResults")
    if type(total_cases) is not int or total_cases != len(CASES):
        raise InvalidInputError("Attestation totalCases mismatch.")
    if type(passed_cases) is not int or not 0 <= passed_cases <= total_cases:
        raise InvalidInputError("Attestation passedCases out of range.")
    if not isinstance(failures, list) or any(type(i) is not int for i in failures):
        raise InvalidInputError("Attestation failures invalid.")
    if not isinstance(results, list) or len(results) != total_cases:
        raise InvalidInputError("Attestation results must contain all case rows.")
    if not isinstance(case_results, list) or len(case_results) != total_cases:
        raise InvalidInputError("Attestation caseResults must contain all case rows.")

    observed_failures: list[int] = []
    for idx, (fn_name, _arg, expected) in enumerate(CASES, start=1):
        row = case_results[idx - 1]
        res = results[idx - 1]
        if not isinstance(row, Mapping) or not isinstance(res, Mapping):
            raise InvalidInputError(f"Malformed case row at {idx}.")
        if row.get("case") != idx or row.get("function") != fn_name or row.get("expected") != expected:
            raise InvalidInputError(f"Case row metadata mismatch at {idx}.")
        row_steps = row.get("steps")
        if type(row_steps) is not int or not 0 <= row_steps <= MAX_STEPS_PER_CASE:
            raise InvalidInputError(f"Case row steps invalid at {idx}.")
        row_passed = row.get("passed")
        if type(row_passed) is not bool:
            raise InvalidInputError(f"Case row passed flag invalid at {idx}.")
        if row_passed:
            if tuple(res.keys()) != ("value",) or type(res.get("value")) is not int or res["value"] != expected:
                raise InvalidInputError(f"Passing case result mismatch at {idx}.")
            if type(row.get("actual")) is not int or row["actual"] != expected or "error" in row:
                raise InvalidInputError(f"Passing caseResults actual/error mismatch at {idx}.")
        else:
            observed_failures.append(idx)
            if passed:
                raise InvalidInputError(f"Failed case {idx} present in passing attestation.")
            if tuple(res.keys()) == ("value",):
                res_val = res.get("value")
                if (
                    type(res_val) is not int
                    or abs(res_val) > MAX_INT_ABS
                    or res_val == expected
                    or row.get("actual") != res_val
                    or row.get("error") != "value_mismatch"
                ):
                    raise InvalidInputError(f"Failing value row inconsistent at {idx}.")
            elif tuple(res.keys()) == ("error",):
                res_err = res.get("error")
                if type(res_err) is not str or not res_err or row.get("error") != res_err or "actual" in row:
                    raise InvalidInputError(f"Failing error row inconsistent at {idx}.")
            else:
                raise InvalidInputError(f"Malformed failing result entry at {idx}.")

    if failures != observed_failures or passed_cases + len(failures) != total_cases:
        raise InvalidInputError("Attestation failures list inconsistent with caseResults.")
    if passed and (failures or (require_all_files_changed and unchanged)):
        raise InvalidInputError("Attestation marked passed=True despite failures or unchanged files.")


def write_attestation_file(
    output_path: str | Path,
    attestation: Mapping[str, object],
    *,
    expected_claim: Mapping[str, object],
    expected_invocation_nonce: str,
    attestation_key: bytes,
    require_all_files_changed: bool = True,
) -> Path:
    """Persist a verified attestation exclusively (never overwrites existing files)."""
    verify_attestation(
        attestation,
        expected_claim=expected_claim,
        expected_invocation_nonce=expected_invocation_nonce,
        attestation_key=attestation_key,
        require_all_files_changed=require_all_files_changed,
    )
    target = Path(output_path)
    if target.is_symlink():
        raise InvalidInputError("Refusing to write attestation through a symlink.")
    payload = (json.dumps(attestation, indent=2) + "\n").encode("utf-8")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(target, flags, 0o600)
    try:
        view = memoryview(payload)
        written = 0
        while written < len(payload):
            written += os.write(fd, view[written:])
        os.fsync(fd)
    finally:
        os.close(fd)
    return target


def _decode_b64_snapshot(raw_map: object, *, label: str) -> FileSnapshot:
    if not isinstance(raw_map, Mapping) or tuple(sorted(raw_map.keys())) != APPROVED_FILES:
        raise InvalidInputError(f"{label} must contain base64 entries for {APPROVED_FILES}.")
    decoded: dict[str, bytes] = {}
    for name in APPROVED_FILES:
        b64_val = raw_map[name]
        if type(b64_val) is not str:
            raise InvalidInputError(f"{label}[{name}] must be a base64 string.")
        try:
            decoded[name] = base64.b64decode(b64_val.encode("ascii"), validate=True)
        except (UnicodeEncodeError, binascii.Error) as error:
            raise InvalidInputError(f"{label}[{name}] invalid base64 payload.") from error
    return freeze_file_snapshot(decoded, label=label)


def _read_bounded_key_fd(fd: int, *, label: str) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while total <= MAX_HMAC_KEY_BYTES:
        chunk = os.read(fd, MAX_HMAC_KEY_BYTES + 1 - total)
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
    key_bytes = b"".join(chunks)
    if len(key_bytes) < MIN_HMAC_KEY_BYTES or len(key_bytes) > MAX_HMAC_KEY_BYTES:
        raise InvalidInputError(
            f"{label} must be {MIN_HMAC_KEY_BYTES}..{MAX_HMAC_KEY_BYTES} bytes."
        )
    return key_bytes


def _read_key_from_fd(key_fd: int) -> bytes:
    if key_fd < 3:
        raise InvalidInputError("--key-fd must reference a non-stdio file descriptor (>= 3).")
    try:
        st = os.fstat(key_fd)
        if not (stat.S_ISFIFO(st.st_mode) or stat.S_ISREG(st.st_mode)):
            raise InvalidInputError("--key-fd must reference a pipe or regular file.")
        return _read_bounded_key_fd(key_fd, label="Attestation key")
    except OSError as error:
        raise InvalidInputError(f"Failed reading attestation key from fd {key_fd}: {error}") from error


def _read_key_from_file(key_path: str | Path) -> bytes:
    path = Path(key_path)
    try:
        lst = path.lstat()
    except OSError as error:
        raise InvalidInputError(f"Failed stating attestation key file: {error}") from error
    if stat.S_ISLNK(lst.st_mode) or not stat.S_ISREG(lst.st_mode):
        raise InvalidInputError("--key-file must reference a regular non-symlink file.")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError as error:
        raise InvalidInputError(f"Failed opening attestation key file: {error}") from error
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode) or fst.st_ino != lst.st_ino or fst.st_dev != lst.st_dev:
            raise InvalidInputError("--key-file changed or is not a regular file.")
        if os.name == "posix" and (stat.S_IMODE(fst.st_mode) & 0o077) != 0:
            raise InvalidInputError("--key-file permissions must not grant group or other access.")
        return _read_bounded_key_fd(fd, label="Attestation key")
    except OSError as error:
        raise InvalidInputError(f"Failed reading attestation key file: {error}") from error
    finally:
        os.close(fd)


def _emit_cli_error(error_type: str, message: str) -> None:
    print(
        _canonical_json(
            {
                "scope": VERIFIER_SCOPE,
                "trusted": False,
                "passed": False,
                "errorType": error_type,
                "error": message,
            }
        ),
        flush=True,
    )


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Disconnected fixed-synthetic protected fixture verifier (immutable stdin snapshot)."
    )
    key_group = parser.add_mutually_exclusive_group(required=True)
    key_group.add_argument("--key-fd", type=int, help="Open fd (>=3) supplying controller HMAC key")
    key_group.add_argument("--key-file", help="Controller-owned private key file (0600 on POSIX)")
    parser.add_argument("--output", help="Optional new file path for exclusive attestation write")
    parser.add_argument(
        "--allow-unchanged",
        action="store_true",
        help="Allow passing attestation when candidate bytes equal base bytes",
    )
    args = parser.parse_args(argv)

    try:
        key_bytes = (
            _read_key_from_fd(args.key_fd)
            if args.key_fd is not None
            else _read_key_from_file(args.key_file)
        )
        raw_stdin = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
        if not raw_stdin or len(raw_stdin) > MAX_STDIN_BYTES:
            raise InvalidInputError(f"Stdin snapshot payload must be 1..{MAX_STDIN_BYTES} bytes.")
        try:
            envelope = json.loads(raw_stdin.decode("utf-8", errors="strict"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise InvalidInputError(f"Invalid stdin JSON snapshot: {error}") from error
        if not isinstance(envelope, dict):
            raise InvalidInputError("Stdin payload must be a JSON object.")

        candidate_snapshot = _decode_b64_snapshot(
            envelope.get("candidateFilesBase64"), label="candidateFilesBase64"
        )
        base_snapshot = _decode_b64_snapshot(
            envelope.get("baseFilesBase64"), label="baseFilesBase64"
        )
        claim = envelope.get("claim")
        invocation_nonce = envelope.get("invocationNonce")
        require_changed = not args.allow_unchanged

        attestation = verify_fixture_snapshot(
            candidate_snapshot,
            base_snapshot=base_snapshot,
            claim=claim,
            invocation_nonce=invocation_nonce,
            attestation_key=key_bytes,
            require_all_files_changed=require_changed,
        )
        if args.output:
            try:
                write_attestation_file(
                    args.output,
                    attestation,
                    expected_claim=claim,
                    expected_invocation_nonce=invocation_nonce,
                    attestation_key=key_bytes,
                    require_all_files_changed=require_changed,
                )
            except OSError as error:
                raise InvalidInputError(f"Failed writing exclusive attestation file: {error}") from error
    except InvalidInputError as error:
        _emit_cli_error("invalid_input", str(error))
        return 2
    except UnsupportedSyntaxError as error:
        _emit_cli_error("unsupported_syntax", str(error))
        return 3
    except ExecutionLimitError as error:
        _emit_cli_error("execution_limit", str(error))
        return 4
    except VerifierError as error:
        _emit_cli_error("verifier_error", str(error))
        return 4

    print(_canonical_json(attestation), flush=True)
    return 0 if attestation["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(_main())
