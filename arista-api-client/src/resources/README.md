# `src/resources/` — one module per pyeapi api module

`base.ts` (the `BaseResource`/`Entity`/`EntityCollection` equivalent, **M7** #9) plus
`system.ts` (**M8** #10), `vlans.ts` + `switchports.ts` (**M9** #11),
`interfaces.ts` (**M10** #12), then the wave-2/3 backlog (#16, #17).

Resources **generate** `CommandSpec[]`; they never send anything (see
`docs/ARCHITECTURE.md` §2). Coverage threshold for this directory: 85 % lines /
80 % branches (`docs/TESTING.md` §2).
