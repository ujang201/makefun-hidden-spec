# mend — one patch tool for every AI edit format

[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ujang201/makefun-hidden-spec/rank.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ujang201/makefun-hidden-spec/reward.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON — and `mend` reads each one as [SPEC.md](SPEC.md) says, finds the lines each edit names at the first of three matching tiers, and writes every change or none.

Run it as:

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is the path of the patch file, relative to the working directory; when it is absent or `-`, the patch is read from standard input. `--check` does everything but write. `--strict` matches lines exactly (tier 0 only). See [SPEC.md](SPEC.md) for the full contract.

Built for the [make.fun](https://make.fun/r/wfjv7kgb) bounty `hidden-spec-cli-01-run-20261122`.
