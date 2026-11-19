"""Unit tests for the isolated-runner defensive check-result parser boundary."""

import importlib.util
from pathlib import Path
import sys
import types
import unittest


PILOT_DIR = Path(__file__).resolve().parent


def _load_sandbox():
    spec = importlib.util.spec_from_file_location("isolated_runner_sandbox", PILOT_DIR / "sandbox.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_guest():
    stubbed_resource = False
    if "resource" not in sys.modules:
        try:
            importlib.import_module("resource")
        except ModuleNotFoundError:
            sys.modules["resource"] = types.ModuleType("resource")
            stubbed_resource = True
    try:
        spec = importlib.util.spec_from_file_location("isolated_runner_guest", PILOT_DIR / "guest.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        if stubbed_resource:
            sys.modules.pop("resource", None)


sandbox = _load_sandbox()
guest = _load_guest()


def _padded_value_frame(value, total_bytes):
    prefix = f'{{"value":{value}}}'.encode("ascii")
    padding = total_bytes - len(prefix) - 1
    if padding < 0:
        raise ValueError("total_bytes is smaller than the minimal frame")
    return prefix + (b" " * padding) + b"\n"


class DefensiveParserBoundaryTests(unittest.TestCase):
    PARSERS = (
        ("guest.parse_check_payload", guest.parse_check_payload, guest.CHECK_RESULT_MAX),
        ("sandbox.parse_check_outcome", sandbox.parse_check_outcome, sandbox.CHECK_OUTPUT_MAX),
    )

    def test_expected_byte_bounds_are_defined(self):
        self.assertEqual(guest.CHECK_RESULT_MAX, 256)
        self.assertEqual(sandbox.CHECK_OUTPUT_MAX, 4096)

    def test_ordinary_integer_results_are_accepted(self):
        cases = (
            (b'{"value":0}\n', 0),
            (b'{"value":42}\n', 42),
            (b'{"value":-12}\n', -12),
            (b'{"value":100}\n', 100),
            (b' {"value": 56} \n', 56),
            (b'{"value": 164}\n', 164),
        )
        for name, parser, _ in self.PARSERS:
            for raw, expected in cases:
                with self.subTest(parser=name, raw=raw):
                    result = parser(raw)
                    self.assertEqual(result, {"value": expected})
                    self.assertIs(type(result["value"]), int)

    def test_exact_max_length_frame_succeeds_and_one_byte_over_fails(self):
        for name, parser, max_bytes in self.PARSERS:
            exact = _padded_value_frame(75, max_bytes)
            oversize = _padded_value_frame(75, max_bytes + 1)
            with self.subTest(parser=name, case="exact_bound"):
                self.assertEqual(len(exact), max_bytes)
                self.assertEqual(parser(exact), {"value": 75})
            with self.subTest(parser=name, case="over_bound"):
                self.assertEqual(len(oversize), max_bytes + 1)
                with self.assertRaises(ValueError):
                    parser(oversize)

    def test_empty_and_oversized_non_json_frames_fail_closed(self):
        for name, parser, max_bytes in self.PARSERS:
            for raw in (b"", b"\n", b"x" * (max_bytes + 1), b"x" * max_bytes + b"\n"):
                with self.subTest(parser=name, length=len(raw)):
                    with self.assertRaises(ValueError):
                        parser(raw)

    def test_malformed_framing_and_trailing_data_fail_closed(self):
        malformed_frames = (
            b'{"value":1}',
            b'{"value":1}\r',
            b'{"value":1}\n ',
            b'{"value":1}\nextra',
            b'{"value":1}\n\n',
            b'\n{"value":1}\n',
            b'{"value":1}\n{"value":2}\n',
            b'{"value":\n',
            b"not-json\n",
            b"\xff\xfe\n",
        )
        for name, parser, _ in self.PARSERS:
            for raw in malformed_frames:
                with self.subTest(parser=name, raw=raw):
                    with self.assertRaises(ValueError):
                        parser(raw)

    def test_non_value_shapes_and_non_integer_values_fail_closed(self):
        invalid_shapes = (
            b"null\n",
            b"123\n",
            b'"value"\n',
            b"[]\n",
            b'[{"value":1}]\n',
            b"{}\n",
            b'{"error":"failed"}\n',
            b'{"other":1}\n',
            b'{"value":1,"extra":2}\n',
            b'{"value":true}\n',
            b'{"value":false}\n',
            b'{"value":1.0}\n',
            b'{"value":"1"}\n',
            b'{"value":null}\n',
            b'{"value":[1]}\n',
            b'{"value":{"value":1}}\n',
        )
        for name, parser, _ in self.PARSERS:
            for raw in invalid_shapes:
                with self.subTest(parser=name, raw=raw):
                    with self.assertRaises(ValueError):
                        parser(raw)


if __name__ == "__main__":
    unittest.main()
