# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `kevsmir02/terax-ai`.
Use the `gh` CLI from this clone.

## Conventions

- Create: `gh issue create --title "..." --body-file <file>`.
- Read: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,body,labels`.
  Apply label and state filters as needed.
- Comment: `gh issue comment <number> --body-file <file>`.
- Label: `gh issue edit <number> --add-label "..."` or
  `--remove-label "..."`. Use `docs/agents/triage-labels.md`.
- Close: `gh issue close <number>`.
- Use temporary UTF-8 files for multiline bodies and comments.

## Skill instructions

“Publish to the issue tracker” means create a GitHub issue.
“Fetch the relevant ticket” means read the referenced GitHub issue.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Wayfinding operations

- Map: one issue labelled `wayfinder:map`, containing Notes,
  Decisions-so-far, and Fog.
- Child tickets: link issues to the map as native GitHub sub-issues.
  If unavailable, add children to a task list in the map and put
  `Part of #<map>` at the top of each child.
- Types: `wayfinder:research`, `wayfinder:prototype`,
  `wayfinder:grilling`, or `wayfinder:task`.
- Blocking: use native GitHub issue dependencies. Dependency API
  operations require numeric database IDs, not issue numbers.
  If unavailable, record `Blocked by: #<number>` in the child body.
- Frontier: choose the first open, unassigned child in map order
  whose blockers are all closed.
- Claim: assign the ticket to the driving developer before work.
- Resolve: comment with the answer, close the child, and append
  a short finding and link to the map's Decisions-so-far.
