"""Inert multi-process payload for disconnected OpenCode Stop verification.

Runs only inside the bubblewrap PID namespace after the Windows controller
records durable ownership identity and sends the matching release digest.
Spawns a child process inside the private PID namespace so Stop must terminate
the full namespace process tree, not just a single process.
"""

import json
import os
import subprocess
import sys
import time


def main():
    child = subprocess.Popen(
        [sys.executable, "-I", "-B", "-c", "import time; time.sleep(25)"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        frame = {
            "payload": "inert-fixture",
            "nsInitPid": os.getpid(),
            "nsChildPid": child.pid,
        }
        print(json.dumps(frame, sort_keys=True, separators=(",", ":")), flush=True)
        time.sleep(25)
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=2)


if __name__ == "__main__":
    main()
