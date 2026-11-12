# Domain docs

## Layout and reading rules

This repo uses a single-context layout:

- `GLOSSARY.md` at the root defines domain vocabulary.
- `docs/adr/` holds architecture decision records.

Before exploring the codebase, read the glossary and ADRs relevant
to the work. If either is absent, proceed silently; domain-modeling
creates documentation when terms or decisions are resolved.

## Vocabulary

Use glossary terms in issue titles, proposals, hypotheses, tests,
and other output. Respect explicitly avoided synonyms.

When a needed concept has no entry, reconsider whether it belongs
to the project's language or note the gap for domain-modeling.

## Decisions

Surface conflicts with existing ADRs explicitly. Identify the ADR
and explain why its decision should be reopened.
