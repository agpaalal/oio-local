# OIO review package manifest

Use UTF-8 JSON. Paths are relative to the manifest unless absolute. Output targets are always relative and may not escape the generated package.

## Minimum shape

```json
{
  "package": {
    "project_name": "OIO",
    "project_palette": "blue",
    "title": "Support Assistant Outcome Definition",
    "revision": "0.1",
    "date": "2026-08-24",
    "kicker": "OIO OUTCOME ENGINEERING · OUTCOME REVIEW",
    "subtitle": "Exact Human review before Orchestrator qualification",
    "status": "Provisional",
    "definition_fingerprint": "optional-existing-semantic-fingerprint"
  },
  "integrity_details": [
    {
      "label": "Exact source",
      "value": "Revision 0.1 and its source SHA-256; the prior draft is superseded."
    }
  ],
  "documents": [
    {
      "id": "D00",
      "number": "00",
      "title": "Outcome Definition",
      "summary": "Outcome, proof, limits, authority, and Workflow 0.",
      "review_question": "Is this the exact outcome to pursue?",
      "kicker": "OIO OUTCOME ENGINEERING · OUTCOME REVIEW",
      "subtitle": "Human-readable synthesis",
      "body_file": "bodies/outcome.html",
      "word_target": "files/outcome.docx",
      "pdf_target": "files/outcome.pdf",
      "decisions": [
        {
          "id": "OUT-01",
          "status": "agreed",
          "title": "Desired outcome",
          "statement": "Produce one useful support response from a real incoming request.",
          "boundary": "This does not authorize recurring operation.",
          "basis": "Confirmed by Alejandro."
        },
        {
          "id": "OUT-02",
          "status": "pending",
          "title": "Proof",
          "statement": "Alejandro accepts the response as useful and grounded.",
          "boundary": "Implementation evidence alone is insufficient."
        }
      ]
    }
  ],
  "copy_files": [
    {"source": "source/outcome.docx", "target": "files/outcome.docx"},
    {"source": "source/outcome.pdf", "target": "files/outcome.pdf"}
  ],
  "downloads": [
    {"label": "Combined PDF", "target": "files/outcome.pdf", "description": "Printable review record"},
    {"label": "Integrity manifest", "target": "MANIFEST-SHA256.txt", "description": "Generated-file hashes", "placement": "integrity"}
  ]
}
```

## Package fields

Required: `project_name`, `title`, `revision`, `date`, `kicker`, `subtitle`, and `status`.

`project_palette` is optional. Supported values are `blue`, `teal`, `green`, `amber`, `coral`, `violet`, and `slate`. Use an explicit value when a project has an established visual identity. When omitted, the generator derives a stable palette from the normalized `project_name`, so later revisions of one project remain visually recognizable without making every project purple.

The generator shows `Project · <project_name>` above the package title and every component title and includes it in copied receipts. Do not hide the project identity inside a title or kicker.

Do not add package-level `review_boundary` or `approval_effect` boilerplate. Put a boundary or approval consequence in the specific body section or decision it governs so it appears once, in context.

`definition_fingerprint` is optional. Supply it only when another approved artifact already defines that semantic identity. The generator always computes a separate artifact fingerprint.

`integrity_details` is optional. Each item requires `label` and `value`. Use it for source revision identities, hashes, superseded-source notes, or other technical trace data that must be preserved without entering the Human decision flow.

## Document fields

Required: `id`, `number`, `title`, `summary`, `review_question`, `kicker`, `subtitle`, `body_file`, and `decisions`.

Do not add a generic document `role` field. The title, summary, review question, body, and decisions must communicate the component's purpose without a repeated `Role in the system` block.

Optional: `word_target` and `pdf_target`. Each target must also be generated or declared in `copy_files`.

Every decision requires `id`, `status`, `title`, `statement`, and `boundary`. `basis` is optional. Status is one of:

- `agreed`: starts selected as Agree.
- `pending`: starts unselected.
- `revise`: starts selected as Revise.
- `question`: starts selected as Question.

Decision IDs must be unique across the complete package so copied receipts remain unambiguous.

A decision must be independently answerable and materially affect product behavior, business meaning, an unresolved technical choice, proof, or an external effect. Approval effect, a complete Will / Will Not summary, current review status, and the next lifecycle gate are normally implied procedural context. Put them in concise body text when needed; do not turn them into Agree / Revise / Question controls.

## Generated consolidated component

The generator automatically adds `reviews/all-decisions.html`. Do not declare this page as another document in the manifest.

The consolidated component repeats every declared decision in document and decision order, labels its source component, shares the same browser state by artifact fingerprint and decision ID, and copies one package-wide approval receipt. On the package index it uses the same card treatment as each declared component and appears last in the review sequence. The original component pages and their scoped receipts remain available.

Each component page links to the next component; the last declared component links to the consolidated review. The package index and component pages derive review marks from the same browser-local decision state. A complete component shows `✓ Reviewed`; an incomplete card shows `● Pending decisions`. The package index shows its Reviewed mark only when every component is complete. These states use marks without numeric badges.

## Body fragments

Use semantic HTML fragments, not complete pages. Recommended elements are `h2`, `h3`, `p`, `ul`, `ol`, `table`, `figure`, `img`, `figcaption`, `blockquote`, and `code`.

Use relative image paths that resolve from `reviews/`, normally `../assets/figure.png`, and declare the source image in `copy_files` with target `assets/figure.png`.

The generator rejects active or embedded content. Do not place scripts, event handlers, forms, frames, objects, or `javascript:` URLs in body fragments.

## Copy files and downloads

`copy_files` copies exact source bytes into the package. A target cannot be absolute, contain `..`, or collide with a generated core file.

`downloads` adds links to targets already produced by the generator or `copy_files`. `placement` is optional and defaults to `package`. Use `placement: integrity` for manifests, trace records, or other technical files; those links appear only inside the collapsed package-integrity detail.

## Fingerprints

- Definition fingerprint: supplied semantic identity from the governing review process.
- Artifact fingerprint: SHA-256 of normalized package metadata, document content, decisions, and copied-file identities.
- Manifest SHA-256: byte identity of every generated and copied output, excluding the manifest itself.

Source identities, hashes, fingerprints, superseded-source notes, and integrity files are supporting evidence, not review content. The generated index places them only in a collapsed, low-prominence detail after the components and ordinary package files.

Changing content or copied bytes changes the artifact fingerprint and manifest. A presentation-only regeneration can preserve the definition fingerprint while producing a new artifact fingerprint.
