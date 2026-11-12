Use /wayfinder first, then join the main flow at /to-spec.

Why wayfinder rather than /grill-with-docs: Job Butler is greenfield, won't fit in one session, and has many open decisions that depend on each other. Wayfinder is built for that case. It puts a map of decision tickets on your GitHub tracker (already set up) and works through them one at a time. Its output is decisions, not code. /grill-with-docs suits an idea you can settle in one conversation, and this one is bigger than that.

Likely decision tickets for the map:
- Agent boundaries: one agent per job step (discover, filter/score, tailor, outreach, track, interview prep, offer), or fewer agents that each own more subskills.
- Orchestration: an orchestrator skill that dispatches subagents, or skills you call yourself in sequence.
- Shared state: where the pipeline lives so every agent sees the same record (local files, a JSON store, an artifact database).
- Approval gate: how "you approve each send" and the autonomy limits (caps, fit threshold, allow/deny lists) get enforced the same way across agents.
- Source access: how LinkedIn, ATS pages and career pages are actuservice and rate limits. This probably needs /research first.
- Ghost-job and sponsorship signals: what evidence each one rests on.

After the map clears:
1. /to-spec turns the map into a buildable plan.
2. /to-tickets splits it into tracer-bullet tickets.
3. /implement works one ticket per session, or /implement-spec wornce this is a skills repo, most deliverables are SKILL.md files.Load /writing-for-agents while writing them. /tdd fits the deterministic helpers, like fit scoring, ghost-job heuristics and dedup.
4. /retro looks back after each build and improves the setup for t

Detours as needed:
- /research: a background agent reads up on board/ATS access rules or Gmail APIs and leaves a cited file.
- /prototype: answers a question like "does this orchestration actith throwaway code.

Keep the wayfinder session's context focused. When a ticket needs nch to a prototype instead of arguing it out on paper.

Run /wayfinder (or /mattpocock-skills:wayfinder) with your one-linhe map.