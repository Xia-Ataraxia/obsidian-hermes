export const PROFILE_METADATA_CONFIG_PYTHON = String.raw`
CONFIG_FIELDS: Final = {"disabled": "disabled", "external_dirs": "externalDirs", "create_dir": "createDir", "trusted_project_dirs": "trustedProjectDirs"}
CONDITIONS: Final = ("session_platforms", "requires_toolsets", "fallback_for_toolsets", "requires_tools", "fallback_for_tools")
RESTRICTIONS: Final = ("platforms", "environments", "requires_apps", *CONDITIONS)

def empty_configuration(status: str) -> Configuration:
    return {"status": status, "disabled": unknown_field(status), "platformDisabled": {}, "platformStatus": status, "externalDirs": unknown_field(status), "createDir": unknown_field(status), "trustedProjectDirs": unknown_field(status), "projectDiscovery": "unknown"}

def configuration() -> Configuration:
    data = read_file(home / "config.yaml")
    result = empty_configuration(data["status"])
    if data["status"] != "read":
        return result
    parsed_status, parsed = yaml_mapping(data["text"])
    if parsed_status != "read":
        return empty_configuration(parsed_status)
    selected = parsed.get("skills", {})
    if not isinstance(selected, dict):
        fail_status("malformed")
        return empty_configuration("malformed")
    result["status"] = "read"
    for key, output in CONFIG_FIELDS.items():
        result[output] = string_field(selected.get(key), key == "disabled")
    if selected.get("create_dir") is not None and not isinstance(selected["create_dir"], str):
        result["createDir"] = unknown_field("malformed")
        fail_status("malformed")
    platform = selected.get("platform_disabled", {})
    if platform is None:
        platform = {}
    if isinstance(platform, dict) and len(platform) <= limits["candidates"] and all(isinstance(key, str) and clean_text(key) for key in platform):
        result["platformDisabled"] = {key: string_field(value, True) for key, value in platform.items()}
        result["platformStatus"] = "read"
    else:
        result["platformStatus"] = "malformed"
        fail_status("malformed")
    discovery = selected.get("project_discovery", True)
    result["projectDiscovery"] = "disabled" if discovery is False else "enabled" if discovery is True else "unknown"
    if result["projectDiscovery"] == "unknown":
        fail_status("malformed")
    return result

def skill_metadata(path: Path) -> tuple[str, str | None, dict[str, Field], str | None]:
    data = read_file(path)
    fields = {key: unknown_field(data["status"]) for key in RESTRICTIONS}
    if data["status"] != "read":
        return data["status"], None, fields, data["digest"]
    content = data["text"][:4000]
    ending = re.search(r"\n---\s*\n", content[3:]) if content.startswith("---") else None
    metadata = {}
    metadata_status = "read"
    if ending:
        yaml_content = content[3:ending.start() + 3]
        metadata_status, metadata = yaml_mapping(yaml_content)
        if metadata_status == "malformed":
            metadata = {line.split(":", 1)[0].strip(): line.split(":", 1)[1].strip() for line in yaml_content.strip().split("\n") if ":" in line}
    name = metadata.get("name", path.parent.name)
    if not isinstance(name, str) or not name or not clean_text(name):
        metadata_status, name = "malformed", None
        fail_status("malformed")
    for key in ("platforms", "environments", "requires_apps"):
        fields[key] = string_field(metadata.get(key)) if metadata_status == "read" else unknown_field(metadata_status)
    outer = metadata.get("metadata", {})
    inner = outer.get("hermes", {}) if isinstance(outer, dict) else None
    for key in CONDITIONS:
        fields[key] = string_field(inner.get(key)) if isinstance(inner, dict) and metadata_status == "read" else unknown_field("malformed")
    if any(field["status"] != "read" for field in fields.values()):
        metadata_status = "malformed"
        fail_status("malformed")
    return metadata_status, name, fields, data["digest"]

def selected_profile_exists() -> bool:
    try:
        if not home.is_dir():
            missing_paths.add(str(home))
            fail_status("missing")
            return False
        if request["profile"] == "default":
            signatures.setdefault(str(home), signature(home.stat()))
            return True
        if (root / "profiles" / ".deleted" / request["profile"]).exists():
            fail_status("missing")
            return False
        missing_paths.add(str(root / "profiles" / ".deleted" / request["profile"]))
        signatures.setdefault(str(home), signature(home.stat()))
        markers = ("config.yaml", ".env", "SOUL.md", "profile.yaml", "auth.json", "state.db")
        for marker in markers:
            path = home / marker
            if path.is_symlink():
                link_signatures.setdefault(str(path), signature(path.lstat()))
                if path.exists():
                    signatures.setdefault(str(path), signature(path.stat()))
                else:
                    missing_paths.add(str(path))
                return True
            if path.is_file():
                signatures.setdefault(str(path), signature(path.stat()))
                return True
        fail_status("missing")
        return False
    except OSError:
        fail_status("unreadable")
        return False

def configured_path(value: str) -> Path | None:
    if "$" in value or value.startswith("~") and not (value == "~" or value.startswith("~/")):
        fail_status("unsupported")
        return None
    path = Path(value).expanduser()
    return (path if path.is_absolute() else home / path).resolve()

def configured_roots(config: Configuration) -> list[Root]:
    local = home / "skills"
    roots: list[Root] = [{"source": "local", "path": str(local), "status": "read" if local.is_dir() else "missing"}]
    seen = {local.resolve()}
    for source, field in (("create", config["createDir"]), ("external", config["externalDirs"])):
        if field["status"] != "read":
            continue
        for value in field["values"]:
            tick()
            try:
                path = configured_path(value)
                if path is None:
                    roots.append({"source": source, "path": value, "status": "unsupported"})
                    continue
                if path in seen:
                    continue
                seen.add(path)
                status = "read" if path.is_dir() else "missing"
                roots.append({"source": source, "path": str(path), "status": status})
                if status != "read":
                    missing_paths.add(str(path))
                    fail_status(status)
            except (OSError, RuntimeError):
                roots.append({"source": source, "path": value, "status": "unreadable"})
                fail_status("unreadable")
    if roots[0]["status"] != "read":
        missing_paths.add(str(local))
        fail_status("missing")
    return roots
`;
