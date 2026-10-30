---
description: Fix one bug test-first with the smallest change, in its own git worktree, one commit
argument-hint: <bug id and one-line description, e.g. "A6 OTP codes use Math.random">
---

Fix this bug: **$ARGUMENTS**

Start the `fixer` agent (`.claude/agents/fixer.md`) with `isolation: "worktree"`,
so it works in its own git worktree. Give it the bug and the expected
behaviour from `docs/ARCHITECTURE.md` / the ADRs. Follow the root `CLAUDE.md`.

The agent must:
1. Write a test that shows the bug. Run it on the old code and show it FAIL.
2. Make the smallest fix at the root cause, in the style of the code.
3. Run the test and show it PASS, then run the area's suite.
4. Keep API paths, request bodies, response shapes and status codes unchanged,
   unless the bug is exactly that.
5. If an existing test asserts the wrong behaviour, correct it in the same
   commit and say why in the commit body.
6. Make one commit for this bug, with the why in the message. No secrets.
   Use the user's git identity only; no AI signature lines.

When it reports, do not accept "fixed" without the FAIL output before and the
PASS output after. Read the diff yourself. Then tell the user: the test file,
the FAIL and PASS lines, the files changed, the commit, and anything the agent
saw but did not fix. Do not merge or push. The bug is done only after
`/blind-verify` passes it.
