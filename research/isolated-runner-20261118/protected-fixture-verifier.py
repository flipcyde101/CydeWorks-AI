"""Trusted allowlisted AST verifier for the fixed synthetic limits/measurement fixture.

Scope: fixed synthetic only (limits.py + measurement.py).
Entry point status: disconnected standalone module; not wired into pilot.mjs,
guest.py, sandbox.py, or harness/ until integration review.

Trust model:
- Treats candidate proposal bytes as untrusted data.
- Never imports, compiles, evals, or executes candidate-supplied Python code.
- Parses with ast.parse() only and rejects every AST node outside a minimal
  allowlist covering bounded arithmetic, comparisons, if/return, try/except on
  (TypeError, ValueError), and known pure helpers (int, min, max, abs, isinstance).
- Evaluates the fixed pilot CASES against a trusted oracle under strict work
  bounds and writes an attestation aligned with verified-patch.mjs.
"""

from __future__ import annotations

import argparse
import ast
from collections.abc import Mapping
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys


VERIFIER_SCOPE = "fixed-synthetic-only"
VERIFIER_TARGET = "limits.py+measurement.py"
VERIFIER_VERSION = "protected-fixture-verifier-ast-v1"
APPROVED_FILES = ("limits.py", "measurement.py")

MAX_FILE_BYTES = 8192
MAX_AST_NODES = 256
MAX_AST_DEPTH = 32
MAX_STEPS_PER_CASE = 256
MAX_CALL_DEPTH = 8
MAX_INT_ABS = 10**18
MAX_STR_LEN = 64
MAX_DOCSTRING_LEN = 512

CLAIM_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
HEX_REV_RE = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
HEX_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SAFE_IDENT_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")

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
            return 0
        try:
            converted = int(raw)
        except ValueError:
            return 0
    else:
        return 0
    return trusted_oracle_clamp(converted)


def _verify_oracle_matches_cases() -> None:
    for index, (fn_name, arg, expected) in enumerate(CASES, start=1):
        if fn_name == "clamp":
            actual = trusted_oracle_clamp(arg)
        elif fn_name == "normalize":
            actual = trusted_oracle_normalize(arg)
        else:
            raise AssertionError(f"Unknown case function in CASES at {index}: {fn_name}")
        if type(actual) is not int or actual != expected:
            raise AssertionError(f"Oracle mismatch at case {index}: {actual!r} != {expected!r}")


_verify_oracle_matches_cases()


class VerifierError(Exception):
    """Base error for protected fixture verification failures."""


class InvalidInputError(VerifierError, ValueError):
    """Raised when proposal bytes, paths, or claim metadata fail validation."""


class UnsupportedSyntaxError(VerifierError, ValueError):
    """Raised when candidate source contains syntax or AST nodes outside the allowlist."""


class ExecutionLimitError(VerifierError, RuntimeError):
    """Raised when candidate AST evaluation exceeds bounded work limits."""


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
class ValidatedModule:
    filename: str
    tree: ast.Module
    assignments: tuple[ast.Assign, ...]
    function_def: ast.FunctionDef
    param_name: str
    node_count: int
    max_depth: int


_ALLOWED_BINOPS = (ast.Add, ast.Sub, ast.Mult, ast.FloorDiv, ast.Mod)
_ALLOWED_UNARYOPS = (ast.UAdd, ast.USub, ast.Not)
_ALLOWED_BOOLOPS = (ast.And, ast.Or)
_ALLOWED_CMPOPS = (ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.Is, ast.IsNot)


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
        self._in_function = False
        self.allowed_calls = frozenset(
            {*PURE_HELPER_NAMES, "clamp"}
            if filename == "limits.py"
            else {*PURE_HELPER_NAMES, "clamp", "normalize"}
        )

    def _enter(self, node: ast.AST, depth: int) -> None:
        self.node_count += 1
        if self.node_count > MAX_AST_NODES:
            raise UnsupportedSyntaxError(
                f"{self.filename} exceeds max AST node count ({MAX_AST_NODES})."
            )
        if depth > MAX_AST_DEPTH:
            raise UnsupportedSyntaxError(
                f"{self.filename} exceeds max AST depth ({MAX_AST_DEPTH})."
            )
        if depth > self.max_depth:
            self.max_depth = depth

    def validate_module(self, tree: ast.AST) -> ValidatedModule:
        if type(tree) is not ast.Module:
            raise UnsupportedSyntaxError(f"{self.filename} must parse as an ast.Module.")
        if getattr(tree, "type_ignores", []):
            raise UnsupportedSyntaxError(f"{self.filename} cannot contain type_ignores.")
        self._enter(tree, 1)
        if not tree.body:
            raise UnsupportedSyntaxError(f"{self.filename} has an empty module body.")

        expected_fn = "clamp" if self.filename == "limits.py" else "normalize"
        saw_import = False
        function_def: ast.FunctionDef | None = None
        assignments: list[ast.Assign] = []

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
            if stmt_type is ast.Assign:
                self._validate_assign(stmt, 2)
                assignments.append(stmt)
                continue
            if stmt_type is ast.FunctionDef:
                if function_def is not None or stmt.name != expected_fn:
                    raise UnsupportedSyntaxError(
                        f"{self.filename} must define only {expected_fn}()."
                    )
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
            tree=tree,
            assignments=tuple(assignments),
            function_def=function_def,
            param_name=param_name,
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
            raise UnsupportedSyntaxError(f"Decorators, return annotations, and type params are rejected.")
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
            raise UnsupportedSyntaxError(
                f"{node.name} must accept exactly one positional parameter."
            )
        arg = args.args[0]
        if type(arg) is not ast.arg or arg.annotation is not None or getattr(arg, "type_comment", None) is not None:
            raise UnsupportedSyntaxError("Parameter annotations are rejected.")
        self._enter(arg, depth + 2)
        _check_identifier(arg.arg, allow_reserved=False, context="parameter")
        if not node.body:
            raise UnsupportedSyntaxError(f"{node.name} body cannot be empty.")
        self._in_function = True
        try:
            self._validate_stmt_list(node.body, depth + 1, allow_docstring=True)
        finally:
            self._in_function = False

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
            if node.finalbody or not node.handlers:
                raise UnsupportedSyntaxError("Try requires except handlers and no finally block.")
            self._validate_stmt_list(node.body, depth + 1)
            for handler in node.handlers:
                self._validate_except_handler(handler, depth + 1)
            if node.orelse:
                self._validate_stmt_list(node.orelse, depth + 1)
            return
        if node_type is ast.Assign:
            self._validate_assign(node, depth)
            return
        if node_type is ast.AugAssign:
            self._validate_aug_assign(node, depth)
            return
        if node_type is ast.Pass:
            self._enter(node, depth)
            return
        raise UnsupportedSyntaxError(
            f"Unsupported statement node {node_type.__name__} in {self.filename}."
        )

    def _validate_except_handler(self, handler: ast.ExceptHandler, depth: int) -> None:
        if type(handler) is not ast.ExceptHandler:
            raise UnsupportedSyntaxError("Invalid exception handler.")
        self._enter(handler, depth)
        if handler.type is None:
            raise UnsupportedSyntaxError("Bare except clauses are rejected.")
        exc_type = handler.type
        if type(exc_type) is ast.Name:
            self._enter(exc_type, depth + 1)
            if type(exc_type.ctx) is not ast.Load or exc_type.id not in ALLOWED_EXCEPTION_NAMES:
                raise UnsupportedSyntaxError(
                    f"Unsupported exception type {exc_type.id!r}; only TypeError/ValueError allowed."
                )
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
                    raise UnsupportedSyntaxError(
                        "Except tuple elements must be TypeError or ValueError."
                    )
                self._enter(elt, depth + 2)
        else:
            raise UnsupportedSyntaxError(
                f"Unsupported except type expression {type(exc_type).__name__}."
            )
        if handler.name is not None:
            _check_identifier(handler.name, allow_reserved=False, context="except target")
        self._validate_stmt_list(handler.body, depth + 1)

    def _validate_assign(self, node: ast.Assign, depth: int) -> None:
        self._enter(node, depth)
        if getattr(node, "type_comment", None) is not None:
            raise UnsupportedSyntaxError("Type comments are rejected.")
        if len(node.targets) != 1:
            raise UnsupportedSyntaxError("Chained assignment targets are rejected.")
        target = node.targets[0]
        if type(target) is not ast.Name or type(target.ctx) is not ast.Store:
            raise UnsupportedSyntaxError("Assignment target must be a simple variable name.")
        self._enter(target, depth + 1)
        _check_identifier(target.id, allow_reserved=False, context="assignment target")
        self._validate_expr(node.value, depth + 1)

    def _validate_aug_assign(self, node: ast.AugAssign, depth: int) -> None:
        self._enter(node, depth)
        if type(node.target) is not ast.Name or type(node.target.ctx) is not ast.Store:
            raise UnsupportedSyntaxError("Augmented assignment target must be a simple name.")
        self._enter(node.target, depth + 1)
        _check_identifier(node.target.id, allow_reserved=False, context="aug-assignment target")
        if type(node.op) not in _ALLOWED_BINOPS:
            raise UnsupportedSyntaxError(
                f"Unsupported augmented operator {type(node.op).__name__}."
            )
        self._enter(node.op, depth + 1)
        self._validate_expr(node.value, depth + 1)

    def _validate_isinstance_type_arg(self, node: ast.expr, depth: int) -> None:
        if type(node) is ast.Name:
            self._enter(node, depth)
            if type(node.ctx) is not ast.Load or node.id not in ALLOWED_TYPE_NAMES:
                raise UnsupportedSyntaxError(
                    f"Unsupported isinstance target type {node.id!r}."
                )
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
                    raise UnsupportedSyntaxError(
                        "isinstance tuple elements must be int, str, or bool."
                    )
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
                raise UnsupportedSyntaxError(
                    f"Unsupported constant type {val_type.__name__}."
                )
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
                raise UnsupportedSyntaxError(
                    f"Unsupported unary operator {type(node.op).__name__}."
                )
            self._enter(node.op, depth + 1)
            self._validate_expr(node.operand, depth + 1)
            return
        if node_type is ast.BinOp:
            self._enter(node, depth)
            if type(node.op) not in _ALLOWED_BINOPS:
                raise UnsupportedSyntaxError(
                    f"Unsupported binary operator {type(node.op).__name__}."
                )
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
            for op, comp in zip(node.ops, node.comparators):
                if type(op) not in _ALLOWED_CMPOPS:
                    raise UnsupportedSyntaxError(
                        f"Unsupported comparison operator {type(op).__name__}."
                    )
                self._enter(op, depth + 1)
                self._validate_expr(comp, depth + 1)
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
                raise UnsupportedSyntaxError(
                    f"Call to unallowlisted function {callee!r} is rejected."
                )
            if not self._in_function and callee in ("clamp", "normalize"):
                raise UnsupportedSyntaxError(
                    f"Top-level assignment cannot call {callee!r}."
                )
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
                for arg in node.args:
                    self._validate_expr(arg, depth + 1)
            return
        raise UnsupportedSyntaxError(
            f"Unsupported expression node {node_type.__name__} in {self.filename}."
        )


def parse_allowlisted_module(source_bytes: bytes, filename: str) -> ValidatedModule:
    """Parse and validate untrusted source bytes against the allowlisted AST subset."""
    if filename not in APPROVED_FILES:
        raise InvalidInputError(f"Unsupported fixture filename: {filename!r}")
    if type(source_bytes) is not bytes:
        raise InvalidInputError(f"{filename} source must be raw bytes.")
    if len(source_bytes) == 0 or len(source_bytes) > MAX_FILE_BYTES:
        raise InvalidInputError(f"{filename} byte length must be between 1 and {MAX_FILE_BYTES}.")
    if b"\x00" in source_bytes:
        raise InvalidInputError(f"{filename} contains a NUL byte.")
    try:
        source_text = source_bytes.decode("utf-8", errors="strict")
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
    """Pure AST interpreter enforcing step, call-depth, and value bounds."""

    _BUILTINS = {
        "int": int,
        "str": str,
        "bool": bool,
    }

    def __init__(self, limits_mod: ValidatedModule, measurement_mod: ValidatedModule) -> None:
        self.limits_mod = limits_mod
        self.measurement_mod = measurement_mod
        self.steps = 0
        self.call_depth = 0
        self.max_call_depth = 0
        self.limits_globals: dict[str, object] = {}
        self.measurement_globals: dict[str, object] = {}
        for stmt in limits_mod.assignments:
            self._exec_assign(stmt, self.limits_globals)
        for stmt in measurement_mod.assignments:
            self._exec_assign(stmt, self.measurement_globals)

    def _tick(self) -> None:
        self.steps += 1
        if self.steps > MAX_STEPS_PER_CASE:
            raise ExecutionLimitError(
                f"Case exceeded step budget ({MAX_STEPS_PER_CASE})."
            )

    @staticmethod
    def _check_int_bound(value: int) -> int:
        if abs(value) > MAX_INT_ABS:
            raise ExecutionLimitError(
                f"Integer result exceeded magnitude bound ({MAX_INT_ABS})."
            )
        return value

    def invoke(self, fn_name: str, arg: object) -> object:
        if fn_name == "clamp":
            return self._call_user_fn(self.limits_mod, self.limits_globals, arg)
        if fn_name == "normalize":
            return self._call_user_fn(self.measurement_mod, self.measurement_globals, arg)
        raise InvalidInputError(f"Unknown fixture entry function: {fn_name!r}")

    def _call_user_fn(
        self, module: ValidatedModule, mod_globals: dict[str, object], arg: object
    ) -> object:
        self._tick()
        self.call_depth += 1
        if self.call_depth > MAX_CALL_DEPTH:
            raise ExecutionLimitError(
                f"Call depth exceeded bound ({MAX_CALL_DEPTH})."
            )
        if self.call_depth > self.max_call_depth:
            self.max_call_depth = self.call_depth
        locals_env: dict[str, object] = {module.param_name: arg}
        try:
            self._exec_block(module.function_def.body, locals_env, mod_globals, module.filename)
            return None
        except _ReturnSignal as ret:
            return ret.value
        finally:
            self.call_depth -= 1

    def _exec_block(
        self,
        stmts: list[ast.stmt],
        locals_env: dict[str, object],
        mod_globals: dict[str, object],
        filename: str,
    ) -> None:
        for index, stmt in enumerate(stmts):
            if index == 0 and _is_docstring_expr(stmt):
                continue
            self._exec_stmt(stmt, locals_env, mod_globals, filename)

    def _exec_stmt(
        self,
        stmt: ast.stmt,
        locals_env: dict[str, object],
        mod_globals: dict[str, object],
        filename: str,
    ) -> None:
        self._tick()
        stmt_type = type(stmt)
        if stmt_type is ast.Pass:
            return
        if stmt_type is ast.Return:
            value = (
                self._eval_expr(stmt.value, locals_env, mod_globals, filename)
                if stmt.value is not None
                else None
            )
            raise _ReturnSignal(value)
        if stmt_type is ast.Assign:
            self._exec_assign(stmt, locals_env, mod_globals, filename)
            return
        if stmt_type is ast.AugAssign:
            target = stmt.target.id
            current = self._lookup(target, locals_env, mod_globals)
            rhs = self._eval_expr(stmt.value, locals_env, mod_globals, filename)
            locals_env[target] = self._apply_binop(stmt.op, current, rhs)
            return
        if stmt_type is ast.If:
            cond = self._eval_expr(stmt.test, locals_env, mod_globals, filename)
            if bool(cond):
                self._exec_block(stmt.body, locals_env, mod_globals, filename)
            elif stmt.orelse:
                self._exec_block(stmt.orelse, locals_env, mod_globals, filename)
            return
        if stmt_type is ast.Try:
            try:
                self._exec_block(stmt.body, locals_env, mod_globals, filename)
            except _GuestException as guest_exc:
                matched = self._match_handler(stmt.handlers, guest_exc.exc_name)
                if matched is None:
                    raise
                if matched.name is not None:
                    locals_env[matched.name] = guest_exc.exc_name
                self._exec_block(matched.body, locals_env, mod_globals, filename)
                return
            if stmt.orelse:
                self._exec_block(stmt.orelse, locals_env, mod_globals, filename)
            return
        raise UnsupportedSyntaxError(f"Unsupported runtime statement {stmt_type.__name__}.")

    def _exec_assign(
        self,
        stmt: ast.Assign,
        locals_env: dict[str, object],
        mod_globals: dict[str, object] | None = None,
        filename: str = "limits.py",
    ) -> None:
        target = stmt.targets[0].id
        value = self._eval_expr(
            stmt.value,
            locals_env,
            mod_globals if mod_globals is not None else locals_env,
            filename,
        )
        locals_env[target] = value

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

    def _lookup(
        self,
        name: str,
        locals_env: dict[str, object],
        mod_globals: dict[str, object],
    ) -> object:
        if name in locals_env:
            return locals_env[name]
        if name in mod_globals:
            return mod_globals[name]
        if name in self._BUILTINS:
            return self._BUILTINS[name]
        raise _GuestException("NameError", f"Undefined name {name!r}")

    def _eval_expr(
        self,
        node: ast.expr,
        locals_env: dict[str, object],
        mod_globals: dict[str, object],
        filename: str,
    ) -> object:
        self._tick()
        node_type = type(node)
        if node_type is ast.Constant:
            return node.value
        if node_type is ast.Name:
            return self._lookup(node.id, locals_env, mod_globals)
        if node_type is ast.UnaryOp:
            operand = self._eval_expr(node.operand, locals_env, mod_globals, filename)
            op_type = type(node.op)
            if op_type is ast.Not:
                return not bool(operand)
            if not isinstance(operand, int):
                raise _GuestException("TypeError", "Unary arithmetic requires int.")
            res = +operand if op_type is ast.UAdd else -operand
            return self._check_int_bound(res)
        if node_type is ast.BinOp:
            left = self._eval_expr(node.left, locals_env, mod_globals, filename)
            right = self._eval_expr(node.right, locals_env, mod_globals, filename)
            return self._apply_binop(node.op, left, right)
        if node_type is ast.BoolOp:
            op_type = type(node.op)
            result: object = None
            for expr in node.values:
                result = self._eval_expr(expr, locals_env, mod_globals, filename)
                if op_type is ast.And and not bool(result):
                    return result
                if op_type is ast.Or and bool(result):
                    return result
            return result
        if node_type is ast.Compare:
            left = self._eval_expr(node.left, locals_env, mod_globals, filename)
            for op, comp in zip(node.ops, node.comparators):
                right = self._eval_expr(comp, locals_env, mod_globals, filename)
                if not self._apply_cmp(op, left, right):
                    return False
                left = right
            return True
        if node_type is ast.IfExp:
            cond = self._eval_expr(node.test, locals_env, mod_globals, filename)
            branch = node.body if bool(cond) else node.orelse
            return self._eval_expr(branch, locals_env, mod_globals, filename)
        if node_type is ast.Call:
            callee = node.func.id
            if callee == "isinstance":
                arg_val = self._eval_expr(node.args[0], locals_env, mod_globals, filename)
                type_node = node.args[1]
                if type(type_node) is ast.Name:
                    return isinstance(arg_val, self._BUILTINS[type_node.id])
                types_tuple = tuple(self._BUILTINS[elt.id] for elt in type_node.elts)
                return isinstance(arg_val, types_tuple)
            args = [self._eval_expr(arg, locals_env, mod_globals, filename) for arg in node.args]
            return self._call_allowed_function(callee, args, filename)
        raise UnsupportedSyntaxError(f"Unsupported runtime expression {node_type.__name__}.")

    def _apply_binop(self, op: ast.operator, left: object, right: object) -> int:
        if not isinstance(left, int) or not isinstance(right, int):
            raise _GuestException("TypeError", "Arithmetic requires integer operands.")
        op_type = type(op)
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
            for item in args:
                if not isinstance(item, int):
                    raise _GuestException("TypeError", f"{callee}() requires integer arguments.")
            return min(args) if callee == "min" else max(args)
        if callee == "abs":
            if len(args) != 1 or not isinstance(args[0], int):
                raise _GuestException("TypeError", "abs() requires one integer argument.")
            return self._check_int_bound(abs(args[0]))
        if callee == "clamp":
            if len(args) != 1:
                raise _GuestException("TypeError", "clamp() takes exactly 1 argument.")
            return self._call_user_fn(self.limits_mod, self.limits_globals, args[0])
        if callee == "normalize" and filename == "measurement.py":
            if len(args) != 1:
                raise _GuestException("TypeError", "normalize() takes exactly 1 argument.")
            return self._call_user_fn(self.measurement_mod, self.measurement_globals, args[0])
        raise UnsupportedSyntaxError(f"Disallowed call target {callee!r} in {filename}.")

    def _pure_int(self, arg: object) -> int:
        arg_type = type(arg)
        if arg_type is int:
            return self._check_int_bound(arg)
        if arg_type is bool:
            return 1 if arg else 0
        if arg_type is str:
            if len(arg) > MAX_STR_LEN:
                raise _GuestException("ValueError", "int() string exceeds length bound.")
            try:
                parsed = int(arg)
            except ValueError as error:
                raise _GuestException("ValueError", "Invalid integer string.") from error
            return self._check_int_bound(parsed)
        raise _GuestException("TypeError", "int() argument must be a string or integer.")


def compute_sorted_file_digests(files: Mapping[str, bytes]) -> tuple[dict[str, str], str]:
    """Validate raw candidate/base bytes and compute sorted SHA-256 digests."""
    if not isinstance(files, Mapping):
        raise InvalidInputError("Files mapping must be a mapping object.")
    if tuple(sorted(files.keys())) != APPROVED_FILES:
        raise InvalidInputError(f"Files must match exact allowlist {APPROVED_FILES}.")
    digests: dict[str, str] = {}
    for name in APPROVED_FILES:
        raw = files[name]
        if type(raw) is not bytes:
            raise InvalidInputError(f"{name} must be provided as raw bytes.")
        if len(raw) == 0 or len(raw) > MAX_FILE_BYTES:
            raise InvalidInputError(f"{name} byte length out of bounds (1..{MAX_FILE_BYTES}).")
        if b"\x00" in raw:
            raise InvalidInputError(f"{name} contains a NUL byte.")
        try:
            text = raw.decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            raise InvalidInputError(f"{name} is not valid UTF-8.") from error
        if not text.strip():
            raise InvalidInputError(f"{name} cannot be whitespace-only.")
        digests[name] = hashlib.sha256(raw).hexdigest()
    tree_sha256 = _json_sha256([[name, digests[name]] for name in APPROVED_FILES])
    return digests, tree_sha256


def load_candidate_dir(candidate_dir: str | Path) -> dict[str, bytes]:
    """Safely read raw bytes of limits.py and measurement.py from a non-symlink directory."""
    if not isinstance(candidate_dir, (str, Path)):
        raise InvalidInputError("candidate_dir must be a string or Path.")
    raw_dir = str(candidate_dir)
    if not raw_dir or "\x00" in raw_dir:
        raise InvalidInputError("Invalid candidate directory path.")
    base_path = Path(raw_dir)
    try:
        dir_stat = os.lstat(base_path)
    except OSError as error:
        raise InvalidInputError(f"Cannot inspect candidate directory: {error}") from error
    if not stat.S_ISDIR(dir_stat.st_mode) or stat.S_ISLNK(dir_stat.st_mode):
        raise InvalidInputError("candidate_dir must be a non-symlink directory.")
    real_base = os.path.realpath(base_path)

    loaded: dict[str, bytes] = {}
    for name in APPROVED_FILES:
        file_path = os.path.join(real_base, name)
        try:
            file_stat = os.lstat(file_path)
        except OSError as error:
            raise InvalidInputError(f"Missing candidate file {name}: {error}") from error
        if not stat.S_ISREG(file_stat.st_mode) or stat.S_ISLNK(file_stat.st_mode):
            raise InvalidInputError(f"Candidate file {name} must be a regular non-symlink file.")
        real_file = os.path.realpath(file_path)
        if os.path.dirname(real_file) != real_base or os.path.basename(real_file) != name:
            raise InvalidInputError(f"Candidate path escaped directory for {name}.")
        if file_stat.st_size == 0 or file_stat.st_size > MAX_FILE_BYTES:
            raise InvalidInputError(f"Candidate file {name} byte length out of bounds.")
        with open(real_file, "rb") as handle:
            data = handle.read(MAX_FILE_BYTES + 1)
        if len(data) == 0 or len(data) > MAX_FILE_BYTES:
            raise InvalidInputError(f"Candidate file {name} byte length out of bounds.")
        loaded[name] = data
    return loaded


def validate_claim_binding(
    claim_id: str, base_revision: str, expected_cases_digest: str = CASES_DIGEST
) -> None:
    if type(claim_id) is not str or not CLAIM_ID_RE.fullmatch(claim_id):
        raise InvalidInputError("Invalid claim_id format.")
    if type(base_revision) is not str or not HEX_REV_RE.fullmatch(base_revision):
        raise InvalidInputError("Invalid base_revision commit SHA.")
    if type(expected_cases_digest) is not str or not HEX_SHA256_RE.fullmatch(expected_cases_digest):
        raise InvalidInputError("Invalid expected_cases_digest.")
    if expected_cases_digest != CASES_DIGEST:
        raise InvalidInputError(
            "Protected cases digest mismatch; verifier only accepts exact fixed pilot CASES."
        )


def verify_fixture_bytes(
    candidate_files: Mapping[str, bytes],
    *,
    claim_id: str,
    base_revision: str,
    expected_cases_digest: str = CASES_DIGEST,
    base_files: Mapping[str, bytes] | None = None,
    require_all_files_changed: bool = False,
) -> dict[str, object]:
    """Verify raw candidate fixture bytes using the allowlisted AST interpreter."""
    validate_claim_binding(claim_id, base_revision, expected_cases_digest)
    file_digests, tree_sha256 = compute_sorted_file_digests(candidate_files)

    base_digests: dict[str, str] | None = None
    base_tree_sha256: str | None = None
    if base_files is not None:
        base_digests, base_tree_sha256 = compute_sorted_file_digests(base_files)
    elif require_all_files_changed:
        raise InvalidInputError("base_files is required when require_all_files_changed=True.")

    limits_mod = parse_allowlisted_module(candidate_files["limits.py"], "limits.py")
    measurement_mod = parse_allowlisted_module(candidate_files["measurement.py"], "measurement.py")

    failures: list[int] = []
    case_results: list[dict[str, object]] = []
    max_case_steps = 0
    max_case_call_depth = 0

    for index, (fn_name, arg, expected) in enumerate(CASES, start=1):
        interpreter = _BoundedInterpreter(limits_mod, measurement_mod)
        error_label: str | None = None
        actual_int: int | None = None
        case_passed = False
        try:
            actual = interpreter.invoke(fn_name, arg)
            if type(actual) is int and actual == expected:
                actual_int = actual
                case_passed = True
            elif type(actual) is int:
                actual_int = actual
                error_label = "value_mismatch"
            else:
                error_label = f"invalid_return_type:{type(actual).__name__}"
        except _GuestException as guest_exc:
            error_label = f"unhandled_{guest_exc.exc_name}"
        except ExecutionLimitError:
            error_label = "execution_limit_exceeded"

        if interpreter.steps > max_case_steps:
            max_case_steps = interpreter.steps
        if interpreter.max_call_depth > max_case_call_depth:
            max_case_call_depth = interpreter.max_call_depth

        if not case_passed:
            failures.append(index)

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

    unchanged_files: list[str] = []
    if base_digests is not None:
        unchanged_files = [
            name for name in APPROVED_FILES if file_digests[name] == base_digests[name]
        ]

    passed = len(failures) == 0 and (not require_all_files_changed or len(unchanged_files) == 0)
    attestation: dict[str, object] = {
        "scope": VERIFIER_SCOPE,
        "target": VERIFIER_TARGET,
        "verifier": VERIFIER_VERSION,
        "entryPointDisconnected": True,
        "trusted": True,
        "passed": passed,
        "claimId": claim_id,
        "baseRevision": base_revision,
        "casesDigest": CASES_DIGEST,
        "totalCases": len(CASES),
        "passedCases": len(CASES) - len(failures),
        "failures": failures,
        "fileDigests": file_digests,
        "treeSha256": tree_sha256,
        "caseResults": case_results,
        "workBounds": {
            "maxFileBytes": MAX_FILE_BYTES,
            "maxAstNodes": MAX_AST_NODES,
            "maxAstDepth": MAX_AST_DEPTH,
            "maxStepsPerCase": MAX_STEPS_PER_CASE,
            "maxCallDepth": MAX_CALL_DEPTH,
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
            "maxCaseCallDepth": max_case_call_depth,
        },
    }
    if base_digests is not None and base_tree_sha256 is not None:
        attestation["baseFileDigests"] = base_digests
        attestation["baseTreeSha256"] = base_tree_sha256
        attestation["unchangedFiles"] = unchanged_files
    return attestation


def verify_candidate_dir(
    candidate_dir: str | Path,
    *,
    claim_id: str,
    base_revision: str,
    expected_cases_digest: str = CASES_DIGEST,
    base_files: Mapping[str, bytes] | None = None,
    require_all_files_changed: bool = False,
) -> dict[str, object]:
    """Load raw candidate bytes from a directory and run allowlisted verification."""
    candidate_files = load_candidate_dir(candidate_dir)
    return verify_fixture_bytes(
        candidate_files,
        claim_id=claim_id,
        base_revision=base_revision,
        expected_cases_digest=expected_cases_digest,
        base_files=base_files,
        require_all_files_changed=require_all_files_changed,
    )


def validate_attestation_shape(attestation: Mapping[str, object]) -> None:
    """Verify attestation integrity invariants before persisting or trusting."""
    if not isinstance(attestation, Mapping):
        raise InvalidInputError("Attestation must be a mapping.")
    if attestation.get("scope") != VERIFIER_SCOPE:
        raise InvalidInputError("Attestation scope mismatch.")
    if attestation.get("trusted") is not True:
        raise InvalidInputError("Attestation must be marked trusted=True.")
    passed = attestation.get("passed")
    if type(passed) is not bool:
        raise InvalidInputError("Attestation passed must be a bool.")
    validate_claim_binding(
        attestation.get("claimId", ""),
        attestation.get("baseRevision", ""),
        attestation.get("casesDigest", ""),
    )
    total_cases = attestation.get("totalCases")
    passed_cases = attestation.get("passedCases")
    failures = attestation.get("failures")
    if type(total_cases) is not int or total_cases != len(CASES):
        raise InvalidInputError("Attestation totalCases mismatch.")
    if type(passed_cases) is not int or not 0 <= passed_cases <= total_cases:
        raise InvalidInputError("Attestation passedCases out of range.")
    if not isinstance(failures, list) or any(type(idx) is not int for idx in failures):
        raise InvalidInputError("Attestation failures must be a list of case integers.")
    if passed_cases + len(failures) != total_cases:
        raise InvalidInputError("Attestation passedCases and failures are inconsistent.")
    if passed and (passed_cases != total_cases or len(failures) != 0):
        raise InvalidInputError("Attestation cannot mark passed=True with failures.")
    file_digests = attestation.get("fileDigests")
    if not isinstance(file_digests, Mapping) or tuple(sorted(file_digests.keys())) != APPROVED_FILES:
        raise InvalidInputError("Attestation fileDigests must match approved two-file list.")
    for name in APPROVED_FILES:
        digest_val = file_digests[name]
        if type(digest_val) is not str or not HEX_SHA256_RE.fullmatch(digest_val):
            raise InvalidInputError(f"Invalid file digest for {name}.")
    expected_tree = _json_sha256([[name, file_digests[name]] for name in APPROVED_FILES])
    if attestation.get("treeSha256") != expected_tree:
        raise InvalidInputError("Attestation treeSha256 mismatch.")


def write_attestation_file(output_path: str | Path, attestation: Mapping[str, object]) -> Path:
    """Persist a validated attestation exclusively (never overwrites existing files)."""
    validate_attestation_shape(attestation)
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


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Disconnected fixed-synthetic protected fixture verifier."
    )
    parser.add_argument("--candidate-dir", required=True, help="Directory holding limits.py and measurement.py")
    parser.add_argument("--claim-id", required=True, help="Claim identifier")
    parser.add_argument("--base-revision", required=True, help="Pinned base commit SHA")
    parser.add_argument("--cases-digest", default=CASES_DIGEST, help="Expected CASES SHA-256 digest")
    parser.add_argument("--output", help="Optional new file path for exclusive attestation write")
    args = parser.parse_args(argv)

    try:
        attestation = verify_candidate_dir(
            args.candidate_dir,
            claim_id=args.claim_id,
            base_revision=args.base_revision,
            expected_cases_digest=args.cases_digest,
        )
        if args.output:
            write_attestation_file(args.output, attestation)
    except InvalidInputError as error:
        print(
            _canonical_json(
                {
                    "scope": VERIFIER_SCOPE,
                    "trusted": False,
                    "passed": False,
                    "errorType": "invalid_input",
                    "error": str(error),
                }
            ),
            flush=True,
        )
        return 2
    except UnsupportedSyntaxError as error:
        print(
            _canonical_json(
                {
                    "scope": VERIFIER_SCOPE,
                    "trusted": False,
                    "passed": False,
                    "errorType": "unsupported_syntax",
                    "error": str(error),
                }
            ),
            flush=True,
        )
        return 3

    print(_canonical_json(attestation), flush=True)
    return 0 if attestation["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(_main())
