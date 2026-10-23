from __future__ import annotations

import hmac
import json
import re
from urllib.parse import parse_qs

from starlette.responses import HTMLResponse, JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

DISCOVERY = frozenset({"/boards", "/profiles", "/workflow"})
READ_ROUTES = re.compile(r"/(?:board|stats|assignees|diagnostics|tasks/[A-Za-z0-9_-]+(?:/attachments|/log)?|runs/[0-9]+|attachments/[0-9]+)")
WRITE_ROUTES = {
    "POST": re.compile(r"/(?:tasks|tasks/bulk|tasks/[A-Za-z0-9_-]+/comments|links)"),
    "PATCH": re.compile(r"/tasks/[A-Za-z0-9_-]+"),
    "DELETE": re.compile(r"/links"),
}


class FixtureBoundary:
    def __init__(self, app: ASGIApp, token: str) -> None:
        self.app = app
        self.token = token

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return
        query = parse_qs(scope["query_string"].decode("ascii", errors="replace"), keep_blank_values=True)
        path = scope["path"]
        websocket = scope["type"] == "websocket"
        if not websocket and path == "/" and scope["method"] == "GET":
            response = HTMLResponse("<!doctype html><script>window.__HERMES_SESSION_TOKEN__=" + json.dumps(self.token) + ";</script>")
            response.headers["cache-control"] = "no-store"
            await response(scope, receive, send)
            return
        headers = dict(scope["headers"])
        supplied = query.get("token", [""])[0] if websocket else headers.get(b"x-hermes-session-token", b"").decode("ascii", errors="replace")
        status = 403
        if not hmac.compare_digest(supplied, self.token):
            status = 401
        elif not websocket and path in {"/__fixture/ready", "/api/status"} and scope["method"] == "GET":
            await JSONResponse({"ready": True, "auth_required": False, "mode": "native"})(scope, receive, send)
            return
        elif path.startswith("/api/plugins/kanban/") and query.get("profile") == ["default"]:
            route = path.removeprefix("/api/plugins/kanban")
            board = query.get("board")
            scoped = board in (["default"], ["xia-dev"])
            readable = not websocket and scope["method"] == "GET" and (route in DISCOVERY or scoped and READ_ROUTES.fullmatch(route))
            writable = not websocket and scoped and bool(WRITE_ROUTES.get(scope["method"], re.compile(r"(?!)")).fullmatch(route))
            if route == "/tasks/bulk" and scope.get("method") != "POST":
                readable = writable = False
            if writable and route == "/tasks/bulk":
                # This QA-only gate accepts the native bulk body's bounded safe subset.
                # No archive/delete/reclaim or arbitrary task IDs can reach the router.
                chunks = []
                size = 0
                while True:
                    message = await receive()
                    if message.get("type") != "http.request":
                        writable = False
                        break
                    chunk = message.get("body", b"")
                    size += len(chunk)
                    if size > 65536:
                        writable = False
                        break
                    chunks.append(chunk)
                    if not message.get("more_body", False):
                        break
                raw = b"".join(chunks)
                try:
                    body = json.loads(raw)
                    allowed = {"ids", "status", "priority", "assignee", "result", "summary", "reclaim_first"}
                    valid = isinstance(body, dict) and set(body) <= allowed and set(query) == {"profile", "board"}
                    ids = body.get("ids") if isinstance(body, dict) else None
                    valid = valid and isinstance(ids, list) and 1 <= len(ids) <= 100 and all(isinstance(i, str) and re.fullmatch(r"qa22-[A-Za-z0-9_-]{1,48}", i) for i in ids) and len(set(ids)) == len(ids)
                    valid = valid and ("status" not in body or body["status"] in {"todo", "ready", "blocked", "done"})
                    valid = valid and ("priority" not in body or type(body["priority"]) is int and -100 <= body["priority"] <= 100)
                    valid = valid and ("assignee" not in body or body["assignee"] in {"", "default", "xia", "another", "empty"})
                    valid = valid and all(key not in body or isinstance(body[key], str) and len(body[key]) <= 4096 for key in ("result", "summary"))
                    valid = valid and ("reclaim_first" not in body or body["reclaim_first"] is False)
                    writable = writable and valid
                except (ValueError, TypeError):
                    writable = False
                if writable:
                    async def replay() -> Message:
                        return {"type": "http.request", "body": raw, "more_body": False}
                    await self.app(scope, replay, send)
                    return
            elif readable or writable or websocket and scoped and route == "/events":
                await self.app(scope, receive, send)
                return
        if websocket:
            await send({"type": "websocket.close", "code": 4401 if status == 401 else 4403})
        else:
            await JSONResponse({"error": "fixture boundary refused request"}, status_code=status)(scope, receive, send)
