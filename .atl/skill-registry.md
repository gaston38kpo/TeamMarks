# Skill Registry

**Delegator use only.** Any agent that launches sub-agents reads this registry to resolve compact rules, then injects them directly into sub-agent prompts. Sub-agents do NOT read this registry or individual SKILL.md files.

See `_shared/skill-resolver.md` for the full resolution protocol.

## User Skills

| Trigger | Skill | Path |
|---------|-------|------|
| creating, opening, or preparing PRs for review | branch-pr | C:\Users\giaco\.config\opencode\skills\branch-pr\SKILL.md |
| PRs over 400 lines, stacked PRs, or review slices | chained-pr | C:\Users\giaco\.config\opencode\skills\chained-pr\SKILL.md |
| writing guides, READMEs, RFCs, onboarding, architecture, or review-facing docs | cognitive-doc-design | C:\Users\giaco\.config\opencode\skills\cognitive-doc-design\SKILL.md |
| PR feedback, issue replies, reviews, Slack messages, or GitHub comments | comment-writer | C:\Users\giaco\.config\opencode\skills\comment-writer\SKILL.md |
| "how do I do X", "find a skill for X", "is there a skill that can..." | find-skills | C:\Users\giaco\.agents\skills\find-skills\SKILL.md |
| Go test coverage, teatest, or test patterns | go-testing | C:\Users\giaco\.config\opencode\skills\go-testing\SKILL.md |
| creating GitHub issues, bug reports, or feature requests | issue-creation | C:\Users\giaco\.config\opencode\skills\issue-creation\SKILL.md |
| judgment day, dual review, adversarial review, or juzgar requests | judgment-day | C:\Users\giaco\.config\opencode\skills\judgment-day\SKILL.md |
| new skills, agent instructions, or documenting AI usage patterns | skill-creator | C:\Users\giaco\.config\opencode\skills\skill-creator\SKILL.md |
| implementation, commit splitting, chained PRs, or keeping tests and docs with code | work-unit-commits | C:\Users\giaco\.config\opencode\skills\work-unit-commits\SKILL.md |

## Compact Rules

Pre-digested rules per skill. Delegators copy matching blocks into sub-agent prompts as `## Project Standards (auto-resolved)`.

### branch-pr
- Every PR MUST link an approved issue with status:approved label
- Every PR MUST have exactly one type:* label
- Branch names MUST match: (feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)/[a-z0-9._-]+
- Commit messages MUST match: type(scope)!: description (conventional commits)
- Type-to-label mapping: feat→type:feature, fix→type:bug, docs→type:docs, refactor→type:refactor, chore→type:chore, feat!→type:breaking-change

### chained-pr
- MUST split when PR exceeds 400 changed lines unless maintainer approves size:exception
- Each chained PR must be autonomous: CI green, clear rollback, one deliverable scope
- Always include dependency diagram marking current PR with 📍
- Choose strategy with user: Stacked PRs to main (fast) or Feature Branch Chain (rollback control)
- For Feature Branch Chain: child PRs target immediate parent branch, not main or tracker

### cognitive-doc-design
- Lead with the answer; context comes after
- Progressive disclosure: happy path first, details and edge cases later
- Prefer tables, checklists, examples over prose
- Each section focuses on one decision or work unit
- PR docs: state what to review first, what's out of scope, link prev/next PRs

### comment-writer
- Be useful fast: start with the actionable point
- Warm and direct tone, like a thoughtful teammate
- Keep it short: 1-3 paragraphs or tight bullet list
- Explain why when requesting a change
- Match thread language; in Spanish use Rioplatense voseo (podés, tenés, fijate)
- No em dashes; use commas, periods, parentheses

### find-skills
- Use when user asks "how do I do X" or "find a skill for X"
- `npx skills find [query]` to search for skills
- `npx skills add <package>` to install a skill
- `npx skills check` / `npx skills update` to check/update installed skills

### go-testing
- Table-driven tests for multiple test cases
- teatest for Bubbletea TUI testing
- Golden file testing for visual output rendering
- Test files alongside source: *_test.go next to source files
- Use t.TempDir() for file operations, interfaces + mocks for side effects

### issue-creation
- Every issue gets status:needs-review automatically on creation
- Maintainer MUST add status:approved before any PR can be opened
- Use Bug Report or Feature Request template — blank issues are disabled
- Conventional commit-style issue titles: fix(scope): description or feat(scope): description

### judgment-day
- Launch TWO parallel blind sub-agents for adversarial review
- Synthesize: confirmed (both judges) → fix immediately; suspect (one judge) → triage; contradiction → flag
- Classify WARNINGs: real (normal user can trigger → fix) vs theoretical (contrived scenario → report as INFO, don't fix)
- Fix confirmed issues, then re-judge. After 2 iterations, ASK user if they want to continue
- NEVER declare APPROVED until round 1 clean or round 2 has 0 criticals + 0 real warnings

### skill-creator
- SKILL.md must have frontmatter: name, description (quoted, one-line, YAML-safe, includes Trigger:), license, metadata
- Description ≤160 chars preferred, MUST include trigger keywords, no Keywords section
- Code templates go in assets/, local doc references in references/
- Register skill in AGENTS.md after creating

### work-unit-commits
- Commit by work unit (deliverable behavior), not by file type
- Keep tests with the behavior they verify in the same commit
- Keep docs with the user-visible change they explain
- Each commit should tell a story and be a PR candidate
- If SDD tasks forecast >400-line change, plan chained PRs before implementation

## Project Conventions

No project convention files found (no AGENTS.md, CLAUDE.md, .cursorrules, GEMINI.md, or copilot-instructions.md).

## Project Context (TeamMarks)

- **Stack**: Chrome Extension MV3, Vanilla JS, Supabase (Realtime + REST), Google OAuth2
- **No build tool** — plain JS, no bundler, no TypeScript
- **No test framework** — strict TDD mode: disabled
- **Key files**: service-worker.js, sync-engine.js, conflict-resolution.js, team-management.js, auth.js
- **Schema**: supabase-schema.sql, supabase/functions/
- **SDD Persistence**: engram (topic: sdd-init/teammarks, obs #57)
- **Testing capabilities**: engram (topic: sdd/teammarks/testing-capabilities, obs #58)