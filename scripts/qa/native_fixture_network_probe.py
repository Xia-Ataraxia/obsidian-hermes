from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import socket
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.qa.native_fixture_guard import FixtureRefusal, isolate, owned_root

parser = argparse.ArgumentParser()
parser.add_argument("root")
parser.add_argument("--expect-vulnerable", action="store_true")
args = parser.parse_args()
root = owned_root(args.root)
results = {}
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as recipient, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sender, socket.socket() as tcp:
    recipient.bind(("127.0.0.1", 0))
    recipient.settimeout(0.2)
    tcp.bind(("127.0.0.1", 0))
    tcp.listen(1)
    target = recipient.getsockname()
    tcp_target = tcp.getsockname()
    isolate(root)
    for name in ("sendto", "sendmsg"):
        payload = ("synthetic-loopback-" + name).encode()
        try:
            if name == "sendto":
                sender.sendto(payload, target)
            else:
                sender.sendmsg([payload], [], 0, target)
        except FixtureRefusal as error:
            assert not args.expect_vulnerable, name
            assert "socket." + name in str(error)
            try:
                recipient.recvfrom(256)
            except TimeoutError:
                results[name] = {"refused": True, "delivered": False}
            else:
                raise AssertionError("datagram delivered after refusal")
        else:
            assert args.expect_vulnerable, name
            assert recipient.recvfrom(256)[0] == payload
            results[name] = {"refused": False, "delivered": True}
    for name in ("connect", "getaddrinfo"):
        try:
            if name == "connect":
                with socket.socket() as client:
                    client.connect(tcp_target)
            else:
                socket.getaddrinfo("127.0.0.1", 1)
        except FixtureRefusal as error:
            assert "socket." + name in str(error)
            results[name] = {"refused": True}
        else:
            raise AssertionError(name + " was allowed")
    tcp.setblocking(False)
    try:
        connection, _ = tcp.accept()
    except BlockingIOError:
        results["tcpAcceptedConnections"] = 0
    else:
        connection.close()
        raise AssertionError("TCP connection escaped refusal")
assert recipient.fileno() == sender.fileno() == tcp.fileno() == -1
mode = "before" if args.expect_vulnerable else "after"
receipt = {"mode": mode, "results": results, "target": target, "tcpTarget": tcp_target,
           "destinations": "numeric loopback only; no external packet or DNS query", "socketsClosed": True,
           "guardSha256": hashlib.sha256(Path(__file__).with_name("native_fixture_guard.py").read_bytes()).hexdigest(),
           "probeSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
(root / ("evidence/native-network-" + mode + ".json")).write_text(json.dumps(receipt, indent=2)+"\n")
print(json.dumps({"pass": True, "mode": mode, "results": results}))
