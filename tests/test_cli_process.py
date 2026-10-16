import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from fountain.cli_process import CLIProcessError, MAX_INPUT_BYTES, run_cli


@unittest.skipUnless(os.name == "posix", "POSIX process-group runner")
class CLIProcessTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="CLI fixture space ")
        self.addCleanup(self.directory.cleanup)
        self.cwd = Path(self.directory.name)

    def run_fixture(self, source, input_bytes=b"", **options):
        return run_cli([sys.executable, "-c", source], input_bytes=input_bytes,
                       cwd=self.cwd, env={"FIXTURE_SECRET": "never report this"}, **options)

    def assert_terminated(self, pid):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                # Linux's minimal init can retain an already-dead orphan zombie.
                stat = Path(f"/proc/{pid}/stat")
                if stat.exists() and stat.read_text().split(") ", 1)[1].startswith("Z"):
                    return
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.01)
        self.fail("fixture process survived group cleanup")

    def test_binary_roundtrip_nonzero_exit_and_space_directory(self):
        content = b"\x00\xff\r\n" + "한🙂".encode()
        result = self.run_fixture(
            "import os,sys; data=sys.stdin.buffer.read(); "
            "sys.stdout.buffer.write(data); sys.stderr.buffer.write(b'err'); sys.exit(7)", content)
        self.assertEqual(result, {"stdout": content, "stderr": b"err", "returncode": 7})

    def test_stdin_pressure_and_both_output_pipes_do_not_deadlock(self):
        content = b"i" * (2 * 1024 * 1024)
        result = self.run_fixture(
            "import os,sys\n"
            "for _ in range(128):\n"
            " os.write(1,b'o'*8192); os.write(2,b'e'*8192)\n"
            "data=sys.stdin.buffer.read()\n"
            "os.write(1,str(len(data)).encode())\n", content,
            max_stdout=2_000_000, max_stderr=2_000_000, timeout=5)
        self.assertEqual(result["stdout"], b"o" * 1_048_576 + str(len(content)).encode())
        self.assertEqual(result["stderr"], b"e" * 1_048_576)
        self.assertEqual(result["returncode"], 0)

    def test_stdout_and_stderr_limits_are_separate_and_sanitized(self):
        for descriptor, kind in [(1, "stdout_limit"), (2, "stderr_limit")]:
            with self.subTest(kind=kind), self.assertRaises(CLIProcessError) as caught:
                self.run_fixture(f"import os; os.write({descriptor},b'sensitive output'*1000)",
                                 max_stdout=100, max_stderr=100)
            self.assertEqual(caught.exception.kind, kind)
            for secret in ("sensitive output", "never report this", str(self.cwd)):
                self.assertNotIn(secret, str(caught.exception))

    def test_exact_caps_and_zero_caps(self):
        self.assertEqual(self.run_fixture("import os; os.write(1,b'abc')", max_stdout=3)["stdout"], b"abc")
        self.assertEqual(self.run_fixture("pass", max_stdout=0, max_stderr=0)["returncode"], 0)
        with self.assertRaises(CLIProcessError) as caught:
            self.run_fixture("print('x')", max_stdout=0)
        self.assertEqual(caught.exception.kind, "stdout_limit")

    def test_deadline_kills_leader_and_child_and_reaps_leader(self):
        source = ("import os,subprocess,sys,time\n"
                  "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])\n"
                  "open('pids','w').write(str(os.getpid())+' '+str(child.pid))\n"
                  "time.sleep(60)\n")
        started = time.monotonic()
        with self.assertRaises(CLIProcessError) as caught:
            self.run_fixture(source, timeout=0.3)
        self.assertEqual(caught.exception.kind, "timeout")
        self.assertLess(time.monotonic() - started, 3)
        leader, child = map(int, (self.cwd / "pids").read_text().split())
        self.assert_terminated(leader)
        self.assert_terminated(child)
        with self.assertRaises(ChildProcessError):
            os.waitpid(leader, os.WNOHANG)

    def test_normal_exit_also_kills_remaining_group_descendant(self):
        source = ("import subprocess,sys\n"
                  "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])\n"
                  "open('child','w').write(str(child.pid))\n"
                  "print('done')\n")
        result = self.run_fixture(source, timeout=3)
        self.assertEqual(result["stdout"], b"done\n")
        self.assertEqual(result["returncode"], 0)
        self.assert_terminated(int((self.cwd / "child").read_text()))

    def test_stdout_limit_also_kills_descendant(self):
        source = ("import os,subprocess,sys,time\n"
                  "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])\n"
                  "open('child','w').write(str(child.pid))\n"
                  "os.write(1,b'x'*8192)\n"
                  "time.sleep(60)\n")
        with self.assertRaises(CLIProcessError) as caught:
            self.run_fixture(source, max_stdout=1)
        self.assertEqual(caught.exception.kind, "stdout_limit")
        self.assert_terminated(int((self.cwd / "child").read_text()))

    def test_shell_syntax_is_literal_and_executable_space_path_works(self):
        script = self.cwd / "fixture script.py"
        script.write_text("import sys; print(sys.argv[1])")
        argument = "; touch should-not-exist; $(echo shell)"
        executable = self.cwd / "python executable"
        executable.symlink_to(sys.executable)
        result = run_cli([str(executable), str(script), argument], input_bytes=b"",
                         cwd=self.cwd, env={})
        self.assertEqual(result["stdout"], (argument + "\n").encode())
        self.assertFalse((self.cwd / "should-not-exist").exists())

    def test_empty_argument_is_preserved_and_early_stdin_close_is_safe(self):
        result = run_cli([sys.executable, "-c", "import sys; print(repr(sys.argv[1]))", ""],
                         input_bytes=b"x" * 1_000_000, cwd=self.cwd, env={})
        self.assertEqual(result["stdout"], b"''\n")
        self.assertEqual(result["returncode"], 0)

    def test_deadline_applies_after_child_closes_all_pipes(self):
        with self.assertRaises(CLIProcessError) as caught:
            self.run_fixture("import os,time; os.close(0); os.close(1); os.close(2); time.sleep(60)",
                             timeout=0.1)
        self.assertEqual(caught.exception.kind, "timeout")

    def test_spawn_failure_does_not_disclose_arguments_or_environment(self):
        with self.assertRaises(CLIProcessError) as caught:
            run_cli([str(self.cwd / "private executable"), "private prompt"], input_bytes=b"private body",
                    cwd=self.cwd, env={"SECRET": "private environment"})
        self.assertEqual(caught.exception.kind, "spawn_failed")
        for secret in ("private", str(self.cwd)):
            self.assertNotIn(secret, str(caught.exception))

    def test_unused_inheritable_descriptor_is_closed_in_child(self):
        with (self.cwd / "private file").open("w") as stream:
            os.set_inheritable(stream.fileno(), True)
            result = self.run_fixture(
                f"import os\ntry: os.fstat({stream.fileno()})\nexcept OSError: print('closed')\nelse: print('leaked')")
            self.assertEqual(result["stdout"], b"closed\n")

    def test_repeated_success_failure_and_timeout_do_not_leak_descriptors(self):
        directory = Path("/proc/self/fd") if Path("/proc/self/fd").exists() else Path("/dev/fd")
        before = len(list(directory.iterdir()))
        for _ in range(6):
            self.run_fixture("print('ok')")
            with self.assertRaises(CLIProcessError):
                self.run_fixture("print('too much')", max_stdout=0)
            with self.assertRaises(CLIProcessError):
                self.run_fixture("import time; time.sleep(60)", timeout=0.02)
        self.assertLessEqual(len(list(directory.iterdir())), before)

    def test_unexpected_exception_still_closes_descriptors_and_reaps(self):
        real_popen = subprocess.Popen
        processes = []
        def capture(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            processes.append(process)
            return process
        with patch("fountain.cli_process.subprocess.Popen", side_effect=capture), \
                patch("selectors.DefaultSelector.select", side_effect=RuntimeError("fixture failure")):
            with self.assertRaisesRegex(RuntimeError, "fixture failure"):
                self.run_fixture("import time; time.sleep(60)")
        self.assertIsNotNone(processes[0].returncode)
        self.assertTrue(all(stream.closed for stream in
                            (processes[0].stdin, processes[0].stdout, processes[0].stderr)))

    def test_invalid_options_are_rejected_without_value_disclosure(self):
        for options in [{"timeout": 0}, {"timeout": -1}, {"timeout": float("inf")},
                        {"timeout": float("nan")}, {"timeout": True}, {"timeout": 10 ** 1000},
                        {"max_stdout": -1}, {"max_stderr": True}, {"max_stdout": 1.5}]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.run_fixture("pass", **options)
        for content in ["private body", bytearray(b"private body"), b"x" * (MAX_INPUT_BYTES + 1)]:
            with self.assertRaises(ValueError) as caught:
                self.run_fixture("pass", content)
            self.assertNotIn("private body", str(caught.exception))
        for argv in ["private shell command", [], [""], ["private\0path"]]:
            with self.assertRaises(ValueError):
                run_cli(argv, input_bytes=b"", cwd=self.cwd, env={})

    def test_environment_and_working_directory_cannot_be_inherited_implicitly(self):
        for cwd, environment in [(None, {}), (self.cwd, None), (self.cwd, {"key": None})]:
            with self.assertRaises(ValueError):
                run_cli([sys.executable, "-c", "pass"], input_bytes=b"", cwd=cwd, env=environment)
        with patch.dict(os.environ, {"PRIVATE_PARENT_ONLY": "must not be inherited"}):
            result = self.run_fixture("import os; print(os.getenv('PRIVATE_PARENT_ONLY', 'absent'))")
        self.assertEqual(result["stdout"], b"absent\n")

    def test_selector_close_exception_does_not_skip_child_reaping(self):
        real_popen = subprocess.Popen
        real_close = __import__("selectors").DefaultSelector.close
        processes = []
        def capture(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            processes.append(process)
            return process
        def close_then_fail(selector):
            real_close(selector)
            raise RuntimeError("fixture selector close")
        with patch("fountain.cli_process.subprocess.Popen", side_effect=capture), \
                patch("selectors.DefaultSelector.close", close_then_fail):
            with self.assertRaisesRegex(RuntimeError, "fixture selector close"):
                self.run_fixture("import time; time.sleep(60)", timeout=0.02)
        self.assertIsNotNone(processes[0].returncode)
        self.assertTrue(all(stream.closed for stream in
                            (processes[0].stdin, processes[0].stdout, processes[0].stderr)))

    def test_windows_backend_is_explicitly_unsupported(self):
        with patch("fountain.cli_process.os.name", "nt"), self.assertRaises(CLIProcessError) as caught:
            self.run_fixture("pass")
        self.assertEqual(caught.exception.kind, "unsupported")


if __name__ == "__main__":
    unittest.main()
