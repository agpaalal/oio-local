const spanishHolds = {
  ACTIVE_STATE_IN_SYNC_FOLDER: [
    "El proyecto activo está dentro de la carpeta sincronizada de respaldo.",
    "Mueve el proyecto activo fuera de esa carpeta y conserva allí solo copias verificadas.",
  ],
  APPROVAL_FINGERPRINT_MISMATCH: [
    "La aprobación suministrada no coincide con el artefacto actual.",
    "Revisa el artefacto actual y aprueba su huella exacta.",
  ],
  APPROVAL_REQUIRED: [
    "El artefacto exacto todavía no está aprobado.",
    "Revisa el artefacto actual y aprueba su huella exacta antes de continuar.",
  ],
  BACKUP_CONTENT_MISMATCH: [
    "El contenido del respaldo no coincide con la solicitud cerrada y aprobada.",
    "Usa otra copia verificada; no restaures este respaldo.",
  ],
  BACKUP_DATABASE_INVALID: [
    "La base de datos del respaldo no es una copia SQLite válida y legible.",
    "Usa otra copia verificada; no restaures este respaldo.",
  ],
  BACKUP_DESTINATION_UNSAFE: [
    "El destino de respaldo configurado no es seguro.",
    "Elimina enlaces de la ruta o elige otra carpeta sincronizada.",
  ],
  BACKUP_HASH_MISMATCH: [
    "La identidad de un archivo del respaldo no coincide con el manifiesto.",
    "Usa otra copia verificada; no restaures este respaldo.",
  ],
  BACKUP_NOT_CONFIGURED: [
    "No hay un destino sincronizado configurado para el respaldo.",
    "Ejecuta la configuración con una carpeta de iCloud Drive o Google Drive.",
  ],
  BACKUP_SOURCE_NOT_CLOSED: [
    "El respaldo requiere una base de datos saludable y una solicitud cerrada.",
    "Cierra la solicitud exacta y aceptada antes de crear el respaldo.",
  ],
  ARTIFACT_REQUIRED: [
    "Falta el artefacto requerido para esta transición.",
    "Crea y revisa el artefacto requerido antes de continuar.",
  ],
  CHILD_MODEL_OVERRIDE_REQUIRED: [
    "El modelo alternativo no tiene una autorización humana separada.",
    "Explica por qué no está disponible el modelo preferido y registra la autorización de la alternativa.",
  ],
  CORRECTION_REASON_REQUIRED: [
    "La corrección V0 reabierta necesita una razón.",
    "Indica qué criterio aprobado de V0 no se cumplió.",
  ],
  DEFINITION_FINGERPRINT_MISMATCH: [
    "La especificación no hereda la Definición del Resultado aprobada y actual.",
    "Vuelve a crear la especificación desde el Resultado aprobado actual.",
  ],
  EXECUTION_PACKET_REQUIRED: [
    "Falta el paquete de ejecución aprobado para este Paso.",
    "Regresa a la transición de especificación aprobada y vuelve a crear el paquete.",
  ],
  HARNESS_HANDOFF_ALREADY_CONSUMED: [
    "Este comprobante de traspaso ya fue consumido.",
    "Crea un nuevo comprobante explícito para una transferencia posterior.",
  ],
  HARNESS_HANDOFF_REQUIRED: [
    "El traspaso requiere la identidad humana y un comprobante exacto.",
    "Proporciona ambos datos antes de transferir.",
  ],
  HARNESS_OWNER_MISMATCH: [
    "Esta solicitud pertenece a otro entorno activo.",
    "Usa el entorno propietario o completa una transferencia explícita verificada.",
  ],
  HARNESS_TRANSFER_AUTHORITY_MISMATCH: [
    "La transferencia no coincide con el artefacto de autoridad actual.",
    "Relee la huella actual y crea un nuevo comprobante de traspaso.",
  ],
  HARNESS_TRANSFER_IDENTITY_MISMATCH: [
    "La transferencia no coincide con el propietario y el entorno activos.",
    "Relee el propietario actual y usa el adaptador correcto.",
  ],
  HARNESS_TRANSFER_NOT_ALLOWED: [
    "La solicitud activa no tiene una retención exacta y vigente para transferir el entorno.",
    "Usa el entorno propietario para preparar el traspaso y vuelve a intentarlo desde el destino.",
  ],
  HARNESS_TRANSFER_STATE_MISMATCH: [
    "La solicitud no está en el estado exacto indicado para el traspaso.",
    "Relee el estado actual y prepara un nuevo traspaso.",
  ],
  HOST_ADAPTER_MISMATCH: [
    "El adaptador usado no coincide con el entorno activo del proyecto.",
    "Usa el adaptador del entorno activo antes de continuar.",
  ],
  INVALID_AGENT_IDENTITY: [
    "El resultado del agente no coincide con el paquete S1 aprobado.",
    "Ejecuta S1 con el paquete devuelto y conserva sus identidades exactas.",
  ],
  INVALID_AGENT_RESULT: [
    "El resultado del agente no cumple el contrato de salida.",
    "Vuelve a ejecutar el Paso de juicio con todos los campos requeridos.",
  ],
  INVALID_BACKUP_MANIFEST: [
    "El manifiesto del respaldo está incompleto o tiene un formato no admitido.",
    "Selecciona un respaldo completo de OIO Local con la versión 1 del esquema.",
  ],
  INVALID_EXECUTION_PACKET: [
    "El paquete S1 ya no coincide con la identidad de ejecución aprobada.",
    "Restaura el paquete aprobado o regresa a la aprobación de la especificación.",
  ],
  INVALID_REQUEST_STATE: [
    "Esta acción no está permitida en el estado actual de la solicitud.",
    "Reanuda la transición actual en lugar de omitir estados.",
  ],
  INVALID_STATE_TRANSITION: [
    "OIO Local no permite esa transición de estado.",
    "Reanuda la transición actual en lugar de omitir el ciclo de vida.",
  ],
  INVALID_SUPPORT_REQUEST: [
    "La solicitud de soporte no contiene todos los datos requeridos.",
    "Agrega los datos faltantes y vuelve a iniciar el Resultado actual.",
  ],
  OUTCOME_CHANGE_REQUIRES_INTAKE: [
    "La corrección solicitada cambia la identidad del Resultado aprobado.",
    "Inicia una solicitud sucesora y devuelve el nuevo Resultado a Intake.",
  ],
  PREDECESSOR_REQUEST_REQUIRED: [
    "Un Resultado materialmente distinto necesita la identidad de su solicitud anterior.",
    "Indica la solicitud cerrada anterior antes de crear la sucesora.",
  ],
  REQUEST_NOT_FOUND: [
    "No se encontró la solicitud de OIO Local.",
    "Usa el ID devuelto cuando se inició la solicitud.",
  ],
  RESULT_IDENTITY_MISMATCH: [
    "La aceptación no coincide con el entregable actual.",
    "Revisa el resultado actual y acepta su huella SHA-256 exacta.",
  ],
  RESULT_READBACK_FAILED: [
    "El entregable guardado no coincide con su identidad informada.",
    "Conserva la solicitud y repite únicamente el Paso de creación.",
  ],
  SETUP_REQUIRED: [
    "La configuración de OIO Local no está completa para este proyecto.",
    "Ejecuta la configuración y la verificación de salud antes de iniciar una solicitud.",
  ],
  UNAUTHORIZED_EXTERNAL_CLAIM: [
    "El borrador afirma que ya ocurrió una acción externa no autorizada.",
    "Revisa el borrador para pedir verificación y autorización humana.",
  ],
  UNSUPPORTED_CHILD_MODEL: [
    "El perfil de modelo secundario no está admitido.",
    "Usa el perfil preferido o una alternativa admitida con autorización explícita.",
  ],
  VERSION_AUTHORIZATION_REQUIRED: [
    "La versión posterior propuesta no está autorizada para esta solicitud.",
    "Conserva el último V0 probado o solicita autorización humana explícita.",
  ],
};

export function localizeJourneyHold(error, language = "en") {
  if (language !== "es") {
    return { message: error.message, recoveryAction: error.recoveryAction };
  }
  const translated = spanishHolds[error.code];
  if (translated) return { message: translated[0], recoveryAction: translated[1] };
  return {
    message: "OIO Local detuvo esta transición para preservar el Resultado aprobado.",
    recoveryAction: "Corrige la causa indicada por el código y vuelve a intentar solo esta transición.",
  };
}
