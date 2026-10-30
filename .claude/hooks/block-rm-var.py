#!/usr/bin/env python3
# PreToolUse hook (Bash): deny rm / rmdir / cp -R on a path built from a shell variable or
# command output. Claude Code's built-in safety check asks a human for these even in
# bypassPermissions mode (and can freeze background agents). Denying here first returns an
# error to the agent, which rewrites the command with a literal path or Python instead.
# Wired in .claude/settings.json. Same logic as the global hook we ran during the work.
import json, re, sys

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if data.get("tool_name") != "Bash":
    sys.exit(0)
cmd = (data.get("tool_input") or {}).get("command") or ""

# one shell command at a time: split on ; && || | and new lines
segments = re.split(r"\n|;|&&|\|\||\|", cmd)
DYNAMIC = re.compile(r"\$|`")
bad = None
for seg in segments:
    s = seg.strip()
    if re.match(r"(?:sudo\s+)?git\b", s):
        continue  # git rm only changes the index / tracked files
    m = re.search(r"(?:^|[\s(])(?:sudo\s+)?(?:command\s+)?(rm|rmdir)(\s+.*)?$", s)
    if m and DYNAMIC.search(m.group(2) or ""):
        bad = s
        break
    m = re.search(r"(?:^|[\s(])cp\s+(-[A-Za-z]*[rRa][A-Za-z]*\s+.*)$", s)
    if m and DYNAMIC.search(m.group(1)):
        bad = s
        break

if bad:
    reason = (
        "Blocked by .claude/hooks/block-rm-var.py: `" + bad[:160] + "` removes or copies a path "
        "built from a shell variable or command output. Claude Code would stop and ask the user "
        "for this even in bypass mode. Rewrite it without a variable in the rm/rmdir/cp -R target: "
        "use a literal absolute path, or do the clean-up in Python "
        "(e.g. python3 -c \"import shutil; shutil.rmtree('/abs/path', ignore_errors=True)\")."
    )
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                             "permissionDecision": "deny",
                                             "permissionDecisionReason": reason}}))
sys.exit(0)
