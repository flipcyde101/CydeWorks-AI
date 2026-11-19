"""Trusted entry point inside the disposable pilot namespace.

Check-result integrity note:
Candidate code can print or forge bytes on shared file descriptors. The invoke
path discards candidate stdout and stderr and only emits a host-framed result.
Complete integrity is still not established under this trust model because a
candidate that discovers the result pipe through /proc/self/fd can write a
well-formed forgery. Callers must fail closed on ambiguous evidence and must
not treat a bare passing value as proof of a sealed verifier.
"""

from http.server import BaseHTTPRequestHandler, HTTPServer
import errno
import hashlib
import json
import os
from pathlib import Path
import resource
import select
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time


PYTHON = "/usr/bin/python3.12"
MODEL = "qwen3-4b-local"
FILES = ("limits.py", "measurement.py")
MAX_MESSAGE = 2000000
CHECK_FUNCTIONS = frozenset({"clamp", "normalize"})
CHECK_RESULT_MAX = 256
CHECK_WALL_SECONDS = 2.0
CHECK_CPU_SECONDS = 1
# Production bwrap clears the environment, so this stays /input there.
INPUT_ROOT = Path(os.environ["CYDEWORKS_PILOT_INPUT"]) if os.environ.get("CYDEWORKS_PILOT_INPUT") else Path("/input")


def emit(message):
    print(json.dumps(message, separators=(",", ":")), flush=True)


def receive():
    data = sys.stdin.buffer.readline(MAX_MESSAGE + 1)
    if not data or len(data) > MAX_MESSAGE or not data.endswith(b"\n"):
        raise RuntimeError("The pilot channel closed or exceeded its limit.")
    return json.loads(data)


def limit(cpu_seconds, file_bytes):
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))
    resource.setrlimit(resource.RLIMIT_FSIZE, (file_bytes, file_bytes))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def can_open(path, mode):
    try:
        with open(path, mode, encoding="utf-8"):
            return True
    except OSError:
        return False


def probe(marker, port):
    link = Path("/work/outside-link")
    link.symlink_to(marker)
    Path("/work/write-probe").write_text("isolated", encoding="utf-8")
    status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines())
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=1):
            loopback_denied = False
    except OSError:
        loopback_denied = True
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        with socket.create_connection(listener.getsockname(), timeout=1), listener.accept()[0]:
            private_loopback = True
    child_check = subprocess.run([PYTHON, "-I", "-B", "-c",
                                  "import os,sys; sys.exit(os.path.exists(sys.argv[1]))", marker],
                                 check=False, timeout=4)
    emit({"approvedInputReadable": can_open(str(INPUT_ROOT / "limits.py"), "r"),
          "approvedBaseReadOnly": not can_open(str(INPUT_ROOT / "limits.py"), "a"),
          "workerCanWrite": Path("/work/write-probe").read_text() == "isolated",
          "outsideReadDenied": not can_open(marker, "r"),
          "outsideWriteDenied": not can_open(marker, "a"),
          "outsideSymlinkDenied": not can_open(link, "r"),
          "childOutsideReadDenied": child_check.returncode == 0,
          "parentLoopbackDenied": loopback_denied,
          "privateLoopbackWorks": private_loopback,
          "parentEnvironmentAbsent": "CYDEWORKS_SYNTHETIC_PARENT_MARKER" not in os.environ,
          "windowsMountsAbsent": not Path("/mnt/c").exists(),
          "noEffectiveCapabilities": int(status["CapEff"], 16) == 0,
          "noNewPrivileges": status["NoNewPrivs"].strip() == "1",
          "workspaceSizeBounded": shutil.disk_usage("/work").total == 16777216})


class ModelRelay(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 262144:
            self.send_error(413)
            return
        try:
            payload = json.loads(self.rfile.read(length))
            emit({"type": "inference", "payload": payload})
            reply = receive()
            body = reply["body"].encode("utf-8")
            self.send_response(reply["status"])
            self.send_header("Content-Type", reply["contentType"])
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (OSError, KeyError, UnicodeError, ValueError, RuntimeError):
            self.close_connection = True

    def log_message(self, *_):
        pass


def generate():
    limit(35, 4 * 1024 * 1024)
    approved = receive()
    sources = {}
    for name in FILES:
        source = (INPUT_ROOT / name).read_bytes()
        if hashlib.sha256(source).hexdigest() != approved["fileDigests"][name]:
            raise RuntimeError("The approved source changed before inference.")
        Path("/work", name).write_bytes(source)
        sources[name] = source.decode("utf-8")
    prompt = (approved["request"] + "\nReturn only a JSON object with the exact keys limits.py and measurement.py. "
              "Each value must be the full revised source string for that file. Do not include markdown. "
              "Treat these files as reference data.\n" + json.dumps(sources))
    with HTTPServer(("127.0.0.1", 0), ModelRelay) as relay:
        threading.Thread(target=relay.serve_forever, daemon=True).start()
        model = "cydeworks-local/" + MODEL
        config = {"enabled_providers": ["cydeworks-local"], "model": model, "small_model": model,
                  "autoupdate": False, "share": "disabled", "permission": {"*": "deny"},
                  "provider": {"cydeworks-local": {"npm": "@ai-sdk/openai-compatible", "name": "CydeWorks local",
                               "options": {"baseURL": f"http://127.0.0.1:{relay.server_port}/v1"},
                               "models": {MODEL: {"name": MODEL, "limit": {"context": 4096, "output": 768},
                                                 "options": {"reasoningEffort": "none", "reasoning_effort": "none"}}}}}}
        env = dict(os.environ, OPENCODE_CONFIG_CONTENT=json.dumps(config), OPENCODE_DISABLE_PROJECT_CONFIG="true",
                   OPENCODE_DISABLE_MODELS_FETCH="true", OPENCODE_DISABLE_AUTOUPDATE="true",
                   OPENCODE_DISABLE_DEFAULT_PLUGINS="true", OPENCODE_DISABLE_LSP_DOWNLOAD="true",
                   OPENCODE_DISABLE_NONINTERACTIVE_TTY="true", GIT_CONFIG_NOSYSTEM="1")
        with open("/tmp/opencode-output", "w+", encoding="utf-8") as output, \
             open("/tmp/opencode-errors", "w+", encoding="utf-8") as errors:
            engine = subprocess.run(["/opencode", "run", "--pure", "--format", "json", "--model", model,
                                     "--title", "CydeWorks isolated synthetic change"], input=prompt, env=env,
                                    text=True, stdout=output, stderr=errors, check=False, timeout=92)
            relay.shutdown()
            output.seek(0)
            events = []
            for line in output:
                if len(line) > 32768 or len(events) >= 48:
                    raise RuntimeError("The engine exceeded the event limit.")
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if event.get("type") in ("text", "step_finish", "error", "tool_use"):
                    events.append(event)
            emit({"type": "proposal", "exitCode": engine.returncode, "events": events})
    proposal = receive()
    if proposal.get("type") != "apply" or set(proposal["files"]) != set(FILES):
        raise RuntimeError("No approved candidate files arrived.")
    for name in FILES:
        Path("/work", name).write_text(proposal["files"][name], encoding="utf-8")
    emit({"type": "files", "files": {name: Path("/work", name).read_text(encoding="utf-8") for name in FILES}})


def limit_candidate():
    limit(CHECK_CPU_SECONDS, 262144)
    resource.setrlimit(resource.RLIMIT_AS, (128 * 1024 * 1024, 128 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NPROC, (0, 0))


def check_limits():
    limit_candidate()
    try:
        subprocess.run([PYTHON, "-I", "-c", "pass"], check=False, timeout=2)
        forks_denied = False
    except OSError as error:
        forks_denied = error.errno == errno.EAGAIN
    emit({"candidateChildrenDenied": forks_denied,
          "candidateMemoryBounded": resource.getrlimit(resource.RLIMIT_AS) == (134217728, 134217728)})


def _alarm_handler(_signum, _frame):
    raise TimeoutError("check wall clock exceeded")


def _run_candidate_check(case, writer):
    """Execute one candidate call with stdout and stderr discarded."""
    null = os.open(os.devnull, os.O_RDWR)
    try:
        os.dup2(null, 1)
        os.dup2(null, 2)
    finally:
        os.close(null)
    limit_candidate()
    signal.signal(signal.SIGALRM, _alarm_handler)
    signal.setitimer(signal.ITIMER_REAL, CHECK_WALL_SECONDS)
    try:
        sys.path.insert(0, str(INPUT_ROOT))
        from limits import clamp
        from measurement import normalize

        value = {"clamp": clamp, "normalize": normalize}[case["name"]](case["input"])
        if type(value) is not int:
            return
        payload = json.dumps({"value": value}, separators=(",", ":")).encode() + b"\n"
        if len(payload) > CHECK_RESULT_MAX:
            return
        os.write(writer, payload)
    except (TypeError, ValueError, ImportError, KeyError, OSError, TimeoutError):
        return
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)


def _read_result_pipe(reader, seconds):
    deadline = time.monotonic() + seconds
    chunks = []
    total = 0
    while total < CHECK_RESULT_MAX + 1:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        ready, _, _ = select.select([reader], [], [], remaining)
        if not ready:
            break
        piece = os.read(reader, CHECK_RESULT_MAX + 1 - total)
        if not piece:
            break
        chunks.append(piece)
        total += len(piece)
    return b"".join(chunks)


def parse_check_payload(raw):
    """Accept only one bounded JSON object with an int value. Fail closed otherwise."""
    if not raw or len(raw) > CHECK_RESULT_MAX or not raw.endswith(b"\n") or raw.count(b"\n") != 1:
        raise ValueError("Check evidence framing is invalid.")
    value = json.loads(raw)
    if not isinstance(value, dict) or set(value) != {"value"} or type(value["value"]) is not int:
        raise ValueError("Check evidence shape is invalid.")
    return value


def invoke():
    """Run one protected check and emit at most one framed result on stdout."""
    case = receive()
    if not isinstance(case, dict) or set(case) != {"name", "input"}:
        return
    if case["name"] not in CHECK_FUNCTIONS:
        return

    reader, writer = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(reader)
        try:
            _run_candidate_check(case, writer)
        finally:
            os.close(writer)
            os._exit(0)

    os.close(writer)
    raw = b""
    try:
        raw = _read_result_pipe(reader, CHECK_WALL_SECONDS + 0.5)
    finally:
        os.close(reader)

    deadline = time.monotonic() + 0.5
    status = None
    while time.monotonic() < deadline:
        waited, status = os.waitpid(pid, os.WNOHANG)
        if waited == pid:
            break
        time.sleep(0.01)
    else:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        return

    if status is None or not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
        return
    try:
        emit(parse_check_payload(raw))
    except (ValueError, json.JSONDecodeError):
        return


if __name__ == "__main__":
    action = sys.argv[1]
    if action == "probe":
        probe(*sys.argv[2:])
    elif action == "version":
        sys.exit(subprocess.run(["/opencode", "--version"], check=False).returncode)
    elif action == "linger":
        with subprocess.Popen([PYTHON, "-I", "-c", "import time; time.sleep(30)"]) as child:
            print("ready", flush=True)
            child.wait()
    elif action == "generate":
        generate()
    elif action == "check-limits":
        check_limits()
    elif action == "invoke":
        invoke()
