---
name: oio-local
description: Guide a nondeveloper through an outcome-first local implementation in Codex or Claude Code. Use when the Human asks OIO Local to set up a project or produce a substantial file-, tool-, or implementation-based result.
---

# OIO Local controller

Keep one main chat as the Human-facing orchestrator. Use plain English or Spanish according to the project setting. Be friendly, assertive, and honest about holds. Never expose raw child-agent chatter.

## Setup

Before the host adds or updates OIO Local, capture its exact current plugin and
marketplace registrations. This is the uninstall recovery boundary:

```text
node <plugin-root>/scripts/capture-preinstall.mjs --harness <codex-or-claude> --output <absolute-snapshot-path>
```

Stop before installation if capture fails or reports ambiguous host state. After
the Human uses the selected host's plugin manager to add OIO Local, resolve this
installed plugin's root directory and run:

```text
node <plugin-root>/scripts/<host>/setup.mjs --project <absolute-project-path> --language <en-or-es> --preinstall-state <absolute-snapshot-path>
```

Do not recapture after the host mutation. A low-level setup without a verified
snapshot can initialize a project, but safe uninstall will hold rather than
claim that the prior host state is known. Present returned JSON in plain
language. If `status` is `held`, present its one recovery action and stop only
the dependent transition. Never create `.env`, `.dev.vars`, `.oio.local.env`,
or another local secret file.

After setup, run the same plugin's `scripts/health.mjs` with the absolute project path. Do not claim readiness unless its readback returns `status: ready`.

## Lifecycle methods

Invoke an admitted downstream method only with the exact controller contract:

`Call the Skill tool with "skill-name".`

Use the installed qualified name for `skill-name`. In Codex, for example, use
`Call the Skill tool with "oio-local:grilling".` Do not rely on an unqualified
name that could resolve to a different installed skill.

Claude Code uses the same qualified skill names through the OIO Local plugin.
Its ordinary main-chat profile is Claude Opus and its ordinary bounded child
profile is Claude Sonnet. Codex uses Sol High for the main chat and Luna Max for
the ordinary child profile. A host-specific adapter may select and dispatch a
model; it must not duplicate or alter the shared lifecycle contract.

The admitted lifecycle order is:

1. choose `oio-local:grilling`, `oio-local:wayfinder`, or `oio-local:grill-with-docs` for Intake;
2. use `oio-local:oio-review-artifact` for Will / Will Not and the Outcome Definition;
3. use `oio-local:to-spec`, then `oio-local:oio-review-artifact`, after exact Outcome approval;
4. use `oio-local:to-tickets` after exact specification approval;
5. use `oio-local:tdd` and `oio-local:implement` for approved internal execution;
6. use `oio-local:code-review` after implementation;
7. use `oio-local:handoff` only when the main chat needs a fresh smart zone.

## Substantial request journey

Every substantial new request starts from ordinary Human language. Do not make
the Junior translate the request into code, configuration, database records, or
internal tickets.

1. Discover what the Human means. Call the Skill tool with one of
   `"oio-local:grilling"`, `"oio-local:wayfinder"`, or
   `"oio-local:grill-with-docs"`. Stop repeated questions at agreement
   saturation.
2. Call the Skill tool with `"oio-local:oio-review-artifact"`. Show the complete
   Will / Will Not and Outcome Definition. For the admitted support-request V0
   proof, run `scripts/<host>/journey.mjs start` with the absolute project and request
   file, then open the returned review path.
3. Never infer approval from conversation momentum. After the Human approves
   the exact artifact, run `scripts/<host>/journey.mjs approve-outcome` with its exact
   request id, fingerprint, and Human identity.
4. Call the Skill tool with `"oio-local:to-spec"`, then call the Skill tool with
   `"oio-local:oio-review-artifact"`. Run `scripts/<host>/journey.mjs prepare-spec` and
   show the returned specification review. Its definition fingerprint must be
   the approved Outcome artifact identity.
5. After exact specification approval, run
   `scripts/<host>/journey.mjs approve-spec`. Use the preferred ordinary child profile
   for the request's owning harness: Luna Max in Codex or Claude Sonnet in
   Claude Code. If it is unavailable, disclose an admitted fallback and obtain
   the Human's explicit override before passing `--child-model <profile>`,
   together with
   `--child-model-override-approved-by <Human>` and
   `--child-model-override-reason <disclosed reason>`. Call the Skill tool with
   `"oio-local:to-tickets"` for internal assurance. Do not ask the Junior to
   review internal tickets.
6. Only a Step that interprets or judges input receives a child agent.
   Deterministic validation, file writing, hashing, and readback remain inside
   their owning Step. Keep the child result internal and reconcile it before
   running `scripts/<host>/journey.mjs execute`.
7. Show the real deliverable, intended-path proof, protected-boundary result,
   readback, limitations, and any unexecuted later-version proposal. A proposal
   is not authority to execute it.
8. When the Human accepts the exact result, run `scripts/<host>/journey.mjs accept`
   with its SHA-256 identity. Do not close a different result.

## Harness ownership and transfer

Each request has exactly one harness owner. Normal request operations must come
from the currently installed harness and must match that owner. Do not work
around a mismatch by copying records or starting a duplicate request.

A transfer is allowed only when the request is closed or has a real unresolved
workflow hold. Activate the destination harness, read back the exact request
state and current authority fingerprint, obtain Alejandro's explicit handoff,
then run:

```text
node <plugin-root>/scripts/<owning-host>/journey.mjs hold-harness-transfer --project <absolute-project-path> --request-id <request-id> --to-harness <destination-host> --expected-state <exact-state> --authority-fingerprint <current-fingerprint> --human <Human> --handoff-receipt <receipt-id>

node <plugin-root>/scripts/<destination-host>/journey.mjs transfer-harness --project <absolute-project-path> --request-id <request-id> --from-harness <owning-host> --expected-state <exact-state> --authority-fingerprint <current-fingerprint> --human <Human> --handoff-receipt <receipt-id>
```

The owning adapter first records an exact durable transfer hold. After the
destination adapter is activated, the second command consumes that hold,
records the transfer receipt, and changes the request owner in one transaction.
Ordinary command errors and harness mismatches do not authorize transfer.

For local Claude host verification, run
`node <plugin-root>/scripts/verify-claude-host.mjs`. It uses a disposable Claude
configuration, validates and installs the local plugin, reads back its skills
and Step Agent, verifies model and permission surfaces, exercises ready and
missing-Doppler setup, and removes the disposable configuration. This proves a
local host seam; it does not publish the plugin or install it into the Human's
active harness.

## Corrections, changes, and later versions

- A hold is a durable event on the affected request, not a terminal request
  state. Keep the request at the last approved boundary, show the recovery
  action, and retry only the corrected transition. Resolve its open hold when
  the corrected Workflow 0 reaches proof review.
- While the request remains in Outcome review, use `scripts/<host>/journey.mjs
  revise-outcome` with the changed request file. The new artifact supersedes
  the prior revision, and no approval of the prior revision authorizes the new
  one.
- Before execution begins, use `scripts/<host>/journey.mjs revise-spec` when the
  specification changes. The revised artifact supersedes the prior revision,
  invalidates its prepared execution packet, and returns to exact specification
  approval.
- Pass `--version V0` for current execution. Any `V1` or later execution holds
  until the Human separately authorizes that version.
- A missing approved V0 criterion is a correction. After closure, use
  `scripts/<host>/journey.mjs reopen` with the exact approved Outcome fingerprint and
  the correction reason. Preserve the earlier result in history.
- A materially changed Outcome cannot reuse the old request's approval. Use
  `scripts/<host>/journey.mjs start-successor` with the predecessor request id and
  return the new request to Intake. Predecessor validation, request creation,
  and the successor link are one state transaction.

The current Human-visible outcome, exact approvals, and result remain owned by the main chat. A downstream skill cannot expand authority or begin a later version.

## Backup and restore

Back up only a closed request. Run `scripts/backup.mjs` with the project and
request id. Report `verified` only after the copied SQLite snapshot and every
readable request file match the manifest on readback. Keep active state outside
the synchronized backup folder.

Restore with `scripts/restore.mjs` into a new isolated destination. Never
replace active state automatically. A missing, corrupt, mismatched, or unsafe
manifest holds the restore and preserves the active workspace.

## Uninstall guidance / Guía de desinstalación

Uninstall must restore the harness configuration that existed before OIO Local
was installed and preserve approved history / conservar el historial aprobado.
Never remove project records, review artifacts, SQLite evidence, backups, or
Doppler configuration as an implied part of uninstall. First run `node
<plugin-root>/scripts/uninstall.mjs preview --project <absolute-project>` and
show the complete remove, restore, preserve, and unresolved lists. Execute only
after the Human confirms the exact returned fingerprint, using `node
<plugin-root>/scripts/uninstall.mjs execute --project <absolute-project>
--fingerprint <fingerprint> --human <name>`. Cancel is read-only. Never delete
project records, deliverables, backups, SQLite evidence, or Doppler resources.

La desinstalación debe restaurar la configuración del entorno que existía antes
de instalar OIO Local y conservar el historial aprobado. Nunca elimines
registros del proyecto, artefactos de revisión,
evidencia SQLite, copias de seguridad ni la configuración de Doppler como parte
implícita de la desinstalación. Primero ejecuta `node
<plugin-root>/scripts/uninstall.mjs preview --project <proyecto-absoluto>` y
muestra las listas completas de quitar, restaurar, preservar y asuntos sin
resolver. Ejecuta solo después de que la persona confirme la huella exacta
devuelta, con `node <plugin-root>/scripts/uninstall.mjs execute --project
<proyecto-absoluto> --fingerprint <huella> --human <nombre>`. Cancelar no
modifica nada. Nunca elimines registros del proyecto, entregables, respaldos,
evidencia SQLite ni recursos de Doppler.
