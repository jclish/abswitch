#!/bin/bash
# pack.sh — copy the SAVED documents into documents/ and build ~/abswitch.zip.
# Run after pressing ⌘S in PH-A, PH-B and PH-MASTER. Refuses unless the SAVED bundles carry
# the finished build (test/saved-docs-check.py: Layer Sets, Two Shot layout, crop filters) —
# the live app can be right while the file on disk is stale. It also refuses a package that
# carries this Mac's hostname, user name, home folder or LAN address (test/privacy-scan.py).
#   bash ~/abswitch/pack.sh            # documents from ~/Desktop
#   DOCS_DIR=/path bash pack.sh        # documents elsewhere
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="${DOCS_DIR:-$HOME/Desktop}"
out="$(dirname "$here")/abswitch.zip"

need() { # need <doc> <string that must be in the saved bundle>
  local f="$src/$1.tvshow"
  [ -d "$f" ] || { echo "REFUSED: $f not found"; exit 1; }
  grep -rqa -- "$2" "$f" || { echo "REFUSED: $1.tvshow has no \"$2\" — press ⌘S in $1 first (the saved file predates the build)"; exit 1; }
}
need PH-A TALLY
need PH-B TALLY
need PH-MASTER "AB Switcher"
# The TALLY crop filters were added after the first save; a stale save has the switcher but no crop.
need PH-MASTER "com.boinx.boinxtv.filter.transform"
# Full check of what was saved: Layer Sets, Two Shot layout, crop values.
python3 -I "$here/test/saved-docs-check.py" "$src" || { echo "REFUSED: the saved documents do not match the build — fix in the UI, ⌘S, re-run"; exit 1; }

rm -rf "$here"/documents/*.tvshow
for n in PH-A PH-B PH-MASTER; do cp -R "$src/$n.tvshow" "$here/documents/"; done
# Release hygiene: mask this Mac's hostname inside the packaged copies (same length, nothing else
# changes), prove the copies still pass the saved-files check, then refuse if anything in the
# package still names this machine, its user, home folder or LAN address.
python3 -I "$here/test/privacy-scan.py" --scrub-docs "$here/documents"
python3 -I "$here/test/saved-docs-check.py" "$here/documents" >/dev/null || { echo "REFUSED: the scrubbed document copies fail the saved-files check"; exit 1; }
python3 -I "$here/test/privacy-scan.py" "$here" || { echo "REFUSED: the package names this machine (see HIT lines); redact before packing"; exit 1; }
rm -f "$out"
( cd "$(dirname "$here")" && zip -qr -X "$out" "$(basename "$here")" -x '*.DS_Store' "$(basename "$here")/takectl.config.json" "$(basename "$here")/takectl.config.backup-*.json" "$(basename "$here")/thumbs/*" "$(basename "$here")/.git/*" )
echo "packed $out"; unzip -l "$out" | tail -1
