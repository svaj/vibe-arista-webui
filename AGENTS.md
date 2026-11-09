# Vibe-Arista-Webui

## About
A Typescript EOS eAPI client and a React frontend (using that eAPI client) to manage an arista switch.  In particular the DCS-7050TX-64, running EOS 4.28.  The unit self-reports `modelName: DCS-7050TX-64-R` (airflow variant — verified in the 2026-11-08 supervised session), so the live-lane hardware pin set carries both exact spellings; see `arista-api-client/src/testing/live-guard.ts` and DECISIONS DR-131.

## Tech stack
* Monorepo: plain npm workspaces
* Language: Typescript 7
* Frontend: React 19 with the React Compiler
* * Vite 8, using Rolldown and oxc tools for formatting/linting, etc.
* Test Frameworks: Vitest and Playwright

## Arista offical material related to this project

* Arista's Python EOS eAPI api client has been cloned to `/home/svaj/development/arista/pyeapi`
* Arista's OSS source release for 4.28 can be seen at `/home/svaj/development/arista/arista_oss`
* Arista release notes for EOS 4.28 are in `/home/svaj/development/arista/RN4.28.14Mv1.0.pdf`
* Arista's cEOS-lab **4.28.14M** image and vendor install instructions are in `/home/svaj/development/arista/cEOS`. Prefer disposable cEOS for opt-in real-eAPI integration/live and browser E2E tests; see [the cEOS runbook](docs/CEOS.md). Ordinary `npm test` stays offline. Container results do not establish hardware support or exact behavior on the 7050TX-64 / 4.28.13.1M.
* Arista's EOS binary (swi) for 4.28 can be viewed at `/home/svaj/development/arista/EOS-4.28.13.1M.swi`.  If needed we can attempt to reverse engineer that to see if anything useful shows up, just let the user know and we can get that analyzed.

Rules/Instructions
All agent rules and instructions in .github/instructions