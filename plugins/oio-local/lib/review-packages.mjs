import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JourneyHold } from "./local-state.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builder = path.join(
  pluginRoot,
  "skills/oio-review-artifact/scripts/build_review_artifact.py",
);

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function buildPackage({ body, manifest, root, slug }) {
  const source = path.join(root, "source", slug);
  const output = path.join(root, "reviews", slug);
  await mkdir(source, { recursive: true });
  await rm(output, { force: true, recursive: true });
  await writeFile(path.join(source, "body.html"), body, "utf8");
  await writeFile(
    path.join(source, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  const result = spawnSync(
    "python3",
    [builder, path.join(source, "manifest.json"), output],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    throw new JourneyHold(
      "REVIEW_ARTIFACT_FAILED",
      "The Human review artifact could not be created.",
      "Verify the bundled review-artifact runtime, then retry this transition.",
      { stderr: result.stderr },
    );
  }
  return {
    artifactFingerprint: (await readFile(
      path.join(output, "ARTIFACT-FINGERPRINT.txt"),
      "utf8",
    )).trim(),
    path: path.join(output, "index.html"),
  };
}

function spanishOutcomeReview({ input, requestRoot, revision }) {
  const body = `
<h2>Hará</h2>
<ul>
  <li>Convertir una solicitud de soporte real en una respuesta fundamentada y una lista de tareas útil.</li>
  <li>Preservar la autoridad humana sobre la verificación de pagos y los reembolsos.</li>
  <li>Probar tanto la ruta útil como el rechazo de resultados inválidos del agente.</li>
</ul>
<h2>No hará</h2>
<ul>
  <li>Emitir un reembolso, enviar un correo ni modificar un sistema externo de soporte.</li>
  <li>Ejecutar una versión posterior sin aprobación separada.</li>
</ul>
<h2>Solicitud usada para el Flujo de Trabajo 0</h2>
<p><strong>${escapeHtml(input.subject)}</strong> — ${escapeHtml(input.message)}</p>
<p>La fuente original se conserva sin traducir. La explicación y el entregable usan el idioma seleccionado.</p>
<h2>Definición completa del Resultado</h2>
<table>
  <tbody>
    <tr><th>Resultado deseado</th><td>Una respuesta fundamentada y una lista de tareas útil para esta solicitud.</td></tr>
    <tr><th>Prueba</th><td>El entregable guardado identifica el problema, incluye la respuesta y las tareas, rechaza resultados inválidos y pasa la lectura por huella exacta.</td></tr>
    <tr><th>Alcance</th><td>Un resultado local en español para el asistente de solicitudes de soporte.</td></tr>
    <tr><th>Exclusiones</th><td>Sin correo, consulta de pagos, reembolso, modificación del sistema de soporte, recurrencia ni ejecución de versiones posteriores.</td></tr>
    <tr><th>Autoridad</th><td>La persona aprueba el Resultado exacto, la especificación y el resultado final. El agente solo puede crear un borrador local.</td></tr>
    <tr><th>Recursos</th><td>El proyecto local, el controlador de OIO Local, las habilidades admitidas, el estado SQLite y la solicitud suministrada.</td></tr>
    <tr><th>Referencias</th><td>La solicitud suministrada para ${escapeHtml(input.orderId)} y las identidades exactas de sus artefactos.</td></tr>
    <tr><th>Supuestos</th><td>La solicitud suministrada es auténtica y una persona puede verificar después los registros de pago.</td></tr>
    <tr><th>Riesgos</th><td>Un borrador no fundamentado podría indicar que ya ocurrió un reembolso. El contrato de salida rechaza esa afirmación.</td></tr>
    <tr><th>Límites</th><td>El flujo no accede a sistemas de pagos o soporte y no puede confirmar un reembolso.</td></tr>
    <tr><th>Efectos externos</th><td>Ninguno. Todo el resultado permanece en el proyecto local.</td></tr>
    <tr><th>Condiciones de parada</th><td>Detener ante falta de aprobación exacta, entrada inválida, identidad o resultado inválido del agente, o error de lectura.</td></tr>
    <tr><th>V0 propuesto</th><td>S0 de entrada determinista, S1 de juicio acotado y S2 de creación y lectura deterministas.</td></tr>
  </tbody>
</table>
`;
  const manifest = {
    package: {
      project_name: "OIO Local",
      project_palette: "blue",
      title: "Definición del Resultado del asistente de soporte",
      revision,
      date: new Date().toISOString().slice(0, 10),
      kicker: "OIO LOCAL · REVISIÓN DEL RESULTADO",
      subtitle: "Revisión humana exacta antes de la especificación",
      status: "Provisional",
      language: "es",
    },
    documents: [{
      id: "OUTCOME",
      number: "01",
      title: "Definición del Resultado y Hará / No hará",
      summary: "El resultado, la prueba, la autoridad, los límites y la versión real más pequeña.",
      review_question: "¿Este es el resultado exacto del asistente de soporte que debemos perseguir?",
      kicker: "OIO LOCAL · REVISIÓN DEL RESULTADO",
      subtitle: "Límite basado en el resultado",
      body_file: "body.html",
      decisions: [
        {
          id: "OUT-001", status: "pending", title: "Resultado deseado",
          statement: "Crear una respuesta de soporte útil y fundamentada con tareas a partir de la solicitud suministrada.",
          boundary: "No se autoriza ningún mensaje externo ni reembolso.",
        },
        {
          id: "OUT-002", status: "pending", title: "Prueba observable",
          statement: "El entregable identifica el problema, redacta la respuesta, enumera tareas concretas, rechaza resultados inválidos y se relee por su huella.",
          boundary: "Un archivo fuente o una prueba unitaria aislada no demuestra el resultado.",
        },
        {
          id: "OUT-003", status: "pending", title: "Flujo de Trabajo 0",
          statement: "Usar un Paso de entrada determinista, un Paso de juicio y un Paso de creación determinista.",
          boundary: "Una automatización posterior o integración externa requiere otra autorización.",
        },
        {
          id: "OUT-004", status: "pending", title: "Autoridad y efectos externos",
          statement: "Los agentes pueden crear el borrador local y la prueba; solo una persona puede autorizar verificación de pagos, reembolsos, envíos o versiones posteriores.",
          boundary: "El flujo actual no tiene autoridad para modificar sistemas externos.",
        },
      ],
    }],
  };
  return buildPackage({ body, manifest, root: requestRoot, slug: `outcome-${revision}` });
}

function spanishSpecificationReview({ outcomeFingerprint, input, requestRoot, revision }) {
  const body = `
<h2>Base aprobada</h2>
<p>El V0 solicitado procesa <strong>${escapeHtml(input.subject)}</strong> sin modificar sistemas externos.</p>
<h2>Ruta de implementación</h2>
<ol>
  <li>S0 valida y normaliza la solicitud suministrada.</li>
  <li>S1 entrega a un agente secundario acotado el contrato de interpretación y redacción.</li>
  <li>S2 valida el resultado del agente, crea el entregable y lo relee.</li>
</ol>
`;
  const manifest = {
    package: {
      project_name: "OIO Local",
      project_palette: "blue",
      title: "Especificación V0 del asistente de soporte",
      revision,
      date: new Date().toISOString().slice(0, 10),
      kicker: "OIO LOCAL · REVISIÓN DE LA ESPECIFICACIÓN",
      subtitle: "Decisiones heredadas del Resultado aprobado",
      status: "Provisional",
      definition_fingerprint: outcomeFingerprint,
      language: "es",
    },
    documents: [{
      id: "SPECIFICATION",
      number: "01",
      title: "Especificación del Flujo de Trabajo 0",
      summary: "Tres Pasos, un límite de juicio y prueba exacta del resultado.",
      review_question: "¿Esta implementación preserva el Resultado aprobado?",
      kicker: "OIO LOCAL · REVISIÓN DE LA ESPECIFICACIÓN",
      subtitle: "La prueba real más pequeña del Resultado",
      body_file: "body.html",
      decisions: [
        {
          id: "SPEC-001", status: "pending", title: "Ruta de Pasos",
          statement: "S0 valida la entrada, S1 interpreta y redacta, y S2 valida, crea y relee.",
          boundary: "Solo S1 recibe un agente secundario porque solo S1 requiere juicio.",
        },
        {
          id: "SPEC-002", status: "pending", title: "Límite protegido",
          statement: "El resultado inválido del agente se rechaza antes de escribir un entregable.",
          boundary: "El flujo nunca afirma que se ejecutó un reembolso.",
        },
        {
          id: "SPEC-003", status: "pending", title: "Punto de parada",
          statement: "V0 termina después del entregable local, la prueba, los límites, la lectura y la revisión humana.",
          boundary: "V1 permanece propuesto y no ejecutado.",
        },
      ],
    }],
  };
  return buildPackage({ body, manifest, root: requestRoot, slug: `specification-${revision}` });
}

export async function buildOutcomeReview({ request, requestRoot, revision = "0.1" }) {
  const input = JSON.parse(request.request_json);
  if (request.language === "es") {
    return spanishOutcomeReview({ input, requestRoot, revision });
  }
  const body = `
<h2>Will</h2>
<ul>
  <li>Turn one real support request into a grounded reply and an actionable task list.</li>
  <li>Preserve Human authority over payment verification and refunds.</li>
  <li>Prove both the useful path and rejection of invalid agent output.</li>
</ul>
<h2>Will not</h2>
<ul>
  <li>Issue a refund, send an email, or mutate an external support system.</li>
  <li>Execute a later version without separate approval.</li>
</ul>
<h2>Request used for Workflow 0</h2>
<p><strong>${escapeHtml(input.subject)}</strong> — ${escapeHtml(input.message)}</p>
<h2>Complete Outcome Definition</h2>
<table>
  <tbody>
    <tr><th>Desired outcome</th><td>One grounded reply and actionable task list for this support request.</td></tr>
    <tr><th>Proof</th><td>The saved deliverable names the issue, supplies the reply and tasks, rejects invalid child output, and passes exact hash readback.</td></tr>
    <tr><th>Scope</th><td>One local English support-request assistant result.</td></tr>
    <tr><th>Exclusions</th><td>No email, payment lookup, refund, support-system mutation, recurrence, or later-version execution.</td></tr>
    <tr><th>Authority</th><td>The Human approves the exact Outcome, specification, and final result. The agent may only draft local output.</td></tr>
    <tr><th>Resources</th><td>The local project, OIO Local controller, admitted skills, SQLite state, and the supplied request.</td></tr>
    <tr><th>References</th><td>The supplied request for ${escapeHtml(input.orderId)} and its exact review-artifact identities.</td></tr>
    <tr><th>Assumptions</th><td>The supplied request is authentic and a Human can later verify payment records.</td></tr>
    <tr><th>Risks</th><td>An ungrounded draft could imply a refund occurred. The output contract rejects that claim.</td></tr>
    <tr><th>Limits</th><td>The workflow does not access payment or support systems and cannot confirm a refund.</td></tr>
    <tr><th>External effects</th><td>None. All output stays in the local project.</td></tr>
    <tr><th>Stop conditions</th><td>Hold on missing exact approval, invalid input, invalid child identity or output, or failed result readback.</td></tr>
    <tr><th>Proposed V0</th><td>S0 deterministic intake, S1 bounded judgment, and S2 deterministic rendering and readback.</td></tr>
  </tbody>
</table>
`;
  const manifest = {
    package: {
      project_name: "OIO Local",
      project_palette: "blue",
      title: "Support-request assistant Outcome Definition",
      revision,
      date: new Date().toISOString().slice(0, 10),
      kicker: "OIO LOCAL · OUTCOME REVIEW",
      subtitle: "Exact Human review before specification",
      status: "Provisional",
    },
    documents: [{
      id: "OUTCOME",
      number: "01",
      title: "Outcome Definition and Will / Will Not",
      summary: "The outcome, proof, authority, limits, and smallest real version.",
      review_question: "Is this the exact support-assistant outcome to pursue?",
      kicker: "OIO LOCAL · OUTCOME REVIEW",
      subtitle: "Outcome-first boundary",
      body_file: "body.html",
      decisions: [
        {
          id: "OUT-001",
          status: "pending",
          title: "Desired outcome",
          statement: "Produce one useful, grounded support reply and task list from the supplied request.",
          boundary: "No external message or refund is authorized.",
        },
        {
          id: "OUT-002",
          status: "pending",
          title: "Observable proof",
          statement: "The deliverable names the issue, drafts the reply, lists concrete tasks, rejects invalid agent output, and is read back by hash.",
          boundary: "A source file or passing unit alone is not sufficient proof.",
        },
        {
          id: "OUT-003",
          status: "pending",
          title: "Workflow 0",
          statement: "Use one deterministic intake Step, one judgment Step, and one deterministic rendering Step.",
          boundary: "A later automation or external-system integration is a separately authorized version.",
        },
        {
          id: "OUT-004",
          status: "pending",
          title: "Authority and external effects",
          statement: "Agents may create the local draft and proof; only the Human may authorize payment verification, refund, sending, or a later version.",
          boundary: "The current workflow has no external mutation authority.",
        },
      ],
    }],
  };
  return buildPackage({ body, manifest, root: requestRoot, slug: `outcome-${revision}` });
}

export async function buildSpecificationReview({
  outcomeFingerprint,
  request,
  requestRoot,
  revision = "0.1",
}) {
  const input = JSON.parse(request.request_json);
  if (request.language === "es") {
    return spanishSpecificationReview({
      input,
      outcomeFingerprint,
      requestRoot,
      revision,
    });
  }
  const body = `
<h2>Approved foundation</h2>
<p>The requested V0 processes <strong>${escapeHtml(input.subject)}</strong> without external mutation.</p>
<h2>Implementation route</h2>
<ol>
  <li>S0 validates and normalizes the supplied request.</li>
  <li>S1 gives one bounded child agent the interpretation and drafting contract.</li>
  <li>S2 validates the child result, renders the deliverable, and reads it back.</li>
</ol>
`;
  const manifest = {
    package: {
      project_name: "OIO Local",
      project_palette: "blue",
      title: "Support-request assistant V0 Specification",
      revision,
      date: new Date().toISOString().slice(0, 10),
      kicker: "OIO LOCAL · SPECIFICATION REVIEW",
      subtitle: "Implementation decisions inherited from the approved outcome",
      status: "Provisional",
      definition_fingerprint: outcomeFingerprint,
    },
    documents: [{
      id: "SPECIFICATION",
      number: "01",
      title: "Workflow 0 specification",
      summary: "Three Steps, one judgment boundary, and exact result proof.",
      review_question: "Does this implementation preserve the approved outcome?",
      kicker: "OIO LOCAL · SPECIFICATION REVIEW",
      subtitle: "Smallest real outcome proof",
      body_file: "body.html",
      decisions: [
        {
          id: "SPEC-001",
          status: "pending",
          title: "Step route",
          statement: "S0 validates input, S1 interprets and drafts, and S2 validates, renders, and reads back.",
          boundary: "Only S1 receives a child agent because only S1 requires judgment.",
        },
        {
          id: "SPEC-002",
          status: "pending",
          title: "Protected boundary",
          statement: "Invalid child output is rejected before a deliverable is written.",
          boundary: "The workflow never claims that a refund was executed.",
        },
        {
          id: "SPEC-003",
          status: "pending",
          title: "Stopping point",
          statement: "V0 stops after the local deliverable, proof, limitations, readback, and Human result review.",
          boundary: "V1 remains proposed and unexecuted.",
        },
      ],
    }],
  };
  return buildPackage({
    body,
    manifest,
    root: requestRoot,
    slug: `specification-${revision}`,
  });
}
