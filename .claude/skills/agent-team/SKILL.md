---
name: agent-team
description: Run a twobullets phase with a parallel agent team — plan, contracts, file ownership, briefs, relaying, integration. Use whenever the user asks to build a feature or "spawn a team".
---

# Running a phase with an agent team

You are the lead. Implementation goes to agents; you plan, brief, relay, verify, commit.

## 1. Plan
- Read the relevant docs (`docs/**`, `CLAUDE.md`, memory snapshot) and `git status`/`git log`. Decide the workstreams.
- If the phase needs new shared interfaces, either:
  - run a **phase-1 architect agent** first (it writes pure shared rules and contracts plus a design doc with a phase-2 breakdown and file ownership), or
  - for small phases, spawn the agents directly with interfaces spelled out in their briefs.
- Check memory: `sysctl vm.swapusage`. Keep ≤4 heavy agents at once, and stagger into waves if needed.

## 2. Brief template (every agent)
1. **Role and game context:** realistic PUBG-like BR, current commit, what exists. Point to docs to read first.
2. **Team:** who else runs in parallel and which files they own ("don't edit their files").
3. **Files you OWN:** exact globs. Say explicitly: no package.json edits or installs unless the agent is the one designated for that.
4. **Contracts to keep:** additive-only changes to shared types; the exact names of attach hooks other agents will call.
5. **Tasks:** concrete, with numbers and realism targets.
6. **Machine resources:**
   - no dev server (lead's Vite on :5173)
   - no browser automation
   - self-terminating scripts: `setTimeout(() => process.exit(2), N).unref()`
   - one heavy process at a time
   - scratch scripts go in the session scratchpad, not the repo
7. **Verification:** `pnpm typecheck`, `pnpm test`, and headless NullEngine + Havok checks where relevant. If errors appear only in other agents' in-progress files, the agent mentions them and moves on.
8. **Final report:** files, design decisions, numbers, what the lead should check in the browser, needs outside owned files, risks.

Run agents in the background, several in one message when independent.

## 3. While they run
- **Cross-file requests:** agents message the lead with requests for files they don't own. Relay them to the owner with SendMessage, then confirm back to the requester.
- **Integration findings:** when an agent finishes with notes for a still-running agent (type errors, API changes), relay them immediately.
- **Stalls:** a stalled agent (watchdog) means checking for hung processes, then resuming once. If it stalls again, spawn a fresh, narrow agent. Stop redundant agents with TaskStop.
- **User feedback** during a phase goes to the owning agent (resume it) or a new focused agent.

## 4. Integration and closeout
- **Final wiring:** usually `Game.ts` hooks. Assign it to the agent that owns Game.ts in that phase, or a short integration agent.
- **Verification:** the `browser-verify` skill.
- **Finish:** the `phase-complete` skill (commit, memory, devlog).
