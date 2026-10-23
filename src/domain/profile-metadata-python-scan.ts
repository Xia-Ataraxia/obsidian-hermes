export const PROFILE_METADATA_SCAN_PYTHON = String.raw`
EXCLUDED: Final = frozenset((".git", ".github", ".hub", ".archive", ".curator_backups", ".locks", ".venv", "venv", "node_modules", "site-packages", "__pycache__", ".tox", ".nox", ".pytest_cache", ".mypy_cache", ".ruff_cache"))
SUPPORT: Final = frozenset(("references", "templates", "assets", "scripts"))

def scan_candidates(roots: list[Root], result: list[Candidate]) -> None:
    global directory_count
    for selected in roots:
        if selected["status"] != "read":
            continue
        base = Path(selected["path"])
        pending = [(base, frozenset(), 0)]
        while pending:
            tick()
            current, ancestors, depth = pending.pop()
            directory_count += 1
            if directory_count > limits["directories"]:
                raise BudgetError("row-cap")
            if depth > limits["depth"]:
                reasons.add("row-cap")
                continue
            if any(part in EXCLUDED for part in current.parts):
                continue
            try:
                canonical = current.resolve()
                if canonical in ancestors:
                    reasons.add("unsupported-schema")
                    continue
                before = current.stat()
                signatures[str(current)] = signature(before)
                entries = []
                with os.scandir(current) as iterator:
                    for entry in iterator:
                        tick()
                        if len(entries) >= limits["directories"]:
                            raise BudgetError("row-cap")
                        entries.append(entry)
                entries.sort(key=lambda item: item.name)
                has_skill = any(entry.name == "SKILL.md" and not entry.is_dir(follow_symlinks=True) for entry in entries)
                for entry in entries:
                    path = current / entry.name
                    if entry.is_dir(follow_symlinks=True):
                        if entry.name not in EXCLUDED and not (has_skill and entry.name in SUPPORT):
                            pending.append((path, ancestors | {canonical}, depth + 1))
                    elif entry.name == "SKILL.md":
                        if len(result) >= limits["candidates"]:
                            raise BudgetError("row-cap")
                        metadata_status, name, restrictions, digest = skill_metadata(path)
                        result.append({"source": selected["source"], "root": str(base), "path": str(path), "canonicalPath": str(path.resolve()), "declaredName": name, "name": name[:64] if name is not None else None, "relativePath": path.parent.relative_to(base).as_posix(), "digest": digest, "metadataStatus": metadata_status, "restrictions": restrictions, "provenance": "unknown"})
                if signature(before) != signature(current.stat()):
                    fail_status("changed")
            except (OSError, RuntimeError):
                selected["status"] = "unreadable"
                fail_status("unreadable")
    root_order = {selected["path"]: index for index, selected in enumerate(roots)}
    result.sort(key=lambda row: (root_order[row["root"]], row["path"]))

def manifest_names(path: Path, bundled: bool) -> tuple[str, set[str]]:
    data = read_file(path)
    names = set()
    if data["status"] == "read":
        for raw in data["text"].splitlines():
            tick()
            line = raw.strip()
            if line and (bundled or not line.startswith("#")):
                name = line.split(":", 1)[0].strip() if bundled else line
                if not clean_text(name) or len(names) >= limits["candidates"]:
                    fail_status("malformed")
                    return "malformed", set()
                if name:
                    names.add(name)
    return data["status"], names

def hub_names(local: Path) -> tuple[str, set[str]]:
    data = read_file(local / ".hub" / "lock.json")
    if data["status"] != "read":
        return data["status"], set()
    try:
        parsed = json.loads(data["text"])
    except (json.JSONDecodeError, RecursionError):
        fail_status("malformed")
        return "malformed", set()
    installed = parsed.get("installed") if isinstance(parsed, dict) else None
    if not isinstance(installed, dict) or len(installed) > limits["candidates"] or any(not isinstance(name, str) or not clean_text(name) for name in installed):
        fail_status("malformed")
        return "malformed", set()
    names = set(installed)
    for entry in installed.values():
        tick()
        if not isinstance(entry, dict):
            fail_status("malformed")
            return "malformed", set()
        install_path = entry.get("install_path")
        if not isinstance(install_path, str) or not install_path.strip():
            continue
        try:
            resolved = (local / install_path).resolve()
            if not resolved.is_relative_to(local.resolve()):
                continue
            target = resolved / "SKILL.md"
            if not target.exists():
                continue
            read = read_file(target)
            if read["status"] != "read":
                return read["status"], set()
            lines = [line.strip() for line in read["text"][:4000].split("\n")]
            name = resolved.name
            if "---" in lines:
                block = lines[lines.index("---") + 1:]
                block = block[:block.index("---")] if "---" in block else block
                declared = [line.split(":", 1)[1].strip().strip("\"'") for line in block if line.startswith("name:")]
                name = next((value for value in declared if value), name)
            if not clean_text(name):
                fail_status("malformed")
                return "malformed", set()
            names.add(name)
        except (OSError, RuntimeError):
            fail_status("unreadable")
            return "unreadable", set()
    return "read", names

def provenance(candidates: list[Candidate], roots: list[Root]) -> dict[str, str]:
    local = home / "skills"
    bundled_status, bundled = manifest_names(local / ".bundled_manifest", True)
    suppressed_status, suppressed = manifest_names(local / ".curator_suppressed", False)
    hub_status, hub = hub_names(local)
    bundled |= suppressed
    manifests = {"bundled": bundled_status, "suppressed": suppressed_status, "hub": hub_status}
    external = {row["declaredName"] for row in candidates if row["source"] in ("create", "external") and row["metadataStatus"] == "read"}
    complete = all(status == "read" for status in manifests.values()) and all(row["metadataStatus"] == "read" for row in candidates) and all(row["status"] == "read" for row in roots)
    for row in candidates:
        name = row["name"]
        if hub_status == "read" and name in hub:
            row["provenance"] = "hub"
        elif hub_status == "read" and bundled_status == "read" and suppressed_status == "read" and name in bundled:
            row["provenance"] = "bundled"
        elif complete:
            row["provenance"] = "external" if name in external else "agent"
    return manifests
`;
