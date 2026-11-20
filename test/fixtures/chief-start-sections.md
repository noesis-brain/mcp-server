### 5b. Start the queued tickets (TCK-1974)

Do this step when `~/.claude/coord/start-queue.json` holds tickets, or when `coord-start.mjs list` has a row whose
ticket is still open. It starts sessions only in watch mode, or in the pass that `/noesis-chief start` runs. A pass
with no argument starts nothing: it only names the queue in the report.

1. Run `node $S/coord-start.mjs list --repo <repo> --json`. Each row with `needsYou` goes under Needs you in the report.
   It names a session that has not bound its ticket after 10 minutes, a session that is gone while its ticket is open,
   or a start that found no session. Never restart a gone session, and never stop one: `stop-session` is an owner gate.
2. Take out of the queue each ticket that is now Shipped, Merged or Dropped. Take out, too, each ticket that a session
   holds: that one has started.
3. Then go through the queue in order, one ticket after the other. Do these five steps for each ticket, in this order:
   - **Overlap.** A ticket that changes the same files or the same feature area as an active ticket waits until that
     ticket ships. A ticket you started, in this pass or before, counts as active too. The signs are an open C14
     conflict, an entry in `components` that both tickets have, or a `first` link that puts the other ticket first.
     Read the `links` with `mcp__noesis__backlog_get` and the ticket's key. Write "after TCK-x ships" in the report,
     and go on to the next ticket.
   - **Card.** Call `coord_decisions` with `category: "start"` and the `ticket`, and look only at the cards created
     after the ticket's `at` in the queue: an older card belongs to an older request. A card that still waits for the
     owner means: skip the ticket in this pass. A card the owner answered "Start it now" means: skip Check and Record,
     and go to Start. A card answered "Not now" means: take the ticket out of the queue.
   - **Check.** Run `node $S/coord-start.mjs check --ticket <key> --repo <repo> --self-pid $PPID --json`. A `limit` or
     `paused` reason ends this step: the tickets after it wait. A `closed`, `started`, `bound`, `not-found` or
     `started-before` reason takes the ticket out of the queue. Any other reason keeps it in the queue, with the reason
     in the report. It goes under Needs you when only the owner can fix it, such as `dirty`, `folder-taken`,
     `wrong-branch` or `config`.
   - **Record.** Call `coord_decide` with `category: "start"`, `ticket`, `choice` "Start a session for TCK-<n>", `reason`,
     `evidence` = the ticket key, `undo` "the owner stops the session: `stop-session` is an owner gate", and
     `as_chief: true`. The `reason` names the owner's request, the free slot and why no ticket overlaps. The rubric is `reversible: true, shared: true, userVisible: false, touches: [], confidence:
     "high", evidence: "measured"`. The answer `proceed` or `review` means: go to Start. `CARD_REQUIRED` means that the
     owner keeps the starts: the `start` mode is off, or the level is above the highest level they allow. Then send a
     card (step 4), "Start a session for TCK-<n> now?", with the options "Start it now" and "Not now: take it out of the
     queue". Do not start the ticket in this pass: the Card step starts it once the owner answers "Start it now". A
     start card is the one card you carry out yourself, because no session owns its ticket yet. Any other error means:
     do not start, and name it under Needs you.
   - **Start.** Run `node $S/coord-start.mjs start --ticket <key> --repo <repo> --self-pid $PPID --json` in the
     foreground. It checks again, makes the worktree, opens the iTerm2 tab `tck-<n>` and waits up to 90 seconds for the
     session. With `started: true`, take the ticket out of the queue, and write one line under What I did. With
     `busy: true`, another start runs: try that ticket again on the next pass. Any other answer takes the ticket out of
     the queue, and its `why` goes under Needs you. When the answer has a `record`, a tab opened: the owner looks at the
     tab `tck-<n>`. A ticket is never started twice: `check` refuses it (`started-before`) until the owner removes its
     record.
4. A session you started runs `/cc-loop TCK-<n>`: it binds its ticket, and its kickoff questions and its plan reach you in
   step 3b. Answer them from the ticket's own words, as for any other session.

## Starting ticket sessions (`/noesis-chief start`)

The owner hands you tickets, and you start a Claude Code session for each one and watch it. You start only what the
owner handed you: never your own pick alone. Each session runs `/cc-loop TCK-<n>` in its own worktree, in a new iTerm2
tab next to your own tab.

1. **Read the request.** Ticket keys ("start TCK-1968 TCK-1969", "TCK-1968 to TCK-1973") name those tickets. Words name
   the tickets that match them, among the tickets that wait to start. Read those with `mcp__noesis__backlog_get`
   (`status: "created"`, then `status: "planning"`, `images: false`), and leave out every ticket a session holds. The
   words rule:
   - Every word must match: "recent bugs" means a bug that was created in the last 7 days.
   - "bug" or "bugs" means `kind` bug, and "feature" means `kind` feature.
   - "recent", "recently found" or "new" means created in the last 7 days, unless the words give another time.
   - "high priority" means `priority` high or urgent.
   - The name of a feature or an area means that word in the title, the refined text or the `components`.
   - A Draft that the words match is included: the owner named it.
   - When nothing matches, start nothing, and say which words matched no ticket.
2. **Leave out** a Shipped, Merged or Dropped ticket and a ticket a session holds. Name each one in the report.
3. **Order them** the way step 5 ranks waiting tickets: the written `pick` rules first, then the default order. The
   pass of item 5 records that order as the pick in its step 5, unless picks are off.
4. **Write the queue** to `~/.claude/coord/start-queue.json`:
   `{"tickets": [{"key": "TCK-…", "at": "<ISO time>", "request": "<the owner's words>"}]}`. A later request adds
   its tickets at the end, each with its own time, and a ticket is never in the queue twice. When the owner asks you
   to drop a ticket from the queue, take it out of the file.
5. **Run one pass** (steps 0–6, step 5b included), then go on in watch mode: the queue needs you awake until it is empty.

The limit is in `~/.claude/coord/start.json`, with the default `{"maxSessions": 4, "claudeArgs":
["--dangerously-skip-permissions", "--chrome"]}`. The owner changes the limit there. The check counts every live local
session that holds an open ticket, the owner's own sessions too, and each session you started that has not bound its
ticket yet. Your own session is not counted.

`coord-start.mjs start` answers Claude Code's folder-trust dialog only for the worktree it has just made, and only by
choosing "Yes, I trust this folder". It never presses Enter on "No, exit". Claude Code keeps that trust on the
main checkout, so the worktrees of a trusted repository show no dialog at all. The tab shows the ticket in its name,
and `/noesis-chief close` closes a finished session you started like any other.

