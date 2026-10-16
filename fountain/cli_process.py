"""Bounded POSIX subprocess I/O for explicitly configured CLI adapters.

The caller supplies an argv, isolated working directory, and curated environment.
This module never invokes a shell or includes invocation data in its errors.
"""
from __future__ import annotations

from collections.abc import Mapping
import math
import os
import selectors
import signal
import subprocess
import time

MAX_INPUT_BYTES = 8 * 1024 * 1024
_CHUNK = 64 * 1024
_MESSAGES = {
    "timeout": "CLI execution timed out",
    "stdout_limit": "CLI standard output exceeded its limit",
    "stderr_limit": "CLI standard error exceeded its limit",
    "spawn_failed": "CLI process could not be started or accessed",
    "unsupported": "CLI subprocess execution requires POSIX",
}


class CLIProcessError(RuntimeError):
    def __init__(self, kind):
        self.kind = kind
        super().__init__(_MESSAGES[kind])


def _kill_group(process):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except OSError:
        # A reaped leader can leave descendants; killpg above is required even
        # when poll() already returned. The fallback covers a failed group kill.
        try:
            process.kill()
        except OSError:
            pass


def run_cli(argv, *, input_bytes, cwd, env, timeout=45,
            max_stdout=2_000_000, max_stderr=65_536):
    """Return stdout/stderr bytes and the direct child's integer return code.

    Nonzero exits are returned for the adapter to interpret. Limits and timeout
    raise sanitized CLIProcessError values. Invalid caller arguments raise
    ValueError without rendering their values. Descendants that remain in the
    child's process group are killed on both successful and exceptional exits.
    """
    if os.name != "posix":
        raise CLIProcessError("unsupported")
    if not isinstance(argv, (list, tuple)) or not argv or any(
            not isinstance(value, str) or "\0" in value for value in argv) or not argv[0]:
        raise ValueError("CLI argv must contain strings and a nonempty executable")
    if cwd is None or not isinstance(env, Mapping) or any(
            not isinstance(key, str) or not isinstance(value, str) for key, value in env.items()):
        raise ValueError("CLI working directory and string environment must be explicit")
    if not isinstance(input_bytes, bytes) or len(input_bytes) > MAX_INPUT_BYTES:
        raise ValueError("CLI input must be bytes within its size limit")
    try:
        valid_timeout = (not isinstance(timeout, bool) and isinstance(timeout, (int, float))
                         and math.isfinite(timeout) and timeout > 0)
    except OverflowError:
        valid_timeout = False
    if not valid_timeout:
        raise ValueError("CLI timeout must be finite and positive")
    if any(type(value) is not int or value < 0 for value in (max_stdout, max_stderr)):
        raise ValueError("CLI output limits must be nonnegative integers")

    deadline = time.monotonic() + timeout
    selector = selectors.DefaultSelector()
    process = None
    output = {"stdout": bytearray(), "stderr": bytearray()}
    limits = {"stdout": max_stdout, "stderr": max_stderr}
    position = 0
    group_stopped = False

    def close_stream(stream):
        try:
            selector.unregister(stream)
        except (KeyError, ValueError):
            pass
        try:
            stream.close()
        except OSError:
            pass

    try:
        try:
            process = subprocess.Popen(
                list(argv), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, cwd=cwd, env=env, shell=False,
                start_new_session=True, close_fds=True, bufsize=0,
            )
        except (OSError, ValueError, TypeError, subprocess.SubprocessError):
            raise CLIProcessError("spawn_failed") from None

        for stream in (process.stdin, process.stdout, process.stderr):
            os.set_blocking(stream.fileno(), False)
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        selector.register(process.stderr, selectors.EVENT_READ, "stderr")
        if input_bytes:
            selector.register(process.stdin, selectors.EVENT_WRITE, "stdin")
        else:
            process.stdin.close()

        while selector.get_map() or process.poll() is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise CLIProcessError("timeout")
            if process.poll() is not None and not group_stopped:
                _kill_group(process)
                group_stopped = True
            if not selector.get_map():
                try:
                    process.wait(timeout=min(remaining, 0.05))
                except subprocess.TimeoutExpired:
                    pass
                continue
            try:
                ready = selector.select(min(remaining, 0.05))
            except InterruptedError:
                continue
            for key, _ in ready:
                stream, name = key.fileobj, key.data
                if name == "stdin":
                    try:
                        written = os.write(stream.fileno(), input_bytes[position:position + _CHUNK])
                    except (BlockingIOError, InterruptedError):
                        continue
                    except BrokenPipeError:
                        close_stream(stream)
                        continue
                    position += written
                    if position == len(input_bytes):
                        close_stream(stream)
                else:
                    try:
                        chunk = os.read(stream.fileno(), _CHUNK)
                    except (BlockingIOError, InterruptedError):
                        continue
                    if not chunk:
                        close_stream(stream)
                        continue
                    if len(output[name]) + len(chunk) > limits[name]:
                        raise CLIProcessError(name + "_limit")
                    output[name].extend(chunk)
        return {"stdout": bytes(output["stdout"]), "stderr": bytes(output["stderr"]),
                "returncode": process.returncode}
    except OSError:
        raise CLIProcessError("spawn_failed") from None
    finally:
        try:
            if process is not None:
                if not group_stopped:
                    _kill_group(process)
                for stream in (process.stdin, process.stdout, process.stderr):
                    if stream is not None and not stream.closed:
                        try:
                            stream.close()
                        except OSError:
                            pass
        finally:
            try:
                selector.close()
            finally:
                if process is not None:
                    process.wait()
