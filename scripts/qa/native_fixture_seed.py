from __future__ import annotations

from contextlib import closing
import json
from pathlib import Path


def seed(root: Path) -> None:
    from hermes_cli import kanban_db as kb
    from hermes_cli import kanban_db_connect as kbc

    home = root / "home"
    for name in ("xia", "empty"):
        profile = home / "profiles" / name
        profile.mkdir(parents=True, exist_ok=True)
        (profile / "config.yaml").write_text("model: {}\n")
    (home / "config.yaml").write_text("model: {}\n")
    kb.init_db(board="default")
    kb.create_board("xia-dev", name="Xia development")
    for board in ("default", "xia-dev"):
        with closing(kbc.connect(board=board)) as connection:
            if connection.execute("SELECT 1 FROM tasks WHERE id='repeat-001'").fetchone():
                continue
            task_id = kb.create_task(connection, title="Synthetic review cycle", assignee="xia", created_by="default", board=board)
            connection.execute("PRAGMA foreign_keys=OFF")
            connection.execute("UPDATE tasks SET id='repeat-001' WHERE id=?", (task_id,))
            connection.execute("UPDATE task_events SET task_id='repeat-001' WHERE task_id=?", (task_id,))
            connection.execute("PRAGMA foreign_keys=ON")
            events = (("review_requested", {"from": "xia", "assignee": "default"}),
                      ("review_changes_requested", {"from": "default", "assignee": "xia"}),
                      ("review_requested", {"from": "xia", "assignee": "default"}),
                      ("reassigned", {"assignee": "xia"}))
            with kb.write_txn(connection):
                for kind, payload in events:
                    connection.execute("INSERT INTO task_events(task_id,kind,payload,created_at) VALUES(?,?,?,?)",
                                       ("repeat-001", kind, json.dumps(payload), 1792627200))
