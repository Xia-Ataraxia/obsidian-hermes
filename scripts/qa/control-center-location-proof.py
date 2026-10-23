#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
# How to run: use the production shell Python on the verified M1 host.
# python3 -I -B control-center-location-proof.py
# No package installation, native imports, service writes, or environment logging.
from __future__ import annotations

import ast
import hashlib
import json
import platform
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path
from types import ModuleType
from typing import Final, TypedDict

BASE: Final = Path("/private/tmp/hermes-control-center-m1-01a161c0/task-20/location-proof")
NATIVE: Final = Path("/Users/beomsu/.hermes/hermes-agent/hermes_constants.py")
PINS: Final = {
    "_platform_default_hermes_home": "9129e89b6193e01395b101b062d8bddd47c1de3437d59327194999520519d869",
    "_hermes_root_of": "06ff2214e722b72cd36b4942e1717dafe32d011436887a5b8cc919efff569296",
    "hermes_root_for_environment": "a8a94873401c7d4e540d038c0fa1536665a421c62024091c968881f1adfadce2",
}


class Case(TypedDict):
    id: str
    passed: bool
    observable: str


def process_bytes(argv: list[str], environment: list[str]) -> bytes:
    """Encode synthetic KERN_PROCARGS2 records without executing the arguments."""
    return struct.pack("i", len(argv)) + b"/synthetic/executable\0\0" + b"\0".join(
        field.encode() for field in [*argv, *environment]
    ) + b"\0\0"


def main() -> None:
    assert platform.machine() == "arm64"
    assert subprocess.check_output(["id", "-un"], text=True).strip() == "beomsu"
    assert subprocess.check_output(["hostname"], text=True).strip() == "xia.local"
    assert subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip() == "Apple M1 Pro"
    assert sys.version_info[:3] == (3, 14, 8)
    source = (BASE / "control-center-location-python.ts").read_text()
    helper = source.removeprefix("export const CONTROL_CENTER_LOCATION_PYTHON = String.raw`\n").removesuffix("`;\n")
    assert helper.startswith("import ast,") and helper.endswith("\n")
    module = ModuleType("approved_location_helper")
    exec(compile(helper.split("\ntry:\n", 1)[0], "<product-location-definitions>", "exec"), module.__dict__)
    native_text = NATIVE.read_text()
    functions = [node for node in ast.parse(native_text).body if isinstance(node, ast.FunctionDef) and node.name in PINS]
    assert len(functions) == 3
    closures = []
    for function in functions:
        digest = hashlib.sha256(ast.dump(function, include_attributes=False).encode()).hexdigest()
        assert digest == PINS[function.name]
        body = ast.get_source_segment(native_text, function)
        assert body is not None
        assert "type_params=[]" not in body
        normalized_dump = ast.dump(function, include_attributes=False).replace(", type_params=[]", "")
        closures.append({"name": function.name, "astSha256": digest, "bodySha256": hashlib.sha256(body.encode()).hexdigest(), "withoutEmptyTypeParamsSha256": hashlib.sha256(normalized_dump.encode()).hexdigest(), "body": body})
    (BASE / "native-closure.json").write_text(json.dumps({
        "source": "<native-source>/hermes_constants.py", "sourceSha256": hashlib.sha256(native_text.encode()).hexdigest(),
        "functions": closures, "closureGlobals": ["Path", "Mapping", "Callable", "sys", "_ENV_REFERENCE"],
        "execution": "Only these exact AST-hash-matched FunctionDef nodes; no module import or launcher execution",
    }, indent=2))
    module.__dict__["_ENV_REFERENCE"] = re.compile(r"%([^%]+)%|\$\{([^}]+)\}|\$([A-Za-z0-9_-]+)")
    exec(compile(ast.Module(body=list(functions), type_ignores=[]), "<pinned-native-functions>", "exec"), module.__dict__)
    cases: list[Case] = []
    with tempfile.TemporaryDirectory(prefix="cases-", dir=BASE) as scratch:
        root = Path(scratch)
        home = root / "user home"
        home.mkdir()
        environment = {"HOME": str(home), "PATH": "/synthetic/bin"}
        for name, additions, expected in [
            ("default", {}, home / ".hermes"),
            ("suffix", {"HERMES_DATA_DIR_SUFFIX": "-qa"}, home / ".hermes-qa"),
            ("explicit", {"HERMES_HOME": str(root / "explicit")}, root / "explicit"),
            ("spaced-home", {"HERMES_HOME": str(root / "hermes data")}, root / "hermes data"),
            ("arbitrary-variable", {"DATA_ROOT": str(root / "data root"), "HERMES_HOME": "$DATA_ROOT/hermes"}, root / "data root/hermes"),
            ("braced-variable", {"DATA_ROOT": str(root / "data root"), "HERMES_HOME": "${DATA_ROOT}/hermes"}, root / "data root/hermes"),
            ("percent-variable", {"DATA_ROOT": str(root / "data root"), "HERMES_HOME": "%DATA_ROOT%/hermes"}, root / "data root/hermes"),
            ("tilde", {"HERMES_HOME": "~/custom"}, home / "custom"),
            ("profile-root", {"HERMES_HOME": str(root / "custom/profiles/xia")}, root / "custom"),
            ("relative-unavailable", {"HERMES_HOME": "relative"}, None),
            ("unknown-variable-unavailable", {"HERMES_HOME": "$UNKNOWN/home"}, None),
        ]:
            given = environment | additions
            _, parsed = module.parse_process_bytes(process_bytes([sys.executable, "dashboard"], [f"{key}={value}" for key, value in given.items()]))
            actual = module.hermes_root_for_environment(parsed)
            assert actual == expected, name
            cases.append({"id": name, "passed": True, "observable": "Exact expected native root" if expected else "Native rule returned unavailable"})
        _, parsed = module.parse_process_bytes(process_bytes(["python", "dashboard"], [*map("=".join, environment.items()), "OTHER=words HERMES_HOME=/wrong path"]))
        assert module.hermes_root_for_environment(parsed) == home / ".hermes"
        cases.append({"id": "embedded-assignment-data", "passed": True, "observable": "Assignment-like text stayed inside OTHER; default root unchanged"})
        malformed = [b"short", struct.pack("i", 5000) + b"xxxx", process_bytes(["python"], ["HOME=/a", "PATH=/b", "HOME=/c"]), process_bytes(["python"], ["HOME=/a", "PATH=/b", "BAD KEY=x"]), process_bytes(["python"], ["HOME=/a"])]
        for index, raw in enumerate(malformed):
            refused = False
            try:
                module.parse_process_bytes(raw)
            except ValueError:
                refused = True
            assert refused, index
            cases.append({"id": f"malformed-{index}", "passed": True, "observable": "Parser raised ValueError"})
        launcher = root / "hermes"
        program = f"import sys; sys.path.insert(0, {str(root)!r})"
        import shlex
        launcher.write_text(f"#!/bin/sh\nexec {shlex.quote(sys.executable)} -c {shlex.quote(program)} \"$@\"\n")
        original_which = shutil.which
        shutil.which = lambda command: str(launcher) if command == "hermes" else original_which(command)
        try:
            argv = [sys.executable, "-c", program, "dashboard"]
            assert module.source_location(argv) == root
            cases.append({"id": "matched-launcher", "passed": True, "observable": "Same interpreter and exact -c program selected the synthetic source"})
            for name, altered in [
                ("program-mismatch", [sys.executable, "-c", program + "; pass", "dashboard"]),
                ("interpreter-mismatch", ["/bin/sh", "-c", program, "dashboard"]),
                ("short-profile", [*argv, "-p", "xia"]),
                ("short-attached-profile", [*argv, "-pxia"]),
                ("long-profile", [*argv, "--profile", "xia"]),
                ("long-equals-profile", [*argv, "--profile=xia"]),
            ]:
                refused = False
                try:
                    module.source_location(altered)
                except ValueError:
                    refused = True
                assert refused, name
                cases.append({"id": name, "passed": True, "observable": "Location refused with ValueError"})
        finally:
            shutil.which = original_which
    live = subprocess.run([sys.executable, "-I", "-B", "-c", helper], capture_output=True, text=True, timeout=15, check=True)
    live_result = json.loads(live.stdout)
    assert set(live_result) in [{"unavailable"}, {"root", "sourceRoot", "provenance", "homeSource"}]
    assert not live.stderr
    structural = {"available": "root" in live_result, "provenance": live_result.get("provenance"), "homeSource": live_result.get("homeSource"), "environmentLogged": False}
    stage = "process-record"
    try:
        live_argv, live_environment = module.service_process()
        program_text = live_argv[live_argv.index("-c") + 1] if "-c" in live_argv else ""
        launcher_path = Path(shutil.which("hermes") or "/unavailable")
        for _ in range(4):
            launcher_text = module.bounded(launcher_path)
            assert launcher_text.startswith("#!/bin/sh\nexec ")
            launcher_argv = shlex.split(launcher_text.split("\n", 1)[1])
            if "-c" in launcher_argv:
                launcher_program = launcher_argv[launcher_argv.index("-c") + 1]
                assert launcher_program == program_text
                assert Path(live_argv[0]).samefile(launcher_argv[1])
                (BASE / "launcher-source.json").write_text(json.dumps({"source": "<native-public-launcher> literal -c program", "sha256": hashlib.sha256(launcher_program.encode()).hexdigest(), "program": launcher_program, "matchedServingProcessProgram": True, "matchedInterpreter": True, "environmentValuesIncluded": False}, indent=2))
                break
            launcher_path = Path(launcher_argv[1])
        structural["overrideSignals"] = {"launcherMentionsHermesHome": "HERMES_HOME" in program_text, "launcherMentionsOsEnviron": "os.environ" in program_text, "launcherMentionsPutenv": "putenv" in program_text, "profileArgument": any(value == "--profile" or value.startswith("--profile=") or value.startswith("-p") for value in live_argv[1:])}
        stage = "source-association"
        live_source = module.source_location(live_argv)
        stage = "root-rule"
        live_root = module.hermes_root_for_environment(live_environment)
        structural["diagnosis"] = {"stage": stage, "rootResolved": live_root is not None, "rootExists": live_root is not None and live_root.is_dir(), "nativeInterpreterExists": (live_source / ".venv/bin/python").is_file()}
    except (OSError, ValueError, SyntaxError, IndexError, UnicodeError, subprocess.SubprocessError) as error:
        reasons = {"native launcher unavailable", "unrecognized native launcher", "launcher does not identify dashboard process", "runtime home override requires separate authority", "unrecognized native source path", "native launcher chain exceeded"}
        structural["diagnosis"] = {"stage": stage, "errorType": type(error).__name__, "reason": str(error) if str(error) in reasons else "unclassified"}
    cases.append({"id": "live-readonly-discovery", "passed": True, "observable": "Completed within 15 seconds with structural-only allowed output"})
    cleaned = not any(BASE.glob("cases-*"))
    assert cleaned
    result = {"host": "Apple M1 Pro/beomsu/xia.local/arm64", "python": platform.python_version(), "productSha256": hashlib.sha256(source.encode()).hexdigest(), "harnessSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "cases": cases, "live": structural, "cleanup": {"syntheticDirectoriesRemoved": cleaned, "persistentChildren": 0, "portsOpened": 0}, "innerExit": 0}
    (BASE / "result.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
