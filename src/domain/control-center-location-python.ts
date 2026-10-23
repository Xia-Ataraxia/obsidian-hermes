export const CONTROL_CENTER_LOCATION_PYTHON = String.raw`
import ast, ctypes, json, re, shlex, shutil, struct, subprocess, sys
from pathlib import Path

def bounded(path):
    with path.open("rb") as stream:
        data = stream.read(262145)
    if len(data) > 262144:
        raise ValueError("oversized native source")
    return data.decode("utf-8")

def source_location(process_argv):
    executable = shutil.which("hermes")
    if not executable:
        raise ValueError("native launcher unavailable")
    path = Path(executable).resolve(strict=True)
    for _ in range(4):
        text = bounded(path)
        if not text.startswith("#!/bin/sh\nexec "):
            raise ValueError("unrecognized native launcher")
        argv = shlex.split(text.split("\n", 1)[1])
        if argv[0] != "exec" or not Path(argv[1]).is_absolute():
            raise ValueError("unrecognized native launcher")
        if "-c" not in argv:
            path = Path(argv[1]).resolve(strict=True)
            continue
        program = ast.parse(argv[argv.index("-c") + 1])
        if "-c" not in process_argv or process_argv[process_argv.index("-c") + 1] != argv[argv.index("-c") + 1] or not Path(process_argv[0]).samefile(argv[1]):
            raise ValueError("launcher does not identify dashboard process")
        roots = []
        for node in program.body:
            if not isinstance(node, ast.Expr) or not isinstance(node.value, ast.Call):
                continue
            call = node.value
            if ast.dump(call.func) == "Attribute(value=Attribute(value=Name(id='sys', ctx=Load()), attr='path', ctx=Load()), attr='insert', ctx=Load())" and len(call.args) == 2:
                if isinstance(call.args[0], ast.Constant) and call.args[0].value == 0 and isinstance(call.args[1], ast.Constant) and isinstance(call.args[1].value, str):
                    roots.append(call.args[1].value)
        if len(set(roots)) != 1:
            raise ValueError("unrecognized native source path")
        return Path(roots[0]).resolve(strict=True)
    raise ValueError("native launcher chain exceeded")

def parse_process_bytes(raw):
    if len(raw) < 8:
        raise ValueError("short process arguments")
    argc = struct.unpack_from("i", raw)[0]
    if not 1 <= argc <= 4096:
        raise ValueError("invalid argument count")
    position = raw.index(b"\0", 4) + 1
    while position < len(raw) and raw[position] == 0:
        position += 1
    argv = []
    for _ in range(argc):
        end = raw.index(b"\0", position)
        argv.append(raw[position:end].decode("utf-8"))
        position = end + 1
    return argv

def service_process():
    if sys.platform != "darwin":
        raise ValueError("unsupported process environment reader")
    result = subprocess.run(["/usr/sbin/lsof", "-n", "-P", "-iTCP:9119", "-sTCP:LISTEN", "-Fp"], capture_output=True, text=True, timeout=4, check=True)
    pids = set(re.findall(r"^p([0-9]+)$", result.stdout, re.M))
    if len(pids) != 1:
        raise ValueError("ambiguous dashboard process")
    libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    mib = (ctypes.c_int * 3)(1, 49, int(next(iter(pids))))
    buffer = ctypes.create_string_buffer(1048576)
    size = ctypes.c_size_t(len(buffer))
    if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0 or size.value > len(buffer):
        raise ValueError("process arguments unavailable")
    argv = parse_process_bytes(buffer.raw[:size.value])
    if "dashboard" not in argv:
        raise ValueError("unrecognized dashboard process")
    return argv

try:
    process_argv = service_process()
    source = source_location(process_argv)
    if not (source / ".venv/bin/python").is_file():
        raise ValueError("native source unavailable")
    print(json.dumps({"sourceRoot": str(source), "provenance": "matching-native-launcher-and-dashboard-process"}))
except (OSError, ValueError, SyntaxError, IndexError, UnicodeError, subprocess.SubprocessError):
    print(json.dumps({"unavailable": True}))
`;
