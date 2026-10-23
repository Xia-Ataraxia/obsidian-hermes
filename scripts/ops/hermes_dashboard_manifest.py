from __future__ import annotations

import json
import re
from typing import TypedDict
from collections.abc import Callable

Json = str | int | float | bool | None | list['Json'] | dict[str, 'Json']
decode_json: Callable[[bytes], Json] = json.loads


class Refusal(RuntimeError):
    pass


class Asset(TypedDict):
    path: str
    backup: str
    sha256: str
    bytes: int
    mode: int
    restore: bool


class Manifest(TypedDict):
    schema: int
    root: str
    service: str
    files: list[Asset]
    boardDatabasesIncluded: bool
    configRestore: str
    oldMemoryProcessRestorable: bool


def parse_asset(value: Json) -> Asset:
    if not isinstance(value, dict) or set(value) != {'path', 'backup', 'sha256', 'bytes', 'mode', 'restore'}:
        raise Refusal('malformed recovery entry')
    path, backup, sha = value['path'], value['backup'], value['sha256']
    size, mode, restore = value['bytes'], value['mode'], value['restore']
    if not isinstance(path, str) or not isinstance(backup, str) or not isinstance(sha, str):
        raise Refusal('invalid recovery path or hash type')
    if not re.fullmatch(r'asset-[0-9]{4,}', backup) or not re.fullmatch(r'[a-f0-9]{64}', sha):
        raise Refusal('invalid recovery asset name or hash')
    if type(size) is not int or size < 0 or type(mode) is not int or mode & ~0o777 or type(restore) is not bool:
        raise Refusal('invalid recovery metadata')
    return {'path': path, 'backup': backup, 'sha256': sha, 'bytes': size, 'mode': mode, 'restore': restore}


def parse_manifest(data: bytes, root: str, service: str) -> Manifest:
    value = decode_json(data)
    keys = {'schema', 'root', 'service', 'files', 'boardDatabasesIncluded', 'configRestore', 'oldMemoryProcessRestorable'}
    if not isinstance(value, dict) or set(value) != keys:
        raise Refusal('malformed recovery manifest')
    if type(value['schema']) is not int or value['schema'] != 1 or value['root'] != root or value['service'] != service:
        raise Refusal('invalid recovery manifest identity')
    entries, config = value['files'], value['configRestore']
    if not isinstance(entries, list) or not entries or not isinstance(config, str):
        raise Refusal('empty or malformed recovery manifest')
    if value['boardDatabasesIncluded'] is not False or value['oldMemoryProcessRestorable'] is not False:
        raise Refusal('unsupported recovery scope')
    return {'schema': 1, 'root': root, 'service': service, 'files': [parse_asset(entry) for entry in entries],
            'boardDatabasesIncluded': False, 'configRestore': config, 'oldMemoryProcessRestorable': False}


def parse_expected(data: bytes) -> dict[str, str | None]:
    value = decode_json(data)
    if not isinstance(value, dict):
        raise Refusal('expected-current must be a path to hash-or-null object')
    result: dict[str, str | None] = {}
    for path, state in value.items():
        if state is None:
            result[path] = None
        elif isinstance(state, str) and re.fullmatch(r'[a-f0-9]{64}', state):
            result[path] = state
        else:
            raise Refusal('expected-current values must be SHA-256 or explicit null for owned absence')
    return result
