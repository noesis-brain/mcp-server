---
description: Work a Noesis Jot ticket (TCK-<n>) from this Claude Code session — bind it, link the running session to it, keep its status current, refine its text within the word limit, reset the binding, or list your tickets.
argument-hint: TCK-<n> | link TCK-<n> [status] [--force] | status [<status>] | refine | reset | list
---

The Noesis Jot page is the user's quick-note board. Each ticket (TCK-<n>) shows a work status and which Claude Code session, on which computer, is working on it. This skill keeps that page true while you work.

The ticket tools (`mcp__noesis__backlog_bind`, `backlog_set_status`, `backlog_unbind`, `backlog_refine`, `backlog_get`) are bookkeeping on the user's own ticket, which the user asked for. Calling them in plan mode is expected.

## Arguments

$ARGUMENTS

## The status ladder

| Status | Set it when |
|---|---|
| `planning` | you start reading the ticket and the code, and writing a plan (plan mode) |
| `ready_to_implement` | your plan is presented and waits for the user's approval |
| `implementing` | the user approved the plan and you are building it |
| `iterating` | the first version is delivered; the user is testing it and asking for changes |
| `ready_to_merge` | you judge the work complete: every piece of feedback is done, or a `/cc-loop` reached LOOP COMPLETE. You wait for the user to say "ship it" |
| `deploying` | you are merging, pushing and verifying the deployment |
| `shipped` | the change is live in production |

`created` and `dropped` are the user's to set, on the page. Never skip a step you actually went through, and never claim a status you have not reached.

## Sub-commands

### `TCK-<n>` — start a ticket

1. `backlog_get(key)` and read the ticket: the refined text if there is one, otherwise the draft.
2. `backlog_bind(key)`. It sets `planning`.
3. Work on it. Move the status up the ladder as you go.

### `link TCK-<n> [status] [--force]` — link the session you are already in

Use it when this session is already working and the ticket was never handed over, or after `/clear`: you then no longer remember the ticket, and `link` tells you again which ticket it is and what status it has. (The binding keeps the session id the MCP server started with, which does not change on `/clear`.)

1. With a status, bind with that status. Without one, pick the status that matches where this session really is:
   - in plan mode → `planning`;
   - a plan presented and waiting → `ready_to_implement`;
   - an approved plan, and code being changed → `implementing`;
   - a first version delivered, and the user giving feedback → `iterating`;
   - a `/cc-loop` whose state file says COMPLETE → `ready_to_merge`.
2. `backlog_bind(key, status)`. Pass `force` only when the user wrote `--force`.
3. If the session has already made a plan, refine the ticket once (see `refine`).

If the ticket is bound to another session (`BOUND_ELSEWHERE`), tell the user which computer holds it and change nothing unless they wrote `--force`.

### `status [<status>]`

"This session's ticket" is the one you bound earlier in this conversation, or the one the `tck-session` reminder names. If you are not sure which it is, ask.

Without a status, show the bound ticket's key, status, computer and session. With one, `backlog_set_status(key, status)`.

### `refine`

Rewrite the ticket's text so it matches the agreed plan, and store it with `backlog_refine`. It must stay a jot:

- 70%–120% of the draft's word count (5 words of slack for short drafts; each Chinese, Japanese or Korean character counts as one word);
- the same language as the draft;
- plain sentences or a short list — no headings, no code fences, no increments, acceptance criteria or plan sections.

Refine once when your plan is ready, just before `ExitPlanMode`. Refine again only if the plan changes or the user asks. On `REFINE_LENGTH`, read `draft_words`, `min` and `max` from the error and rewrite to fit. The user's draft is never changed.

### `reset`

`backlog_unbind(key)` for this session's ticket. The status stays as it is.

### `list`

Call `backlog_get` with no filter, and keep the tickets whose status is in progress (`planning` to `deploying`). Show key, status, computer and the first line of each.

## New work in a bound session

This is the standard procedure, not a special case. When this session holds a ticket and a new plan starts, decide first whether the plan belongs to that ticket.

- **It belongs** (a fix, the next round, a change the user asked for): re-plan the same ticket. Set it to `planning`, refine its text again if the scope changed, and give it a short title if its title is the whole draft (`backlog_upsert_issue(key, title)`, using the user's first sentence). Ask nothing.
- **It does not belong, or it deserves its own ticket:** before `ExitPlanMode`, suggest a new ticket and say why in one sentence. The user may decline; then re-plan the same ticket as above. If they agree, do these steps in this order, because a status change needs the binding:
  1. Set the current ticket to the status it really reached (`backlog_set_status`).
  2. Create the new ticket with `backlog_upsert_issue`. Its text is the user's own words for the new request.
  3. A short session: `backlog_bind(new key, switch: true)`, which releases the old ticket. A long session: `backlog_unbind` the old ticket and leave the new one for a new session, which binds it there.
- **Not sure:** ask the user once.
- **A closed ticket never moves.** If the bound ticket is `shipped` or `dropped` and a new plan starts, release it or switch before you present the plan. The server refuses any change to a closed ticket (`TICKET_CLOSED`), and closing a ticket releases its binding.

## Rules

- One ticket per session. `SESSION_BUSY` means this session holds another ticket: switch (`switch: true`) only when the user clearly hands over the new one, never because a ticket is merely mentioned.
- `RESET_BY_OWNER` means the user reset this session's binding on the page. Bind again (`force: true`) only if the user asks.
- `TICKET_CLOSED` means the ticket is Shipped or Dropped. Do not retry and do not force it: only the user reopens a ticket, on the Jot page. For new work, create a new ticket that names the closed one.
- With the optional ticket hook (`noesis-mcp setup --with-ticket-hook`), the plan steps move by themselves: Ready to implement at `ExitPlanMode` (only from `planning`), Implementing when the plan is approved, and `planning` again when a presented plan is rejected. The hook changes no other status, so set every other one yourself — including `planning` before you re-plan a ticket that is further along.
- Never put the full plan on the ticket. Nobody reads the long version; the ticket stays a jot.
