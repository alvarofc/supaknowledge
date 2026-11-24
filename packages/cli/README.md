# @supaknowledge/cli

The command line for [Supaknowledge](https://github.com/alvarofc/supaknowledge), an open-source knowledge factory built on Supabase. Sign in, import
and export [OKF](https://github.com/alvarofc/supaknowledge/blob/main/docs/okf.md) bundles and [Agent Skills](https://agentskills.io), pull skills to
where coding agents look for them, review what the curator proposes, and manage agents, sources and members.

Installs two names for the same binary: `supaknowledge` and the short alias `kf`.

> Status: alpha (0.x). Commands and flags may change between minor versions.

```bash
npm install -g @supaknowledge/cli   # Node 22.12+
kf --help
```

```bash
kf login --url https://<project>.supabase.co --publishable-key sb_publishable_... --email you@acme.com
kf init --workspace acme --space finance       # writes .supaknowledge.json
kf import ./knowledge --apply                  # OKF concepts and/or skills/<name>/SKILL.md folders
kf pull                                        # .claude/skills/<name>/ + .supaknowledge/knowledge/
kf proposals                                   # review what the curator proposes
kf mcp-config --client claude-code             # connect an agent over MCP
kf members invite ana@acme.com --role member   # they run `kf invitations accept <id>` (or accept in Studio)
```

Configuration lives in `~/.config/supaknowledge/config.json` (profiles) and `.supaknowledge.json` (the default space
for a directory). Environment overrides: `SUPAKNOWLEDGE_URL`, `SUPAKNOWLEDGE_PUBLISHABLE_KEY`,
`SUPAKNOWLEDGE_TOKEN` (an access token or agent key `skn_...`, handy in CI), `SUPAKNOWLEDGE_SPACE`,
`SUPAKNOWLEDGE_PROFILE`, `SUPAKNOWLEDGE_CONFIG_DIR`. Every command takes `--json`.

Full reference: [docs/cli.md](https://github.com/alvarofc/supaknowledge/blob/main/docs/cli.md).

## License

[Apache-2.0](LICENSE). Supaknowledge is a community project and is not affiliated with or endorsed by Supabase, Inc.
