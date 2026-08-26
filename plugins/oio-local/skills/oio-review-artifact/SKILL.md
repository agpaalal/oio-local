---
name: oio-review-artifact
description: Generate or revise interactive OIO HTML review artifacts and linked review packages for Outcome Definitions, Will / Will Not records, specifications, architecture records, audits, learning records, and other component-level Human approvals. Use when OIO material needs Agree / Revise / Question controls, pending-only filtering, comments, copyable review receipts, print-to-PDF, fingerprints, manifests, or a Sites-ready review surface. Do not use for unrelated websites or generic documents.
---

# OIO Review Artifact

Create one readable Human review surface without changing the authority or meaning of its sources. The artifact presents decisions; it never grants approval by itself.

## Build the artifact

1. Resolve the exact source revision, authority boundary, approval effect, and status of every component. Preserve accepted wording and mark unresolved material `pending`; never infer agreement. Present scope and authority once where the Human must decide them—in the relevant body or decision—not as repeated page-header boilerplate.
2. For a new package or structural change, read [references/package-schema.md](references/package-schema.md). Prepare one JSON manifest plus one HTML body fragment per document. Always name the project explicitly. Use its established palette when one exists; otherwise let the generator derive a stable palette from the project name.
3. Run:

   ```bash
   python scripts/build_review_artifact.py MANIFEST.json OUTPUT_DIRECTORY
   ```

   Use a new versioned output directory. To rebuild an output previously created by this skill, add `--replace-generated`; the script refuses to replace an unmarked directory.
4. Inspect the package index, the generated consolidated decision component, and at least one settled and one pending component page. Verify navigation, next-component links, shared decision state, reviewed and pending marks, pending-only filtering, comments, the complete copied receipt, print layout, downloads, figures, and responsive reading order.
5. Treat source revisions, hashes, fingerprints, superseded-source notes, integrity manifests, and similar trace data as supporting evidence—not review content. Never highlight them in component bodies, cards, status callouts, or ordinary package files. Put them only in the subdued, collapsed integrity detail at the bottom of the package index. `DEFINITION-FINGERPRINT.txt`, `ARTIFACT-FINGERPRINT.txt`, and `MANIFEST-SHA256.txt` remain distinct evidence files.
6. When Word records are also required, use `oio-docx-style` for those files and link the exact Word/PDF projections through `copy_files`. HTML is the review surface; Word/PDF remain separate artifacts.
7. Publish only when explicitly authorized. For Sites publication, use the installed Sites building and hosting skills and deploy the exact validated package privately by default.

## Preserve review semantics

- Give each critical component its own stable decision ID and one initial state: `agreed`, `pending`, `revise`, or `question`.
- Show `Project · <name>` above the document title on the package index and every review page. Keep that identity in copied receipts.
- Give each project a stable palette. Prefer an explicit palette for a known project or brand. Otherwise use the generator's deterministic project-name palette; do not default every package to purple.
- Create a decision only when the Human can answer it independently and the answer changes product behavior, business meaning, an unresolved technical choice, proof, or an external effect. Do not create decisions that merely restate the package approval effect, summarize the complete Will / Will Not, repeat review status, name the next lifecycle gate, or ask the Human to agree with implications of approving the package. Keep that material as concise context outside the decision controls.
- Show the complete component statement and boundary before its controls.
- Always keep the per-component review pages and also generate one consolidated component containing every decision in manifest order. Present it with the same component-card treatment and place it last in the review sequence. A choice or comment made in either view must be the same package-level decision state. The consolidated component must copy one receipt containing every decision ID, choice, and comment.
- Show a `✓ Reviewed` mark on a component page and its index card only when all of that component's decisions are complete. Otherwise show a `● Pending decisions` mark on its index card. Show the package-level Reviewed mark only when every component is complete. Use marks, not numeric progress badges.
- Provide a Next component link on every component page. The last declared component links to the consolidated review.
- Do not generate generic `Role in the system`, `Review boundary`, or `Approval effect` header blocks on the package index or component pages. Put any decision-relevant scope or authority in the specific body section or decision it governs.
- Keep body fragments focused on decisions and readable source text. Put technical source identity and integrity traces in manifest `integrity_details`, and mark technical downloads with `placement: integrity`; do not duplicate them in body callouts. The generator rejects callouts that contain source-hash or fingerprint traces.
- Keep comments and browser choices local until the Human copies or exports the review receipt. Do not treat local UI state as a durable approval record.
- Bind copied receipts to the document ID and both fingerprints.
- A revised source creates a new artifact revision and invalidates approval only where the governing contract says it does. Preserve earlier reviewed revisions as evidence.
- Keep generic boilerplate out. When a section has no specific content, state that no details were provided rather than inventing scope.
- Keep the package usable without a server. Generated HTML, CSS, and JavaScript must work from static hosting and local files.

## Input and safety boundaries

- Body fragments are trusted local authoring inputs, not web content. The generator rejects scripts, inline event handlers, forms, frames, embedded objects, and `javascript:` URLs.
- Copy only declared files. Every destination must remain inside the output directory.
- Do not include credentials, private runtime state, hidden reasoning, dependency folders, caches, or build output.
- Do not overwrite a reviewed package silently. Use a new revision or the guarded `--replace-generated` path only for an explicitly superseded generated output.

## Completion

The work is complete when the generated package validates, every declared document and copied file resolves, the consolidated component contains every decision exactly once, decision state is shared with the component pages, fingerprints and SHA-256 manifest exist, and the Human can navigate, review, comment, filter, copy both component and complete receipts, and print without a broken path.
