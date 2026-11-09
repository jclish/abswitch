#!/usr/bin/env python3
"""privacy-scan: keep the packing Mac's identity out of the release package.

    python3 -I test/privacy-scan.py DIR                # scan every file under DIR; exit 1 on any hit
    python3 -I test/privacy-scan.py --scrub-docs DIR   # mask the hostname inside DIR/*.tvshow, then exit

What it looks for is read from THIS machine when it runs (hostname, computer name, user name,
home folder, LAN addresses), so the script itself carries none of them. Text and binary files
are both scanned, case-insensitively. takectl.config.json and .git/ are skipped: neither ships in the zip.

--scrub-docs: mimoLive's saved documents are binary plists, and PH-MASTER's NDI sources store
"<HOSTNAME>.LOCAL (PHA)" (the sender's machine). The hostname is overwritten in place with a
placeholder of the same length and case, so no offset in the plist moves and nothing else in the
file changes. On another Mac the sources have to be re-pointed anyway; the build script does it
(documents/README.md).
"""
import getpass
import os
import plistlib
import re
import socket
import subprocess
import sys

SKIP = {"takectl.config.json", ".DS_Store"}


def sh(*cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return ""


def identifiers():
    ids = {}
    host = socket.gethostname().split(".")[0]
    if host:
        ids["hostname"] = host
    for kind, val in (("computer name", sh("scutil", "--get", "ComputerName")),
                      ("local host name", sh("scutil", "--get", "LocalHostName"))):
        if val and val.lower() != host.lower():
            ids[kind] = val
    ids["user name"] = getpass.getuser()
    ids["home folder"] = os.path.expanduser("~")
    for i in range(10):
        ip = sh("ipconfig", "getifaddr", f"en{i}")
        if ip:
            ids[f"LAN address (en{i})"] = ip
    return {k: v for k, v in ids.items() if v and len(v) >= 4}


def placeholder(match, base="STUDIO-MAC-MINI"):
    n = len(match)
    p = base[:n] if n <= len(base) else base + "-" + "0" * (n - len(base) - 1)
    if match.isupper():
        return p.upper()
    if match.islower():
        return p.lower()
    return p.title()


def scrub_docs(root):
    host = socket.gethostname().split(".")[0]
    rx = re.compile(re.escape(host.encode()), re.I)
    changed = 0
    for dirpath, _, files in os.walk(root):
        if ".tvshow" not in dirpath:
            continue
        for f in files:
            path = os.path.join(dirpath, f)
            data = open(path, "rb").read()
            new = rx.sub(lambda m: placeholder(m.group(0).decode()).encode(), data)
            if new == data:
                continue
            assert len(new) == len(data)
            if f.endswith(".plist"):
                plistlib.loads(new)  # must still parse; raises (and nothing is written) if not
            open(path, "wb").write(new)
            changed += 1
            print(f"scrubbed hostname in {os.path.relpath(path, root)} ({len(rx.findall(data))} places, same length)")
    print(f"documents scrubbed: {changed} file(s)")


def scan(root):
    ids = identifiers()
    hits = []
    for dirpath, dirnames, files in os.walk(root):
        dirnames[:] = [d for d in dirnames if d != ".git"]  # git's own metadata is not part of the package
        for f in files:
            if f in SKIP:
                continue
            path = os.path.join(dirpath, f)
            low = open(path, "rb").read().lower()
            for kind, val in ids.items():
                if val.lower().encode() in low:
                    hits.append(f"{os.path.relpath(path, root)}: {kind}")
    print(f"privacy scan of {root}: looked for {', '.join(ids)}")
    print("\n".join("HIT " + h for h in hits) if hits else "privacy scan: no hits")
    return 1 if hits else 0


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--scrub-docs":
        scrub_docs(sys.argv[2])
        sys.exit(0)
    sys.exit(scan(sys.argv[1] if len(sys.argv) > 1 else "."))
