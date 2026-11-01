# Repository-local agent skills

Skills here are loaded on demand by Copilot/agent tooling. Two of them are verbatim
imports from upstream collections and three are selective imports from Addy Osmani's
`agent-skills`; provenance and any local modifications are recorded below. Do not edit
upstream skill bodies silently — mark changes as "Repo adaptation" the way the existing
notes do.

| Skill | Source | Commit | License | Local modifications |
|---|---|---|---|---|
| [`react-container-presentation-component`](./react-container-presentation-component/SKILL.md) | [github/awesome-copilot](https://github.com/github/awesome-copilot) `skills/react-container-presentation-component/` | `5269f7ea2d6c3a9bfda5ed878b6726cf509121fd` | MIT (GitHub, Inc.) | Note added at top: Storybook/SCSS conventions are optional, not imposed |
| [`javascript-typescript-jest`](./javascript-typescript-jest/SKILL.md) | [github/awesome-copilot](https://github.com/github/awesome-copilot) `skills/javascript-typescript-jest/` | `5269f7ea2d6c3a9bfda5ed878b6726cf509121fd` | MIT (GitHub, Inc.) | Note added at top: **Vitest is the active runner**; Jest patterns kept as guidance with `jest.*` → `vi.*` mapping |
| [`frontend-ui-engineering`](./frontend-ui-engineering/SKILL.md) | [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) `skills/frontend-ui-engineering/` | `eb07f19f52c2669f2364897aaa293e2aaddd7b1c` | MIT (Addy Osmani) | None; its `../../references/accessibility-checklist.md` companion was copied to `.github/references/` so the upstream relative path resolves |
| [`api-and-interface-design`](./api-and-interface-design/SKILL.md) | [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) `skills/api-and-interface-design/` | `eb07f19f52c2669f2364897aaa293e2aaddd7b1c` | MIT (Addy Osmani) | None |
| [`spec-driven-development`](./spec-driven-development/SKILL.md) | [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) `skills/spec-driven-development/` | `eb07f19f52c2669f2364897aaa293e2aaddd7b1c` | MIT (Addy Osmani) | None |

Import notes:

- Imported 2026-10-31 by direct download of pinned GitHub archive tarballs
  (`https://github.com/<owner>/<repo>/archive/<sha>.tar.gz`). Verify any update against a
  pinned SHA before replacing files.
- From `addyosmani/agent-skills` only the **frontend / API / spec-driven** picks were taken
  (per project decision) — not the whole collection, and **without** the Claude/agent-plugin
  wrapper (`plugin.json`, `agents/`, `commands/`, `hooks/`, `scripts/`, `evals/`).
- Both upstreams are MIT licensed; copyright stays with GitHub, Inc. and Addy Osmani
  respectively. Full upstream license texts: awesome-copilot `LICENSE`, agent-skills `LICENSE`.
- Known stack conflicts and their resolutions: Vitest (not Jest) is the active test
  runner; Storybook/SCSS (not present here) are optional.
