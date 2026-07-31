# CLAUDE.md — database

## Never read these whole

These files will consume most or all of a context window on a single Read.
Query them instead.

| File | Lines | How to inspect |
|---|---|---|
| `server.js` | ~9,800 | Grep for the route or handler, then Read with `offset`/`limit` |
| `aircraft.json` | ~8,500 | `jq '.[0]'`, `jq 'length'`, or Grep for the registration |
| `package-lock.json` | ~4,700 | never read; use `npm ls <pkg>` |
| `bot.js` | ~4,100 | Grep for the command name, then Read the window |
| `vaPortal.js` / `va-portal.html` | ~2,200 each | Grep first |
| `uploads/**` | binary | never read |

For any file over ~800 lines: Grep for the symbol first, then Read a window
around the hit. Do not Read top-to-bottom to "get oriented."

## Finding code

1. Grep with `output_mode: "files_with_matches"` to locate.
2. Grep with `output_mode: "content"` and `-C 5` to confirm.
3. Read only the confirmed range with `offset`/`limit`.

Skip straight to Read only when the path is already known and the file is small.

## Editing

- Use Edit on existing files. Never Write a whole file to change part of it —
  rewriting `server.js` to fix one route costs ~9,800 lines of output tokens.
- Do not re-read a file to verify an edit landed. Edit fails loudly if the
  match was wrong; silence means it worked.
- Batch independent tool calls into one block rather than one per turn.

## Verifying

Run the narrowest check that proves the change: the single affected test, or a
targeted Grep. Do not re-run a full suite to confirm a one-line fix.

Use `git diff --stat` before `git diff`. Prefer `git diff -- <path>` over the
whole working tree.

## Responses

- Lead with the answer or the result. No preamble, no "Great question!", no
  closing summary of what was just done.
- Never paste back code that was just written or edited — reference it as
  `server.js:1420`.
- Report file contents by reference, not by quoting the file into chat.
- State a recommendation instead of enumerating every option considered.
- If a requirement is genuinely ambiguous, ask once before building — a wrong
  build and its rewrite cost far more than the question.

## Subagents

Do not spawn subagents unless explicitly asked. Each one starts cold and
re-derives context this session already holds, which multiplies token use
rather than saving it.
