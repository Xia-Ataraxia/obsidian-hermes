export const PROFILE_METADATA_IO_PYTHON = String.raw`
import ast, hashlib, json, os, re, signal, stat, sys, time
from pathlib import Path
from typing import Final, TypedDict, Union

YamlValue = Union[str, int, float, bool, None, list["YamlValue"], dict[str, "YamlValue"]]

class Field(TypedDict):
    status: str
    shape: str
    values: list[str]

class ReadResult(TypedDict):
    status: str
    text: str
    digest: str | None

class Configuration(TypedDict):
    status: str
    disabled: Field
    platformDisabled: dict[str, Field]
    platformStatus: str
    externalDirs: Field
    createDir: Field
    trustedProjectDirs: Field
    projectDiscovery: str

class Root(TypedDict):
    source: str
    path: str
    status: str

class Candidate(TypedDict):
    source: str
    root: str
    path: str
    canonicalPath: str
    name: str | None
    declaredName: str | None
    relativePath: str
    digest: str | None
    metadataStatus: str
    restrictions: dict[str, Field]
    provenance: str

class Projection(TypedDict):
    connection: str
    profile: str
    home: str
    canonicalHome: str
    hostPlatform: str
    configuration: Configuration
    candidates: list[Candidate]
    roots: list[Root]
    manifests: dict[str, str]
    reasons: list[str]

class BudgetError(Exception):
    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)

reasons: set[str] = {"missing-attribution"}
signatures: dict[str, tuple[int, int, int, int, int]] = {}
link_signatures: dict[str, tuple[int, int, int, int, int]] = {}
missing_paths: set[str] = set()
total_bytes = 0
directory_count = 0
MAXIMUM: Final = {"candidates": 2048, "directories": 8192, "depth": 32, "fileBytes": 1048576, "totalBytes": 16777216, "outputBytes": 4194304, "deadlineMs": 10000}
request = json.loads(sys.argv[1])
if not isinstance(request, dict):
    sys.exit(2)
limits = request.get("limits", {})
if not isinstance(limits, dict):
    sys.exit(2)
for key, maximum in MAXIMUM.items():
    value = limits.get(key, maximum)
    if type(value) is not int or value < 1 or value > maximum:
        sys.exit(2)
    limits[key] = value
for key in ("connection", "profile", "root", "sourceRoot"):
    if not isinstance(request.get(key), str) or len(request[key]) > 4096 or re.search(r"[\x00-\x1f]", request[key]):
        sys.exit(2)
if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", request["profile"]):
    sys.exit(2)
for key in ("root", "sourceRoot"):
    if not request[key].startswith("/") or ".." in request[key].split("/"):
        sys.exit(2)
root = Path(request["root"])
home = root if request["profile"] == "default" else root / "profiles" / request["profile"]
deadline = time.monotonic() + limits["deadlineMs"] / 1000

def alarm_handler(signum: int, frame) -> None:
    raise BudgetError("deadline")

signal.signal(signal.SIGALRM, alarm_handler)

def tick() -> None:
    if time.monotonic() >= deadline:
        raise BudgetError("deadline")

def signature(value: os.stat_result) -> tuple[int, int, int, int, int]:
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns

def fail_status(status: str) -> None:
    reasons.add({"missing": "missing-source", "unreadable": "transport-failure", "malformed": "malformed-data", "unsupported": "unsupported-schema", "changed": "malformed-data", "capped": "byte-cap"}[status])

def read_file(path: Path) -> ReadResult:
    global total_bytes
    tick()
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode):
                fail_status("unsupported")
                return {"status": "unsupported", "text": "", "digest": None}
            if before.st_size > limits["fileBytes"] or total_bytes + before.st_size > limits["totalBytes"]:
                fail_status("capped")
                return {"status": "capped", "text": "", "digest": None}
            data = stream.read(min(limits["fileBytes"], limits["totalBytes"] - total_bytes) + 1)
            total_bytes += len(data)
            if len(data) > limits["fileBytes"] or total_bytes > limits["totalBytes"]:
                raise BudgetError("byte-cap")
            after = os.fstat(stream.fileno())
        if signature(before) != signature(after) or signature(after) != signature(path.stat()):
            fail_status("changed")
            return {"status": "changed", "text": "", "digest": None}
        previous = signatures.setdefault(str(path), signature(after))
        if previous != signature(after):
            fail_status("changed")
            return {"status": "changed", "text": "", "digest": None}
        return {"status": "read", "text": data.decode("utf-8-sig"), "digest": hashlib.sha256(data).hexdigest()}
    except FileNotFoundError:
        missing_paths.add(str(path))
        fail_status("missing")
        return {"status": "missing", "text": "", "digest": None}
    except UnicodeError:
        fail_status("malformed")
        return {"status": "malformed", "text": "", "digest": None}
    except OSError:
        fail_status("unreadable")
        return {"status": "unreadable", "text": "", "digest": None}

def clean_text(value: str) -> bool:
    return len(value) <= 4096 and re.search(r"[\x00-\x1f]", value) is None

def unknown_field(status: str) -> Field:
    return {"status": status, "shape": "unknown", "values": []}

def string_field(value, literal: bool = False) -> Field:
    shape = type(value).__name__ if value is not None else "absent"
    if value is None:
        return {"status": "read", "shape": shape, "values": []}
    if isinstance(value, str):
        if literal and value.strip().startswith("["):
            try:
                parsed = ast.literal_eval(value.strip())
                if isinstance(parsed, list):
                    value = parsed
            except (SyntaxError, ValueError, RecursionError):
                parsed = None
        if isinstance(value, str):
            value = [value]
    if not isinstance(value, list) or len(value) > limits["candidates"] or any(not isinstance(item, (str, int, float, bool, type(None))) for item in value):
        fail_status("malformed")
        return {"status": "malformed", "shape": shape, "values": []}
    values = [str(item).strip() for item in value if str(item).strip()]
    if any(not clean_text(item) for item in values):
        fail_status("malformed")
        return {"status": "malformed", "shape": shape, "values": []}
    return {"status": "read", "shape": shape, "values": values}

def yaml_mapping(content: str) -> tuple[str, dict[str, YamlValue]]:
    try:
        import ruamel.yaml
        from ruamel.yaml import YAML
        from ruamel.yaml.error import YAMLError
        from ruamel.yaml.events import AliasEvent, MappingStartEvent, SequenceStartEvent, MappingEndEvent, SequenceEndEvent
    except ImportError:
        fail_status("unsupported")
        return "unsupported", {}
    if ruamel.yaml.__version__ not in ("0.18.16", "0.18.17"):
        fail_status("unsupported")
        return "unsupported", {}
    depth = 0
    events = 0
    try:
        scanner = YAML(typ="safe", pure=True)
        scanner.version = (1, 1)
        for event in scanner.parse(content):
            tick()
            events += 1
            if isinstance(event, (MappingStartEvent, SequenceStartEvent)):
                depth += 1
            if isinstance(event, (MappingEndEvent, SequenceEndEvent)):
                depth -= 1
            if isinstance(event, AliasEvent) or depth > 32 or events > 10000:
                fail_status("unsupported")
                return "unsupported", {}
        loader = YAML(typ="safe", pure=False)
        loader.version = (1, 1)
        try:
            value = loader.load(content)
        except YAMLError:
            loader = YAML(typ="safe", pure=True)
            loader.version = (1, 1)
            value = loader.load(content)
        if not isinstance(value, dict):
            fail_status("malformed")
            return "malformed", {}
        return "read", value
    except (YAMLError, RecursionError, ValueError, TypeError):
        fail_status("malformed")
        return "malformed", {}
`;
