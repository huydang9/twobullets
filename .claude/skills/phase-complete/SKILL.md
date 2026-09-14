---
name: phase-complete
description: Close out a finished twobullets phase — verify, commit only that phase's files, update memory, update the Vietnamese devlog. Use when all agents of a phase have reported done.
---

# Phase completion checklist

1. **Checks:** `pnpm typecheck` and `pnpm test`. For pipelines, also run their verify scripts (`pnpm assets:verify`, `node tools/audio/verify.ts`, `tools/map/build.ts --check`).
2. **Browser check** with the `browser-verify` skill. At minimum: the default arena and `?map=v1` load with no console errors, and the feature works. Fix blockers through the owning agent before committing.
3. **Commit only this phase's paths:**
   - `git status --short`, then `git add <owned paths>`.
   - Exclude in-progress work of other running agents and `docs/devlog` (unless the user asked).
   - Message: a summary line plus bullets, ending with the co-author trailer from the system reminder.
   - If a committed file depends on uncommitted work, say so and commit the rest as soon as it lands.
4. **Update memory** in `~/.claude/projects/-Users-huydang-Documents-02-Huy-twobullets/memory/`:
   - `project-status-snapshot.md`: the new commit, what's in flight, next steps.
   - `project-twobullets-direction.md`: any new product decision.
5. **Update the devlog.** Spawn a `fork` writing agent to update `docs/devlog/` in Vietnamese:
   - a new chapter plus the `00-tong-quan.md` timeline and outline, and `bai-hoc.md` lessons
   - author voice "mình"
   - no personal data (emails, account names, local paths, personal files)
   - no invented facts, mark untested items, add "📸 Gợi ý ảnh" hints
   - no commit
6. **Report to the user** briefly: what shipped (with the commit hash), what was verified vs. not, what they should try (URLs and console commands), open decisions, and what starts next.
