import { PROFILE_METADATA_IO_PYTHON } from "./profile-metadata-python-io";
import { PROFILE_METADATA_CONFIG_PYTHON } from "./profile-metadata-python-config";
import { PROFILE_METADATA_SCAN_PYTHON } from "./profile-metadata-python-scan";

export const PROFILE_METADATA_SOURCE_PINS = {
  "hermes_yaml.py": "f97f0f08b6474c52434d0cffaa7ba0ecaa5b9279c4abcbb35c11d15f9c89db76",
  "hermes_constants.py": "870ad9935a62968636d6a14d160c0269dfbefd8091ab3cb71be78b30bef6360f",
  "hermes_cli/profiles.py": "bf02f8442a80ce0daad0ddde130662294e6f5b26b75d2d432e4fc021dd0edf3a",
  "agent/skill_utils.py": "cb1996a2ef7f52f075f1a45fa64eee4ea9f332b9910da4ecc123ce0ead79fb46",
  "tools/skills_tool.py": "d7c80d57936277a527374ffa52eb4b3b3eb1baff1f4734232fb6d67e7d8858d7",
  "tools/skills_tool_plugin.py": "173ab14a51453556d617ce3681305e85018f7efb3903062c84bbf19b95320984",
  "tools/skill_usage.py": "cd713eaffdd2d8762c8cd4347ac41af7968e7cffc3f7d42bc17f1ba2ab715f4d",
} as const;

const MAIN = String.raw`
def sources_match() -> bool:
    valid = True
    for name, expected in SOURCE_PINS.items():
        observed = read_file(Path(request["sourceRoot"]) / name)
        if observed["status"] != "read" or observed["digest"] != expected:
            valid = False
    if not valid:
        reasons.add("unsupported-schema")
    return valid

def changed_inputs() -> bool:
    for path, before in link_signatures.items():
        tick()
        try:
            if signature(Path(path).lstat()) != before:
                return True
        except OSError:
            return True
    for path in missing_paths:
        tick()
        if Path(path).exists():
            return True
    for path, before in signatures.items():
        tick()
        try:
            if signature(Path(path).stat()) != before:
                return True
        except OSError:
            return True
    return False

def redact_uncertain(result: Projection, status: str) -> None:
    result["configuration"] = empty_configuration(status)
    for row in result["candidates"]:
        row["metadataStatus"] = status
        row["digest"] = None
        row["provenance"] = "unknown"
        row["restrictions"] = {key: unknown_field(status) for key in RESTRICTIONS}
    result["manifests"] = {key: status for key in ("bundled", "suppressed", "hub")}

result: Projection = {"connection": request["connection"], "profile": request["profile"], "home": str(home), "canonicalHome": str(home), "hostPlatform": sys.platform,
          "configuration": empty_configuration("unsupported"), "candidates": [], "roots": [], "manifests": {"bundled": "unsupported", "suppressed": "unsupported", "hub": "unsupported"}, "reasons": []}
try:
    signal.setitimer(signal.ITIMER_REAL, limits["deadlineMs"] / 1000)
    result["canonicalHome"] = str(home.resolve())
    if sources_match():
        if selected_profile_exists():
            result["configuration"] = configuration()
            result["roots"] = configured_roots(result["configuration"])
            scan_candidates(result["roots"], result["candidates"])
            result["manifests"] = provenance(result["candidates"], result["roots"])
        else:
            result["configuration"] = empty_configuration("missing")
        if not sources_match():
            redact_uncertain(result, "unsupported")
        elif changed_inputs():
            fail_status("changed")
            redact_uncertain(result, "changed")
except BudgetError as error:
    reasons.add(error.reason)
    redact_uncertain(result, "capped")
except (OSError, RuntimeError):
    fail_status("unreadable")
    redact_uncertain(result, "unreadable")
finally:
    signal.setitimer(signal.ITIMER_REAL, 0)
result["reasons"] = sorted(reasons)
encoded = json.dumps(result, ensure_ascii=True, separators=(",", ":"))
if len(encoded.encode("utf-8")) > limits["outputBytes"]:
    result["candidates"] = []
    result["roots"] = []
    result["configuration"] = empty_configuration("capped")
    reasons.add("byte-cap")
    result["reasons"] = sorted(reasons)
    encoded = json.dumps(result, ensure_ascii=True, separators=(",", ":"))
if len(encoded.encode("utf-8")) > limits["outputBytes"]:
    sys.exit(3)
sys.stdout.write(encoded)
`;

export const PROFILE_METADATA_PYTHON = [PROFILE_METADATA_IO_PYTHON, PROFILE_METADATA_CONFIG_PYTHON, PROFILE_METADATA_SCAN_PYTHON,
  `SOURCE_PINS = ${JSON.stringify(PROFILE_METADATA_SOURCE_PINS)}`, MAIN].join("\n");
