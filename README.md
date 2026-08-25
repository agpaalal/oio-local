# OIO Local

OIO Local helps a nondeveloper turn an ordinary-language request into a small,
working, locally proved result with Codex or Claude Code. It keeps the approved
outcome ahead of implementation preferences and supports English and Spanish.

OIO Local is separate from OIO Business. It does not include multitenancy,
hosted operations, organizational administration, or the OIO Business cloud
runtime.

## What V0 provides

- guided outcome discovery and exact Human approval;
- Will / Will Not and specification review artifacts;
- internal tickets and step definitions;
- local execution through Codex or Claude Code;
- SQLite-backed request records;
- Doppler-backed secret access without project environment files;
- backup, restore, health, and safe uninstall paths;
- English and Spanish user journeys;
- pinned, attributed copies of selected Matt Pocock skills.

## Requirements

- macOS;
- Node.js 22.5 or newer;
- Codex CLI 0.149.1 or newer, or Claude Code;
- Doppler CLI for requests that require secrets;
- Git for installation from this repository.

## Controlled installation

Until the public bootstrap installer is released, clone this repository and
capture the existing host state before registering the plugin. This capture is
required for verified uninstall and restoration.

### Codex

```bash
git clone https://github.com/agpaalal/oio-local.git
cd oio-local
node plugins/oio-local/scripts/capture-preinstall.mjs \
  --harness codex \
  --output "$PWD/oio-local-preinstall-codex.json"
codex plugin marketplace add "$PWD"
codex plugin add oio-local@oio-local
node plugins/oio-local/scripts/codex/setup.mjs \
  --project /absolute/path/to/project \
  --language en \
  --preinstall-state "$PWD/oio-local-preinstall-codex.json"
node plugins/oio-local/scripts/health.mjs \
  --project /absolute/path/to/project
```

Start it in Codex with `$oio-local:oio-local`.

### Claude Code

Replace `codex` with `claude` in the capture command, then register and install
the same checkout:

```bash
claude plugin marketplace add "$PWD" --scope user
claude plugin install oio-local@oio-local --scope user
node plugins/oio-local/scripts/claude/setup.mjs \
  --project /absolute/path/to/project \
  --language en \
  --preinstall-state "$PWD/oio-local-preinstall-claude.json"
node plugins/oio-local/scripts/health.mjs \
  --project /absolute/path/to/project
```

Start it in Claude Code with `/oio-local:oio-local`.

Use `--language es` for Spanish. Keep the pre-install snapshot until OIO Local
has been uninstalled successfully.

## Development

```bash
npm ci
npm test
```

The full native release qualification invokes both supported harnesses in both
languages and can use model credits:

```bash
npm run qualify
```

## Attribution

Selected skills are derived from Matt Pocock's
[`mattpocock/skills`](https://github.com/mattpocock/skills) under the MIT
License. Exact source identities, content hashes, modifications, and license
text are preserved in
[`plugins/oio-local/compatibility/skills.json`](plugins/oio-local/compatibility/skills.json)
and [`plugins/oio-local/THIRD_PARTY_NOTICES`](plugins/oio-local/THIRD_PARTY_NOTICES).

See [PROVENANCE.md](PROVENANCE.md) for the extraction boundary from the private
OIO Business repository.

## License

OIO Local is released under the [MIT License](LICENSE). Bundled third-party
materials retain their documented upstream licenses and notices.

## Español

La documentación inicial en español está en [README.es.md](README.es.md).
