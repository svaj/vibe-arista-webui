# Vibe-Arista-Webui

## About
An attempt to vide code a React frontend to manage an arista switch.  This started as I bought a cheap 7050X-64 48 10Gbase-t port + 4 port 40Gb QSFP+ switch and I needed to configure it.  I didn't want to learn EOS honestly.  There are anisble playbooks out there and there's cloudvision out there.I don't *really* know anisble that well and you have to deploy cloudvision for a single node, when its meant for managing a lot - like a datacenter's amount.  I just want a simple UI to configure this switch that's reached its end of support over a year ago.

## Stack
This project is going to be comprised of a typescript [api client](./arista-api-client) (vibe-coded migrating from the arista python [api client](https://github.com/arista-eosplus/pyeapi) most likely) and a react [frontend](./arista-webui) that uses said client to connect to an Arista switch and configure it.  I am using vite + typescript + oxc (vite 8's rolldown pipeline, oxlint) with react 19, and tests run in vitest (`npm test` inside [arista-webui](./arista-webui)).  Further architectural decisions are yet to be made.

## AI agent setup

The repo ships repo-local Copilot customizations under [.github/](./.github):

- **Custom agents** (`.github/agents/`): an `arista-eos-eapi-expert` (EOS 4.28 / 7050TX-64 feature questions, eAPI integration design, switch-change policy) and a `frontend-react-engineer` for arista-webui work.
- **Skills** (`.github/skills/`): upstream imports (Container/Presentation components, Jest guidance — Vitest is the actual runner, plus frontend/API/spec skills from Addy Osmani's collection). Sources, pinned commits, MIT attribution and local adaptations are recorded in [.github/skills/README.md](./.github/skills/README.md).

## Why Vibe-coded?
Several API clients exist that can serve as a basis for the vibe coded react client to be built.  The most 4.28 docs for EOS are [here](https://www.arista.com/assets/data/docs/Manuals/EOS-4.18.2F-Manual.pdf) .  The features in the last supported version of EOS for the  7050TX is [here](https://www.arista.com/en/support/product-documentation/supported-features) (hint: that's where I got the list of [features](./docs/features.md) I intend to probably support).  Last but not least, Arista provides the [following](https://www.arista.com/en/support/product-documentation/gpl).  Which contains some rpms (e.g. EosKernel-4.19.142.Ar-49998877.42814M.src.rpm) that might come in handy for agents needing more info into EOS.  Also, my unfamiliarity of advanced networking, arista switches, etc puts me at a disadvantage to write something like this.  I'm leaning on AI, so if anything seems wrong, call it out and submit a PR please!

## Why 7050TX and 4.28.13M ?
Because that's the hardware I have and the last supported release for it.

## Can you add support for EOS version XYZ or the 1234-ABC switch?
Gift me a 1234-ABC switch with that version of EOS on it, and maybe I will.