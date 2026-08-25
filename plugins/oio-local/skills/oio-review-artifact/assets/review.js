(() => {
  const body = document.body;
  const language = body.dataset.language || "en";
  const ui = language === "es" ? {
    artifactFingerprint: "Huella del artefacto",
    comment: "Comentario",
    decided: "decididas",
    definitionFingerprint: "Huella de la definición",
    document: "Documento",
    pending: "pendientes",
    pendingChoice: "PENDIENTE",
    project: "Proyecto",
    receiptCopied: "Comprobante copiado",
    receiptScope: "Alcance del comprobante",
    review: "revisión",
    reviewed: "Revisado",
  } : {
    artifactFingerprint: "Artifact fingerprint",
    comment: "Comment",
    decided: "decided",
    definitionFingerprint: "Definition fingerprint",
    document: "Document",
    pending: "pending",
    pendingChoice: "PENDING",
    project: "Project",
    receiptCopied: "Receipt copied",
    receiptScope: "Receipt scope",
    review: "review",
    reviewed: "Reviewed",
  };
  const projectName = body.dataset.project || "Unspecified project";
  const docId = body.dataset.doc || "package";
  const definitionFingerprint = body.dataset.definitionFingerprint || "not-supplied";
  const artifactFingerprint = body.dataset.artifactFingerprint || "unknown";
  const revision = body.dataset.revision || "unversioned";
  const documentTitle = body.dataset.title || document.title;
  const receiptScope = body.dataset.receiptScope || "component";
  const storageKey = `oio-review:${artifactFingerprint}:decisions`;
  const decisions = [...document.querySelectorAll(".decision")];
  const reviewCards = [...document.querySelectorAll("[data-review-component]")];
  let state = {};

  try {
    state = JSON.parse(localStorage.getItem(storageKey) || "{}");
  } catch {
    state = {};
  }

  const initialState = (element) => ({
    choice: element.dataset.initial || "",
    comment: "",
  });

  const currentState = (element) => state[element.dataset.id] || initialState(element);
  const isCompleteChoice = (id, initial, decisionState) => {
    if (decisionState.choice === "agree") return true;
    if (!["revise", "question"].includes(decisionState.choice)) return false;
    if (decisionState.comment?.trim()) return true;
    return !state[id] && initial === decisionState.choice;
  };
  const isComplete = (element, decisionState) => (
    isCompleteChoice(element.dataset.id, element.dataset.initial, decisionState)
  );

  function renderReviewMarks() {
    const pageReviewedMark = document.querySelector("#component-reviewed-mark");
    if (pageReviewedMark) {
      pageReviewedMark.hidden = !decisions.every((element) => isComplete(element, currentState(element)));
    }

    for (const card of reviewCards) {
      const refs = [...card.querySelectorAll("[data-decision-ref]")];
      const reviewed = refs.every((ref) => {
        const decisionState = state[ref.dataset.decisionRef] || {
          choice: ref.dataset.initial || "",
          comment: "",
        };
        return isCompleteChoice(ref.dataset.decisionRef, ref.dataset.initial, decisionState);
      });
      const reviewedMark = card.querySelector("[data-reviewed-mark]");
      const pendingMark = card.querySelector("[data-pending-mark]");
      if (reviewedMark) reviewedMark.hidden = !reviewed;
      if (pendingMark) pendingMark.hidden = reviewed;
    }

    const packageReviewedMark = document.querySelector("#package-reviewed-mark");
    if (packageReviewedMark) {
      packageReviewedMark.hidden = !reviewCards.every(
        (card) => !card.querySelector("[data-reviewed-mark]")?.hidden,
      );
    }
  }

  function persist() {
    localStorage.setItem(storageKey, JSON.stringify(state));
    render();
  }

  function render() {
    const pendingOnly = Boolean(document.querySelector("#pending")?.checked);
    let decided = 0;

    for (const element of decisions) {
      const decisionState = currentState(element);
      const complete = isComplete(element, decisionState);
      element.dataset.choice = decisionState.choice;
      element.classList.toggle("hidden", pendingOnly && complete);

      for (const button of element.querySelectorAll("button[data-choice]")) {
        const active = button.dataset.choice === decisionState.choice;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      }

      const comment = element.querySelector("textarea");
      if (comment && comment.value !== decisionState.comment) {
        comment.value = decisionState.comment || "";
      }

      if (complete) decided += 1;
    }

    const progress = document.querySelector("#progress");
    if (progress) progress.textContent = `${decided} ${ui.decided} · ${decisions.length - decided} ${ui.pending}`;
    renderReviewMarks();
  }

  for (const element of decisions) {
    const id = element.dataset.id;

    for (const button of element.querySelectorAll("button[data-choice]")) {
      button.addEventListener("click", () => {
        state[id] = { ...currentState(element), choice: button.dataset.choice };
        persist();
      });
    }

    const comment = element.querySelector("textarea");
    comment?.addEventListener("input", () => {
      state[id] = { ...currentState(element), comment: comment.value };
      localStorage.setItem(storageKey, JSON.stringify(state));
    });
    comment?.addEventListener("change", render);
  }

  document.querySelector("#pending")?.addEventListener("change", render);

  document.querySelector("#copy")?.addEventListener("click", async () => {
    const lines = [
      `${ui.project}: ${projectName}`,
      `${documentTitle} — ${ui.review} ${revision}`,
      `${ui.document}: ${docId}`,
      `${ui.receiptScope}: ${receiptScope}`,
      `${ui.definitionFingerprint}: ${definitionFingerprint}`,
      `${ui.artifactFingerprint}: ${artifactFingerprint}`,
      `${ui.reviewed}: ${new Date().toISOString()}`,
      "",
    ];

    for (const element of decisions) {
      const decisionState = currentState(element);
      const title = element.querySelector("h3")?.textContent?.trim() || "";
      lines.push(`${element.dataset.id} · ${(decisionState.choice || ui.pendingChoice).toUpperCase()} · ${title}`);
      if (decisionState.comment?.trim()) lines.push(`  ${ui.comment}: ${decisionState.comment.trim()}`);
    }

    const receipt = lines.join("\n");

    try {
      await navigator.clipboard.writeText(receipt);
    } catch {
      const fallback = document.createElement("textarea");
      fallback.value = receipt;
      fallback.style.position = "fixed";
      fallback.style.opacity = "0";
      document.body.appendChild(fallback);
      fallback.select();
      document.execCommand("copy");
      fallback.remove();
    }

    const copyButton = document.querySelector("#copy");
    if (copyButton) {
      const original = copyButton.textContent;
      copyButton.textContent = ui.receiptCopied;
      window.setTimeout(() => { copyButton.textContent = original; }, 1800);
    }
  });

  window.addEventListener("storage", (event) => {
    if (event.key !== storageKey) return;
    try {
      state = JSON.parse(event.newValue || "{}");
    } catch {
      state = {};
    }
    render();
  });

  render();
})();
