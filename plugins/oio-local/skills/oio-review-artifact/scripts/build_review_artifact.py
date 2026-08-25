#!/usr/bin/env python3
"""Build a static, fingerprinted OIO interactive review package."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import shutil
import sys
import unicodedata
from pathlib import Path, PurePosixPath
from typing import Any


SKILL_ROOT = Path(__file__).resolve().parent.parent
ASSET_ROOT = SKILL_ROOT / "assets"
MARKER_NAME = ".oio-review-artifact"
MARKER_VALUE = "oio-review-artifact:v1\n"
CONSOLIDATED_ID = "ALL-DECISIONS"
CONSOLIDATED_PATH = "reviews/all-decisions.html"
STATUSES = {"agreed", "pending", "revise", "question"}
REQUIRED_PACKAGE_FIELDS = {
    "project_name",
    "title",
    "revision",
    "date",
    "kicker",
    "subtitle",
    "status",
}
PALETTES = {"blue", "teal", "green", "amber", "coral", "violet", "slate"}
REQUIRED_DOCUMENT_FIELDS = {
    "id",
    "number",
    "title",
    "summary",
    "review_question",
    "kicker",
    "subtitle",
    "body_file",
    "decisions",
}
REQUIRED_DECISION_FIELDS = {"id", "status", "title", "statement", "boundary"}
FORBIDDEN_BODY_PATTERNS = [
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"<!doctype",
        r"<\s*/?\s*html\b",
        r"<\s*/?\s*script\b",
        r"<\s*/?\s*iframe\b",
        r"<\s*/?\s*object\b",
        r"<\s*/?\s*embed\b",
        r"<\s*/?\s*form\b",
        r"\son[a-z]+\s*=",
        r"javascript\s*:",
    )
]
CALLOUT_PATTERN = re.compile(
    r'<(?:div|aside)\b[^>]*class=["\'][^"\']*\bcallout\b[^"\']*["\'][^>]*>.*?</(?:div|aside)>',
    re.IGNORECASE | re.DOTALL,
)
INTEGRITY_TRACE_PATTERN = re.compile(
    r'\b(?:sha-?256|definition fingerprint|artifact fingerprint|source hash|content hash|exact source)\b',
    re.IGNORECASE,
)
REDUNDANT_DECISION_TITLE_PATTERN = re.compile(
    r"\b(?:approval effect|complete will\s*/\s*will not|next lifecycle gate|current review status)\b",
    re.IGNORECASE,
)

UI_COPY = {
    "en": {
        "agree": "Agree", "all_decisions": "All decisions", "artifact_fingerprint": "Artifact fingerprint",
        "basis": "Basis", "boundary": "Boundary", "comment": "Comment or correction",
        "component": "Component", "component_review": "Component review", "consolidated": "Consolidated Decision Review",
        "consolidated_copy": "Copy consolidated receipt", "consolidated_kicker": "OIO OUTCOME ENGINEERING · CONSOLIDATED REVIEW",
        "consolidated_question": "Is the complete decision set ready for one package-wide approval receipt?",
        "consolidated_subtitle": "Every package decision, with the same state as its component page",
        "copy_package": "Copy one package-wide approval receipt.", "copy_review": "Copy review receipt",
        "date": "Date", "decisions": "decisions", "definition_fingerprint": "Definition fingerprint",
        "index_instruction": "Review each component in sequence.", "integrity": "Package integrity details",
        "next": "Next component", "package_files": "Package files", "package_index": "Package index",
        "package_review": "Package review", "pending": "Pending decisions", "pending_only": "Pending only",
        "print": "Print / Save PDF", "project": "Project", "question": "Question", "reviewed": "Reviewed",
        "review_sequence": "Review sequence", "revise": "Revise", "revision": "Revision", "statement": "Statement",
        "status": "Status", "summary": "All {count} decisions in one review and approval receipt.",
        "table_copy": "This component repeats every decision from the package in source order. Review here or on the individual component pages; each decision ID has one shared browser state.",
        "table_decisions": "Decisions", "table_intro": "Complete decision set",
        "table_receipt": "The consolidated receipt includes all {count} decisions and their comments.",
        "table_title": "Title",
        "local_note": "Choices remain in this browser until you copy the review receipt. Revise and Question require a comment before they leave Pending.",
    },
    "es": {
        "agree": "De acuerdo", "all_decisions": "Todas las decisiones", "artifact_fingerprint": "Huella del artefacto",
        "basis": "Fundamento", "boundary": "Límite", "comment": "Comentario o corrección",
        "component": "Componente", "component_review": "Revisión del componente", "consolidated": "Revisión consolidada de decisiones",
        "consolidated_copy": "Copiar comprobante consolidado", "consolidated_kicker": "INGENIERÍA DE RESULTADOS OIO · REVISIÓN CONSOLIDADA",
        "consolidated_question": "¿El conjunto completo de decisiones está listo para un comprobante de aprobación del paquete?",
        "consolidated_subtitle": "Todas las decisiones del paquete con el mismo estado que en su página",
        "copy_package": "Copiar un comprobante de aprobación para todo el paquete.", "copy_review": "Copiar comprobante de revisión",
        "date": "Fecha", "decisions": "decisiones", "definition_fingerprint": "Huella de la definición",
        "index_instruction": "Revisa cada componente en orden.", "integrity": "Detalles de integridad del paquete",
        "next": "Siguiente componente", "package_files": "Archivos del paquete", "package_index": "Índice del paquete",
        "package_review": "Revisión del paquete", "pending": "Decisiones pendientes", "pending_only": "Solo pendientes",
        "print": "Imprimir / Guardar PDF", "project": "Proyecto", "question": "Pregunta", "reviewed": "Revisado",
        "review_sequence": "Secuencia de revisión", "revise": "Revisar", "revision": "Revisión", "statement": "Declaración",
        "status": "Estado", "summary": "Las {count} decisiones en una revisión y un comprobante de aprobación.",
        "table_copy": "Este componente repite cada decisión del paquete en su orden original. Revisa aquí o en cada página; cada ID conserva un único estado en el navegador.",
        "table_decisions": "Decisiones", "table_intro": "Conjunto completo de decisiones",
        "table_receipt": "El comprobante consolidado incluye las {count} decisiones y sus comentarios.",
        "table_title": "Título",
        "local_note": "Las selecciones permanecen en este navegador hasta que copies el comprobante. Revisar y Pregunta requieren un comentario para dejar de estar pendientes.",
    },
}


class BuildError(RuntimeError):
    pass


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_fields(record: dict[str, Any], required: set[str], label: str) -> None:
    missing = sorted(field for field in required if field not in record)
    if missing:
        raise BuildError(f"{label} is missing required fields: {', '.join(missing)}")


def resolve_source(base: Path, raw_path: str, label: str) -> Path:
    source = Path(raw_path).expanduser()
    if not source.is_absolute():
        source = (base / source).resolve()
    if not source.is_file():
        raise BuildError(f"{label} does not exist: {source}")
    return source


def safe_target(raw_target: str, label: str) -> PurePosixPath:
    target = PurePosixPath(raw_target)
    if target.is_absolute() or not target.parts or ".." in target.parts:
        raise BuildError(f"{label} must stay inside the package: {raw_target}")
    if any(part in {"", "."} for part in target.parts):
        raise BuildError(f"{label} contains an invalid path segment: {raw_target}")
    return target


def slugify(value: str) -> str:
    value = "".join(
        character for character in unicodedata.normalize("NFKD", value)
        if not unicodedata.combining(character)
    )
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "review"


def ui_copy(package: dict[str, Any]) -> dict[str, str]:
    return UI_COPY.get(str(package.get("language", "en")), UI_COPY["en"])


def project_palette(package: dict[str, Any]) -> str:
    explicit = package.get("project_palette")
    if explicit:
        palette = str(explicit).lower()
        if palette not in PALETTES:
            raise BuildError(
                f"Invalid project_palette: {explicit}; expected one of {sorted(PALETTES)}"
            )
        return palette
    digest = hashlib.sha256(str(package["project_name"]).strip().lower().encode("utf-8")).digest()
    return sorted(PALETTES)[digest[0] % len(PALETTES)]


def escape(value: Any) -> str:
    return html.escape(str(value), quote=True)


def validate_body(body: str, label: str) -> None:
    for pattern in FORBIDDEN_BODY_PATTERNS:
        if pattern.search(body):
            raise BuildError(f"{label} contains forbidden active or document-level HTML: {pattern.pattern}")
    for callout in CALLOUT_PATTERN.findall(body):
        if INTEGRITY_TRACE_PATTERN.search(callout):
            raise BuildError(
                f"{label} highlights technical integrity data; move it to manifest integrity_details"
            )


def load_manifest(manifest_path: Path) -> tuple[dict[str, Any], dict[str, str], list[dict[str, str]]]:
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise BuildError(f"Cannot read manifest: {exc}") from exc

    if not isinstance(data, dict):
        raise BuildError("Manifest root must be a JSON object")

    package = data.get("package")
    documents = data.get("documents")
    copy_files = data.get("copy_files", [])
    downloads = data.get("downloads", [])
    integrity_details = data.get("integrity_details", [])

    if not isinstance(package, dict):
        raise BuildError("package must be an object")
    if not isinstance(documents, list) or not documents:
        raise BuildError("documents must be a non-empty array")
    if not isinstance(copy_files, list) or not isinstance(downloads, list):
        raise BuildError("copy_files and downloads must be arrays")
    if not isinstance(integrity_details, list):
        raise BuildError("integrity_details must be an array")

    require_fields(package, REQUIRED_PACKAGE_FIELDS, "package")
    package["resolved_project_palette"] = project_palette(package)
    base = manifest_path.parent.resolve()
    bodies: dict[str, str] = {}
    decision_ids: set[str] = set()
    document_ids: set[str] = set()
    document_numbers: set[str] = set()

    for index, document in enumerate(documents):
        if not isinstance(document, dict):
            raise BuildError(f"documents[{index}] must be an object")
        require_fields(document, REQUIRED_DOCUMENT_FIELDS, f"documents[{index}]")
        doc_id = str(document["id"])
        number = str(document["number"])
        if doc_id in document_ids:
            raise BuildError(f"Duplicate document id: {doc_id}")
        if number in document_numbers:
            raise BuildError(f"Duplicate document number: {number}")
        document_ids.add(doc_id)
        document_numbers.add(number)

        body_path = resolve_source(base, str(document["body_file"]), f"body_file for {doc_id}")
        body = body_path.read_text(encoding="utf-8")
        validate_body(body, f"body_file for {doc_id}")
        bodies[doc_id] = body

        decisions = document["decisions"]
        if not isinstance(decisions, list) or not decisions:
            raise BuildError(f"{doc_id} must contain at least one decision")
        for decision_index, decision in enumerate(decisions):
            if not isinstance(decision, dict):
                raise BuildError(f"{doc_id}.decisions[{decision_index}] must be an object")
            require_fields(decision, REQUIRED_DECISION_FIELDS, f"{doc_id}.decisions[{decision_index}]")
            decision_id = str(decision["id"])
            decision_title = str(decision["title"])
            if decision_id in decision_ids:
                raise BuildError(f"Duplicate decision id: {decision_id}")
            if REDUNDANT_DECISION_TITLE_PATTERN.search(decision_title):
                raise BuildError(
                    f"{decision_id} is procedural or implied review context, not an independent "
                    "Human decision; keep it as concise body text"
                )
            decision_ids.add(decision_id)
            if decision["status"] not in STATUSES:
                raise BuildError(
                    f"Invalid status for {decision_id}: {decision['status']}; expected {sorted(STATUSES)}"
                )

        for target_field in ("word_target", "pdf_target"):
            if document.get(target_field):
                safe_target(str(document[target_field]), f"{doc_id}.{target_field}")

    normalized_copies: list[dict[str, str]] = []
    copy_targets: set[str] = set()
    for index, entry in enumerate(copy_files):
        if not isinstance(entry, dict) or not {"source", "target"}.issubset(entry):
            raise BuildError(f"copy_files[{index}] requires source and target")
        source = resolve_source(base, str(entry["source"]), f"copy_files[{index}].source")
        target = safe_target(str(entry["target"]), f"copy_files[{index}].target")
        target_string = target.as_posix()
        if target_string in copy_targets:
            raise BuildError(f"Duplicate copy target: {target_string}")
        if target.parts[0] in {"reviews"} or target_string in {
            "index.html",
            "DEFINITION-FINGERPRINT.txt",
            "ARTIFACT-FINGERPRINT.txt",
            "MANIFEST-SHA256.txt",
            MARKER_NAME,
            "assets/review.css",
            "assets/review.js",
        }:
            raise BuildError(f"copy target collides with generated output: {target_string}")
        copy_targets.add(target_string)
        normalized_copies.append(
            {"source": str(source), "target": target_string, "sha256": sha256_file(source)}
        )

    for index, download in enumerate(downloads):
        if not isinstance(download, dict) or "label" not in download or "target" not in download:
            raise BuildError(f"downloads[{index}] requires label and target")
        safe_target(str(download["target"]), f"downloads[{index}].target")
        if download.get("placement", "package") not in {"package", "integrity"}:
            raise BuildError(f"downloads[{index}].placement must be package or integrity")

    for index, item in enumerate(integrity_details):
        if not isinstance(item, dict) or not {"label", "value"}.issubset(item):
            raise BuildError(f"integrity_details[{index}] requires label and value")

    data["copy_files"] = normalized_copies
    data["downloads"] = downloads
    data["integrity_details"] = integrity_details
    return data, bodies, normalized_copies


def artifact_fingerprint(data: dict[str, Any], bodies: dict[str, str]) -> str:
    package = {
        key: value
        for key, value in data["package"].items()
        if key != "resolved_project_palette"
    }
    documents: list[dict[str, Any]] = []
    for document in data["documents"]:
        normalized = {key: value for key, value in document.items() if key != "body_file"}
        normalized["body_sha256"] = sha256_bytes(bodies[str(document["id"])].encode("utf-8"))
        documents.append(normalized)
    copies = [
        {"target": entry["target"], "sha256": entry["sha256"]}
        for entry in data.get("copy_files", [])
    ]
    payload = {
        "package": package,
        "documents": documents,
        "copy_files": copies,
        "downloads": data.get("downloads", []),
        "integrity_details": data.get("integrity_details", []),
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return sha256_bytes(encoded)


def prepare_output(output: Path, replace_generated: bool) -> None:
    resolved = output.expanduser().resolve()
    if resolved == Path(resolved.anchor) or resolved == Path.home().resolve() or len(resolved.parts) < 3:
        raise BuildError(f"Refusing unsafe output directory: {resolved}")

    if resolved.exists() and any(resolved.iterdir()):
        marker = resolved / MARKER_NAME
        if not replace_generated:
            raise BuildError(f"Output is not empty: {resolved}; use a new directory")
        if not marker.is_file() or marker.read_text(encoding="utf-8") != MARKER_VALUE:
            raise BuildError("--replace-generated requires an output created by this skill")
        for child in resolved.iterdir():
            if child.is_dir() and not child.is_symlink():
                shutil.rmtree(child)
            else:
                child.unlink()
    resolved.mkdir(parents=True, exist_ok=True)


def decision_html(decision: dict[str, Any], ui: dict[str, str]) -> str:
    initial = initial_choice(decision)
    basis = ""
    if decision.get("basis"):
        basis = f'<p class="basis"><strong>{ui["basis"]}:</strong> {escape(decision["basis"])}</p>'
    source = ""
    if decision.get("_source_id") and decision.get("_source_title"):
        source = (
            f'<div class="decision-source">{escape(decision["_source_id"])} · '
            f'{escape(decision["_source_title"])}</div>'
        )
    return f"""
<section class="decision" data-id="{escape(decision['id'])}" data-initial="{escape(initial)}">
  {source}
  <div class="decision-id">{escape(decision['id'])} · {escape(decision['status']).upper()}</div>
  <h3>{escape(decision['title'])}</h3>
  <p><strong>{ui['statement']}:</strong> {escape(decision['statement'])}</p>
  <p><strong>{ui['boundary']}:</strong> {escape(decision['boundary'])}</p>
  {basis}
  <div class="choices" role="group" aria-label="{ui['component_review']} {escape(decision['id'])}">
    <button type="button" data-choice="agree" aria-pressed="false">{ui['agree']}</button>
    <button type="button" data-choice="revise" aria-pressed="false">{ui['revise']}</button>
    <button type="button" data-choice="question" aria-pressed="false">{ui['question']}</button>
  </div>
  <textarea aria-label="{ui['comment']} {escape(decision['id'])}" placeholder="{ui['comment']}"></textarea>
</section>"""


def initial_choice(decision: dict[str, Any]) -> str:
    return {"agreed": "agree", "pending": "", "revise": "revise", "question": "question"}[
        decision["status"]
    ]


def decision_refs(decisions: list[dict[str, Any]]) -> str:
    return "".join(
        f'<span hidden data-decision-ref="{escape(decision["id"])}" '
        f'data-initial="{escape(initial_choice(decision))}"></span>'
        for decision in decisions
    )


def consolidated_number(documents: list[dict[str, Any]]) -> str:
    raw_numbers = [str(document["number"]) for document in documents]
    if raw_numbers and all(number.isdigit() for number in raw_numbers):
        width = max(2, max(len(number) for number in raw_numbers))
        return str(max(int(number) for number in raw_numbers) + 1).zfill(width)
    return str(len(documents) + 1).zfill(2)


def relative_download_link(target: str, label: str) -> str:
    return f'<a class="button" href="../{escape(target)}">{escape(label)}</a>'


def review_page(
    package: dict[str, Any],
    document: dict[str, Any],
    body: str,
    definition_fp: str,
    artifact_fp: str,
    next_component: tuple[str, str] | None = None,
) -> str:
    ui = ui_copy(package)
    is_consolidated = str(document["id"]) == CONSOLIDATED_ID
    copy_label = ui["consolidated_copy"] if is_consolidated else ui["copy_review"]
    actions = [
        f'<label><input id="pending" type="checkbox"> {ui["pending_only"]}</label>',
        f'<button id="copy" type="button">{copy_label}</button>',
        f'<button type="button" onclick="window.print()">{ui["print"]}</button>',
    ]
    if document.get("word_target"):
        actions.append(relative_download_link(str(document["word_target"]), "Word"))
    if document.get("pdf_target"):
        actions.append(relative_download_link(str(document["pdf_target"]), "PDF"))

    decisions = "\n".join(decision_html(item, ui) for item in document["decisions"])
    next_link = ""
    if next_component:
        next_link = (
            f' <a class="next-component" href="{escape(next_component[0])}" '
            f'aria-label="{ui["next"]}: {escape(next_component[1])}">{ui["next"]} →</a>'
        )
    return f"""<!doctype html>
<html lang="{escape(package.get('language', 'en'))}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{escape(package['project_name'])} · {escape(document['title'])} · {escape(package['title'])}</title>
  <link rel="stylesheet" href="../assets/review.css">
</head>
<body data-language="{escape(package.get('language', 'en'))}" data-project="{escape(package['project_name'])}" data-palette="{escape(package['resolved_project_palette'])}" data-doc="{escape(document['id'])}" data-title="{escape(document['title'])}" data-receipt-scope="{'package' if is_consolidated else 'component'}" data-revision="{escape(package['revision'])}" data-definition-fingerprint="{escape(definition_fp)}" data-artifact-fingerprint="{escape(artifact_fp)}">
  <header class="top">
    <nav class="review-nav"><a href="../index.html">← {ui['package_index']}</a>{'' if is_consolidated else f' <a href="all-decisions.html">{ui["all_decisions"]}</a>'}{next_link}</nav>
    <div class="actions">{' '.join(actions)}</div>
  </header>
  <main class="review-layout">
    <article>
      <div class="identity-row">
        <p class="project-name">{ui['project']} · {escape(package['project_name'])}</p>
        <span id="component-reviewed-mark" class="review-state reviewed" hidden>✓ {ui['reviewed']}</span>
      </div>
      <p class="kicker">{escape(document['kicker'])}</p>
      <h1>{escape(document['title'])}</h1>
      <p class="subtitle">{escape(document['subtitle'])}</p>
      <div class="status-strip">
        <div><strong>{ui['status']}</strong>{escape(package['status'])}</div>
        <div><strong>{ui['revision']}</strong>{escape(package['revision'])}</div>
        <div><strong>{ui['date']}</strong>{escape(package['date'])}</div>
      </div>
      {body}
    </article>
    <aside class="review-panel">
      <div class="aside-head">
        <p class="kicker">{ui['package_review'] if is_consolidated else ui['component_review']}</p>
        <h2>{len(document['decisions'])} {ui['decisions']}</h2>
        <p>{escape(document['review_question'])}</p>
        <div id="progress"></div>
        <p class="local-note">{ui['local_note']}</p>
      </div>
      {decisions}
    </aside>
  </main>
  <script src="../assets/review.js"></script>
</body>
</html>
"""


def consolidated_document(data: dict[str, Any]) -> tuple[dict[str, Any], str]:
    ui = ui_copy(data["package"])
    decisions: list[dict[str, Any]] = []
    component_rows: list[str] = []
    for document in data["documents"]:
        component_rows.append(
            f"<tr><td>{escape(document['id'])}</td><td>{escape(document['title'])}</td>"
            f"<td>{len(document['decisions'])}</td></tr>"
        )
        for decision in document["decisions"]:
            consolidated = dict(decision)
            consolidated["_source_id"] = str(document["id"])
            consolidated["_source_title"] = str(document["title"])
            decisions.append(consolidated)

    document = {
        "id": CONSOLIDATED_ID,
        "number": consolidated_number(data["documents"]),
        "title": ui["consolidated"],
        "summary": ui["summary"].format(count=len(decisions)),
        "review_question": ui["consolidated_question"],
        "kicker": ui["consolidated_kicker"],
        "subtitle": ui["consolidated_subtitle"],
        "decisions": decisions,
    }
    body = f"""
<h2>{ui['table_intro']}</h2>
<p>{ui['table_copy']}</p>
<p>{ui['table_receipt'].format(count=len(decisions))}</p>
<div class="table-wrap">
  <table>
    <thead><tr><th>{ui['component']}</th><th>{ui['table_title']}</th><th>{ui['table_decisions']}</th></tr></thead>
    <tbody>{''.join(component_rows)}</tbody>
  </table>
</div>
"""
    return document, body


def index_page(
    data: dict[str, Any], definition_fp: str, artifact_fp: str, review_paths: dict[str, str]
) -> str:
    package = data["package"]
    ui = ui_copy(package)
    total_decisions = sum(len(document["decisions"]) for document in data["documents"])
    cards = []
    for document in data["documents"]:
        cards.append(
            f"""<a class="doc-card" data-review-component="true" href="{escape(review_paths[str(document['id'])])}">
  {decision_refs(document['decisions'])}
  <span class="card-state"><span class="review-state reviewed" data-reviewed-mark hidden>✓ {ui['reviewed']}</span><span class="review-state pending" data-pending-mark hidden>● {ui['pending']}</span></span>
  <span class="doc-number">{escape(document['number'])} · {escape(document['id'])}</span>
  <h2>{escape(document['title'])}</h2>
  <p>{escape(document['summary'])}</p>
  <p><strong>{escape(document['review_question'])}</strong></p>
</a>"""
        )
    cards.append(
        f"""<a class="doc-card" data-review-component="true" href="{CONSOLIDATED_PATH}">
  {decision_refs([decision for document in data['documents'] for decision in document['decisions']])}
  <span class="card-state"><span class="review-state reviewed" data-reviewed-mark hidden>✓ {ui['reviewed']}</span><span class="review-state pending" data-pending-mark hidden>● {ui['pending']}</span></span>
  <span class="doc-number">{consolidated_number(data['documents'])} · {CONSOLIDATED_ID}</span>
  <h2>{ui['consolidated']}</h2>
  <p>{ui['summary'].format(count=total_decisions)}</p>
  <p><strong>{ui['copy_package']}</strong></p>
</a>"""
    )

    downloads = []
    integrity_downloads = []
    for item in data.get("downloads", []):
        description = escape(item.get("description", ""))
        if item.get("placement", "package") == "integrity":
            integrity_downloads.append(
                f'<a href="{escape(item["target"])}">{escape(item["label"])}</a>'
            )
        else:
            downloads.append(
                f'<a class="download-card" href="{escape(item["target"])}"><strong>{escape(item["label"])}</strong><span>{description}</span></a>'
            )
    downloads_html = ""
    if downloads:
        downloads_html = f'<h2>{ui["package_files"]}</h2><div class="downloads">{"".join(downloads)}</div>'

    integrity_items = [
        f'<div><span>{escape(item["label"])}</span><code>{escape(item["value"])}</code></div>'
        for item in data.get("integrity_details", [])
    ]
    integrity_items.extend(
        [
            f'<div><span>{ui["definition_fingerprint"]}</span><code>{escape(definition_fp)}</code></div>',
            f'<div><span>{ui["artifact_fingerprint"]}</span><code>{escape(artifact_fp)}</code></div>',
        ]
    )
    integrity_links = ""
    if integrity_downloads:
        integrity_links = f'<div class="integrity-links">{" · ".join(integrity_downloads)}</div>'

    return f"""<!doctype html>
<html lang="{escape(package.get('language', 'en'))}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{escape(package['project_name'])} · {escape(package['title'])} · Revision {escape(package['revision'])}</title>
  <link rel="stylesheet" href="assets/review.css">
</head>
<body data-language="{escape(package.get('language', 'en'))}" data-project="{escape(package['project_name'])}" data-palette="{escape(package['resolved_project_palette'])}" data-title="{escape(package['title'])}" data-receipt-scope="package-index" data-revision="{escape(package['revision'])}" data-definition-fingerprint="{escape(definition_fp)}" data-artifact-fingerprint="{escape(artifact_fp)}">
  <main class="package-shell">
    <div class="identity-row">
      <p class="project-name">{ui['project']} · {escape(package['project_name'])}</p>
      <span id="package-reviewed-mark" class="review-state reviewed" hidden>✓ {ui['reviewed']}</span>
    </div>
    <p class="kicker">{escape(package['kicker'])}</p>
    <h1>{escape(package['title'])}</h1>
    <p class="package-lead">{escape(package['subtitle'])}</p>
    <div class="status-strip">
      <div><strong>{ui['status']}</strong>{escape(package['status'])}</div>
      <div><strong>{ui['revision']}</strong>{escape(package['revision'])}</div>
      <div><strong>{ui['date']}</strong>{escape(package['date'])}</div>
    </div>
    <section aria-labelledby="documents-title">
      <p class="kicker">{ui['review_sequence']}</p>
      <h2 id="documents-title">{ui['index_instruction']}</h2>
      <div class="cards">{''.join(cards)}</div>
    </section>
    {downloads_html}
    <details class="integrity-details">
      <summary>{ui['integrity']}</summary>
      <div class="integrity-values">
        {''.join(integrity_items)}
      </div>
      {integrity_links}
    </details>
  </main>
  <script src="assets/review.js"></script>
</body>
</html>
"""


def copy_declared_files(output: Path, copies: list[dict[str, str]]) -> None:
    for entry in copies:
        target = output / PurePosixPath(entry["target"])
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(entry["source"], target)
        if sha256_file(target) != entry["sha256"]:
            raise BuildError(f"Copied file hash mismatch: {entry['target']}")


def write_manifest(output: Path) -> None:
    lines = []
    for path in sorted(item for item in output.rglob("*") if item.is_file()):
        relative = path.relative_to(output).as_posix()
        if relative == "MANIFEST-SHA256.txt":
            continue
        lines.append(f"{sha256_file(path)}  {relative}")
    (output / "MANIFEST-SHA256.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")


def validate_output(
    output: Path,
    data: dict[str, Any],
    review_paths: dict[str, str],
    definition_fp: str,
    artifact_fp: str,
) -> None:
    required = {
        "index.html",
        "assets/review.css",
        "assets/review.js",
        "DEFINITION-FINGERPRINT.txt",
        "ARTIFACT-FINGERPRINT.txt",
        "MANIFEST-SHA256.txt",
        MARKER_NAME,
        CONSOLIDATED_PATH,
        *review_paths.values(),
    }
    for document in data["documents"]:
        for field in ("word_target", "pdf_target"):
            if document.get(field):
                required.add(str(document[field]))
    for item in data.get("downloads", []):
        required.add(str(item["target"]))
    missing = sorted(path for path in required if not (output / path).is_file())
    if missing:
        raise BuildError(f"Generated package has missing files: {', '.join(missing)}")
    if (output / "DEFINITION-FINGERPRINT.txt").read_text(encoding="utf-8").strip() != definition_fp:
        raise BuildError("Definition fingerprint readback failed")
    if (output / "ARTIFACT-FINGERPRINT.txt").read_text(encoding="utf-8").strip() != artifact_fp:
        raise BuildError("Artifact fingerprint readback failed")


def build(manifest_path: Path, output: Path, replace_generated: bool) -> tuple[str, str]:
    data, bodies, copies = load_manifest(manifest_path.resolve())
    definition_fp = str(data["package"].get("definition_fingerprint") or "not-supplied")
    artifact_fp = artifact_fingerprint(data, bodies)
    prepare_output(output, replace_generated)
    output = output.expanduser().resolve()

    (output / "assets").mkdir(parents=True, exist_ok=True)
    (output / "reviews").mkdir(parents=True, exist_ok=True)
    shutil.copy2(ASSET_ROOT / "review.css", output / "assets" / "review.css")
    shutil.copy2(ASSET_ROOT / "review.js", output / "assets" / "review.js")
    copy_declared_files(output, copies)

    review_paths: dict[str, str] = {}
    for document in data["documents"]:
        filename = f"{document['number']}-{slugify(str(document['title']))}.html"
        review_path = f"reviews/{filename}"
        review_paths[str(document["id"])] = review_path
        current_index = len(review_paths) - 1
        ordered_documents = data["documents"]
        if current_index + 1 < len(ordered_documents):
            next_document = ordered_documents[current_index + 1]
            next_component = (
                PurePosixPath(
                    f"{next_document['number']}-{slugify(str(next_document['title']))}.html"
                ).as_posix(),
                str(next_document["title"]),
            )
        else:
            next_component = ("all-decisions.html", ui_copy(data["package"])["consolidated"])
        rendered = review_page(
            data["package"],
            document,
            bodies[str(document["id"])],
            definition_fp,
            artifact_fp,
            next_component,
        )
        (output / review_path).write_text(rendered, encoding="utf-8")

    all_document, all_body = consolidated_document(data)
    (output / CONSOLIDATED_PATH).write_text(
        review_page(data["package"], all_document, all_body, definition_fp, artifact_fp),
        encoding="utf-8",
    )

    (output / "index.html").write_text(
        index_page(data, definition_fp, artifact_fp, review_paths), encoding="utf-8"
    )
    (output / "DEFINITION-FINGERPRINT.txt").write_text(definition_fp + "\n", encoding="utf-8")
    (output / "ARTIFACT-FINGERPRINT.txt").write_text(artifact_fp + "\n", encoding="utf-8")
    (output / MARKER_NAME).write_text(MARKER_VALUE, encoding="utf-8")
    write_manifest(output)
    validate_output(output, data, review_paths, definition_fp, artifact_fp)
    return definition_fp, artifact_fp


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="OIO review package JSON manifest")
    parser.add_argument("output", type=Path, help="new or marked generated output directory")
    parser.add_argument(
        "--replace-generated",
        action="store_true",
        help="replace an existing directory only when it contains this generator's marker",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        definition_fp, artifact_fp = build(args.manifest, args.output, args.replace_generated)
    except BuildError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(f"Built: {args.output.expanduser().resolve()}")
    print(f"Definition fingerprint: {definition_fp}")
    print(f"Artifact fingerprint: {artifact_fp}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
