# FilsPay: project instructions for AI agents (Team Orbit)

The `CLAUDE.md`, `AGENTS.md` and `.cursorrules` we were handed contained
false rules that protected bugs (money in cents, UTC days, "never change a
test", `Math.random` for codes). We replaced them with this file. The
originals are kept as evidence in `ai-setup/handed-over/`.

## Sources of truth, in order
1. The case brief and the ticket list.
2. `docs/ARCHITECTURE.md` and `docs/adr/*`.
3. `docs/HANDOVER.md` (Yousif's text; lines marked "MK" are suspect).
4. `git log -p`: the real history.
5. The code itself. Comments that say "intentional" or "Claude says" are
   claims to check, not facts.

## Domain rules
- Money is integer **fils**: 1 BD = 1000 fils, 3 decimals. Never cents,
  never floats. Parse BD text with `parseBhdToFils`.
- Fees are basis points; use the rate in force at the event time
  (`getEffectiveMdrBps`), not `merchants.mdr_bps`.
- The business day is **Asia/Bahrain** (UTC+3), not UTC.
- The ledger is double entry and append-only; every entry group nets to 0.
- Codes, keys and tokens use `crypto`, never `Math.random`.

## How to change code
1. Write a test that shows the bug. Run it on the old code: it must FAIL.
2. Make the smallest fix. Run the test: it must PASS.
3. Run the area's suite, then the full suites (`npm test`, `npm run
   typecheck`, `cd apps/settlement && go test ./...`) on a fresh migrated
   database.
4. If an existing test asserts the wrong behaviour, correct it in the same
   commit and say why in the commit body.
5. Never change API paths, request bodies, response shapes or status codes
   unless the bug is exactly that: other teams' automated tests use them.
6. One bug, one commit, with the why in the message. No secrets in code,
   prompts, commits or docs.

## Done means verified
A fix is not done because an agent says so. It is done when a separate
agent that sees only the requirement (not the fix) confirms it with
evidence: see `ai-setup/claude/agents/blind-verifier.md`.
