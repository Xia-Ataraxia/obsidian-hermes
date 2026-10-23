from __future__ import annotations

import os
import signal
import subprocess


def run_owned(argv: list[str], environment: dict[str, str], timeout: float) -> None:
    process = subprocess.Popen(argv, env=environment, start_new_session=True)
    try:
        code = process.wait(timeout=timeout)
        if code:
            raise subprocess.CalledProcessError(code, argv)
    finally:
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=3)
