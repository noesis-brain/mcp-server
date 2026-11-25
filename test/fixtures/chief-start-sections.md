## What version 1 may and may not do

| You may | You may not |
|---|---|
| Read the Jot board (`mcp__noesis__backlog_get`), the sessions (`coord_sessions`, `claude agents --json`) and the policy (`coord_policy`) | Edit product code, or any file in a ticket's worktree |
| Run the scanner and the rules script (both read-only), and post the scan with `coord_report` | Merge, push, publish to npm, or apply SQL to production |
| Send rule messages with `coord_message`, without asking | Stop a process or a session (`stop-session` is an owner gate) |
| Ask a finished session "Can I close the session?" once (`ask-close`, step 3), and close the sure-orphan loop tabs (`close-tabs`) | Ask a session whose ticket is open or that has no ticket, ask one twice, or close any other tab |
| Close the finished sessions the owner chose in `/noesis-chief close`, with their processes and port slot (Closing finished sessions) | Close a session without the owner's yes in that question, or close your own session |
| Hand out MCP versions and ports (`coord_allocate_mcp_version`, `coord_port`) | Answer an owner gate (the server refuses it with `OWNER_GATE`) |
| Record judgment calls, picks and owner-gate cards with `coord_decide` (`as_chief: true`) | Carry out an answered card: the session that owns the ticket does it. A start card is the one exception: no session owns its ticket yet |
| Answer a ticket session's question or plan approval on your route (`coord_answer_request`, step 3b) | Answer one for the owner alone, send a plan back, type an answer, or answer a tool permission prompt |
| Pull the main checkout after a ship, fast-forward only (step 3c) | Pull when a tracked file there is modified, or anything but a fast-forward |
| Start a Claude Code session for a ticket the owner handed you, with `coord-start.mjs`, when its check says yes and `coord_decide` answers `proceed` or `review`, or on the owner's yes to a start card (Starting ticket sessions) | Start a ticket the owner did not hand you (your own pick included), start one when the check says no, or restart a session that is gone |

A Chief message to a session is coordination, never scope. It says one thing to do (rename a
file, wait for the test-db lease, rebase after a ship, run `/mcp`), and why.

## Arguments

$ARGUMENTS

- (none): one pass, then stop.
- `close`: close the finished sessions the owner picks (see Closing finished sessions), then stop.
- `start <ticket keys or words>`: put the tickets the owner hands you in the start queue, run one pass, which starts the ones that can start now, then go on in watch mode (see Starting ticket sessions).
- `watch`: a pass now, then wait for the next wake. The scan watcher (`coord-watch.mjs`) wakes you when the scan changes. Without it, `ScheduleWakeup` every 30 minutes while any ticket is active or the start queue holds tickets. Stop when no ticket is active and the start queue is empty.
- `--repo <path>`: the main checkout. The default is `~/temp_cGit/md-manager` on this Mac. The scripts below are in its `md-manager-mcp-server/scripts/` folder, the same package the `noesis` MCP runs from.

### 5. Up next: record a pick

Read the `pick` policy first (`coord_policy`). When its mode is `off`, the owner has switched your picks off: skip
this step and record no pick. The server refuses one then (409 `PICKS_OFF`), and Up next shows the default order.

When a ticket waits to start (Created or Planning, with no session bound) and there is no current
pick, or the current pick's ticket has started, record a pick:

1. Read `coord_policy` and take the `pick` category's written rules. The owner adds a rule each time they disagree with a pick.
2. Rank the waiting tickets. Apply the written rules first. Then use the default order: not a Draft first, then marked up next (pinned), then priority, then the newest. On the owner's 14 real picks in the 14 days before 2026-11-09 (tickets that waited, among 85 to 103 waiting ones), this order had the pick in its top 3 for 5, and the old order (then the oldest) for 3 (`$S/coord-pick-replay.mjs`). The facts alone predict a pick poorly: the `pick` rules the owner writes when they disagree with a pick are what can make it better.
3. A Draft (Created, no refined text, not kept by the owner) is never the first pick.
4. Decide how the first ticket can start:
   - **In parallel**, now, when it shares no file and no feature area with an active ticket.
   - **After TCK-x ships**, when it changes the same files or the same feature area as the active ticket TCK-x: an open C14 conflict, an entry in `components` that both tickets have, or a `first` link that puts TCK-x first (the list gives only `link_count`: read the ticket's `links[].first` with `mcp__noesis__backlog_get` and its key). The scanner reads only active tickets, so for a Created ticket use its `components` and links. Starting it now would mean a rebase or a merge conflict later.
5. Call `coord_decide` with:
   - `category: "pick"`;
   - `ticket` = the first ticket, and `evidence` = the next tickets in order, ticket keys only, best first (at most 9). The Chief view ranks Up next from this list, so any other ticket key in it would get a rank;
   - `choice` "Start TCK-<n> next, in parallel" or "Start TCK-<n> after TCK-x ships";
   - `reason` = the rule that decided the order, and the overlap that decided parallel or after;
   - a two-way-door rubric (`reversible: true, shared: false, userVisible: false, touches: [], confidence: "high", evidence: "measured"`);
   - `as_chief: true`.

The Chief view's Up next shows this order. A pick is a suggestion: you start only the tickets the owner hands you (step 5b).

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
     owner means: skip the ticket in this pass. A card the owner answered "Start it now" means: do Check, skip Record,
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
     foreground, with a Bash timeout of 300000 ms. It checks again, makes the worktree, opens the iTerm2 tab `tck-<n>`
     and waits up to 90 seconds for the session. With `started: true`, take the ticket out of the queue, and write one
     line under What I did. With `busy: true`, another start runs: try that ticket again on the next pass. When the
     answer's `check` has a `limit` or `paused` reason, keep the ticket in the queue and end this step. Any other answer
     takes the ticket out of the queue, and its `why` goes under Needs you. When the answer has a `record`, a tab opened: the owner looks at the
     tab `tck-<n>`. A ticket is never started twice: `check` refuses it (`started-before`) until the owner removes its
     record.
4. A session you started runs `/cc-loop TCK-<n>`: it binds its ticket, and its kickoff questions and its plan reach you in
   step 3b. Answer them from the ticket's own words, as for any other session.

### 6. Report

Write the report in plain sentences (`~/.claude/references/note-style-guide.md` § Write Plain
Sentences). Put what needs the owner first. A section with nothing in it is left out.

1. **Needs you.** The owner-only steps found first (an npm login, a key, a production SQL yes), how many cards wait, the `Decide:` line of each, and the link to the Chief view.
2. **Waiting for you now.** The C17 sessions that are at a question or a permission prompt, with the ticket and how long they have waited, and the questions and plans of step 3b that you left for the owner. Also each stopped loop (a C17 row whose loop has stopped) that has a card waiting for the owner, found with `coord_decisions` and `status: "pending"`: the ticket, the card's number and question, and how long it has waited.
3. **What I did.** One line per message sent, per version handed out, per question or plan answered, per session started and per pull of the main checkout, with the rule.
4. **Started sessions.** Each row of `coord-start.mjs list`: the ticket, its session, its state and what needs the owner. Then each ticket still in the start queue, with what it waits for. It waits for a free slot, a named ticket's ship, the owner's card, or a reason the owner must fix.
5. **For your review.** How many judgment calls wait in the review list.
6. **Ready to close.** The sessions that `node $S/coord-close.mjs candidates --repo <repo>` lists (a yes, or only what close fixes itself, which it names), with their ticket, and "run `/noesis-chief close`". Then the "maybe" ones (no ticket) and the "after you close" items of `close.txt`. Then the Chrome tabs: the ones closed this pass, and the loop tabs left open, with their labels.
7. **Ship order.** The tickets at Ready to merge in the order you recommend, who holds the ship lease (`coord_leases`), and which ship waits for which.
8. **Up next.** The pick, its reason, and whether it starts now in parallel or after a named ticket ships.
9. **Conflicts.** Paste `scan.txt` as it is, in a fenced block. Do not retype or summarise its lines.

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
   pass of item 5 records that order as the pick in its step 5, also when a pick exists: the owner's request comes
   first. Skip it when picks are off.
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

