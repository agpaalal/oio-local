# OIO Local

OIO Local ayuda a una persona no desarrolladora a convertir una solicitud en
lenguaje cotidiano en un resultado pequeño, funcional y comprobado localmente
con Codex o Claude Code. Mantiene el resultado aprobado por encima de las
preferencias de implementación y funciona en inglés y español.

OIO Local es independiente de OIO Business. No incluye multitenencia,
operaciones alojadas, administración organizacional ni el runtime en la nube de
OIO Business.

## Qué incluye V0

- descubrimiento guiado del resultado y aprobación Humana exacta;
- artefactos de revisión Will / Will Not y de especificación;
- tickets internos y definiciones de pasos;
- ejecución local mediante Codex o Claude Code;
- registros de solicitudes en SQLite;
- acceso a secretos mediante Doppler, sin archivos de entorno del proyecto;
- copias de seguridad, restauración, diagnóstico y desinstalación segura;
- recorridos de usuario en inglés y español;
- copias fijadas y atribuidas de habilidades seleccionadas de Matt Pocock.

## Requisitos

- macOS;
- Node.js 22.5 o posterior;
- Codex CLI 0.149.1 o posterior, o Claude Code;
- Doppler CLI para solicitudes que necesiten secretos;
- Git para instalar desde este repositorio.

## Instalación controlada

Hasta que exista el instalador público guiado, clona este repositorio y guarda
el estado actual del harness antes de registrar el plugin. Esa captura permite
una desinstalación y restauración verificables.

Sigue los comandos de [README.md](README.md) y usa `--language es` durante la
configuración. Conserva la captura previa hasta completar la desinstalación.

En Codex, inicia OIO Local con `$oio-local:oio-local`. En Claude Code, usa
`/oio-local:oio-local`.

## Desarrollo

```bash
npm ci
npm test
```

La calificación nativa completa ejecuta ambos harnesses en ambos idiomas y
puede consumir créditos de modelos:

```bash
npm run qualify
```

## Atribución

Las habilidades seleccionadas se derivan de
[`mattpocock/skills`](https://github.com/mattpocock/skills) bajo la licencia
MIT. Las identidades, huellas, modificaciones y licencias exactas están en
[`plugins/oio-local/compatibility/skills.json`](plugins/oio-local/compatibility/skills.json)
y [`plugins/oio-local/THIRD_PARTY_NOTICES`](plugins/oio-local/THIRD_PARTY_NOTICES).

## Licencia

OIO Local se publica bajo la [licencia MIT](LICENSE). Los materiales de
terceros incluidos conservan sus licencias y avisos de origen documentados.
