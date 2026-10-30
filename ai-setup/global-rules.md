# Our global Claude Code rules (cleaned copy)

This is the part of our personal, global `CLAUDE.md` (in the user's home folder, not in this repo) that was active for the whole hackathon session. We removed rules that do not matter here (artifact publishing, Claude's own memory folder, commit message format). We kept the text, with spelling fixed.

These rules are ours. The `CLAUDE.md`, `AGENTS.md` and `.cursorrules` we were handed held false rules; we did not follow them, kept them as evidence in `ai-setup/handed-over/`, and replaced the root files with our own (see [README.md](../README.md#notes-in-this-repo-that-are-wrong)).

---

## Precision and concision
Be extremely concise. Use easy to understand language, talk in ASD-STE100 Simplified Technical English.

## Technical decisions
When making technical decisions, do not give much weight to development cost.
Instead, prefer quality, simplicity, robustness, scalability, and long term maintainability.

## Think before coding
State assumptions explicitly. If multiple interpretations exist, surface them — don't pick silently. If a simpler approach exists, say so. If something is unclear, stop and name what's confusing.

## Simplicity first
Minimum code that solves the problem. No speculative features, no abstractions for single-use code, no error handling for impossible scenarios. If you write 200 lines and it could be 50, rewrite it.

## No placeholders — do the actual work
Every feature you touch ships fully working. No "Coming Soon", no dummy data where logic belongs, no `// TODO` stubs, no naive regex hacks substituting for real logic. Complete end-to-end (frontend + backend + data). After implementation, run it, hit the endpoints, check the output — fix bugs you find in the same session. If it's too complex to finish properly, say so and ask. Never silently downgrade to half-working.

## Plan → implement → verify pipeline
Every non-trivial task:
1. **Interview** — clarifying questions first.
2. **Plan** — enter plan mode, present, wait for explicit approval.
3. **Implement via agents** — output-based goals ("fix the auth bug so users can log in"), not code-level instructions.
4. **Blind verification** — separate agent receives only the original requirements, NOT the implementation plan. Independently checks the code meets the goals.

Never skip straight to implementation. Never leak the impl plan to the verification agent.

## Goal-driven execution
Transform tasks into verifiable success criteria:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

Strong criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## Keep the platform in sync
Every feature, change, or fix must be reasoned about in terms of its related features and functionality — never land a change in isolation. Before implementing, map what else touches the same data, types, UI, or flow. Trace each ripple and update it in the same pass so the platform stays internally consistent. If a change would leave a related surface stale or half-updated, fix that surface too or call it out explicitly — don't ship drift.

## Decision tracking
When the user makes a product decision ("remove X", "we don't need Y", "keep Z"), save it immediately in the project's `memory.md`. Before merging any PR, check `memory.md` for product decisions that affect the merge.

## Shell deletes and copies
In Bash, never pass a shell variable or command output (`$VAR`, `${VAR}`, `$(...)`, backticks) to `rm`, `rmdir` or `cp -R`. Use a literal absolute path. A local hook blocks these commands.

## Emojis
Never use emojis.
