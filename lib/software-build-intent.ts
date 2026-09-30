/**
 * Frontend mirror of backend/src/services/agents/software-build-intent.js.
 * Keep the regexes in lockstep: website/app/software asks must not fall
 * through to the Document Sandbox Word path.
 */

function normalize(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const CREATE_RE = /\b(crea(?:r|me)?|haz(?:me)?|genera(?:r|me)?|desarrolla(?:r|me)?|programa(?:r|me)?|construye(?:r|me)?|implementa(?:r|me)?|disena(?:r|me)?|maqueta(?:r|me)?|arma(?:r|me)?|build|make|develop|quiero|necesito)\b/

const SOFTWARE_NOUN_RE = /\b(sitio web|pagina web|website|webpage|landing page|landing|web app|aplicacion web|aplicacion|ecommerce|e-commerce|tienda online|saas|software|app|(?:una|un|mi)\s+web|web\s+(?:de|para|app|con)|pagina(?:\s+(?:de|para))\s+\w+)\b/

const OFFICE_FORMAT_RE = /\b(word|docx|pdf|excel|xlsx|pptx?|powerpoint|power\s*point)\b/

const DOCUMENT_NOUN_RE = /\b(informe|ensayo|reporte|tesis|monografia|brochure|folleto|propuesta|contrato|manual|documento|presentacion|diapositivas?|copy)\b/

const COPY_OR_DATA_RE = /\b(datos de ventas|copy de ventas|analisis de ventas|tabla de ventas|cifras de ventas|copy\b.{0,40}\bbrochure|copy\b.{0,40}\bfolleto)\b/

const DIAGRAM_RE = /\b(diagrama|mermaid|organigrama|grafico|grafica|chart|uml|swot|foda|mapa mental)\b/

const STACK_DELIVERABLE_RE = /\b(app web|web app|sitio web|pagina web|landing|e-?commerce|tienda online)\b/
const STACK_HINT_RE = /\b(next\.?js|react|tailwind|html|css|javascript|typescript|vite)\b/

export function isCopyOrDataAsk(text: string): boolean {
  return COPY_OR_DATA_RE.test(normalize(text))
}

export function isExplicitDocumentRequest(text: string): boolean {
  const n = normalize(text)
  if (!n) return false
  if (/\b(?:en|como|a|formato)\s+(?:un\s+|una\s+|el\s+|la\s+)?(?:word|docx|pdf|excel|xlsx|pptx?|powerpoint|documento\s+word)\b/.test(n)) {
    return true
  }
  if (OFFICE_FORMAT_RE.test(n) && (CREATE_RE.test(n) || DOCUMENT_NOUN_RE.test(n))) {
    return true
  }
  if (CREATE_RE.test(n) && DOCUMENT_NOUN_RE.test(n) && !SOFTWARE_NOUN_RE.test(n)) {
    return true
  }
  return false
}

export function isSoftwareBuildRequest(text: string): boolean {
  const n = normalize(text)
  if (!n) return false
  if (isCopyOrDataAsk(n)) return false
  if (DIAGRAM_RE.test(n)) return false
  if (isExplicitDocumentRequest(n)) return false
  if (CREATE_RE.test(n) && SOFTWARE_NOUN_RE.test(n)) return true
  return STACK_DELIVERABLE_RE.test(n) && STACK_HINT_RE.test(n)
}

export type CodingIntent = { active: boolean; kind: "create" | "repository" | "edit" | "review" | "followup" | null; projectName: string | null; repositoryUrl: string | null };


// A clear software task starts in the chat itself. This is turn intent, not
// authorization: the server still verifies account, chat and project ownership.
const CODE_ACTION_RE = /\b(?:crea(?:r|me|nos)?|crees|haz(?:me)?|hagas|genera(?:r|me)?|desarrolla(?:r|me)?|desarrolles|construye|construyas|implementa(?:r)?|implementes|programa(?:r)?|corrige|corregir|arregla(?:r)?|repara(?:r)?|edita(?:r)?|modifica(?:r)?|cambia(?:r)?|refactoriza(?:r)?|optimiza(?:r)?|anade|agrega|depura(?:r)?|revisa(?:r)?|verifica(?:r)?|analiza(?:r)?|prueba(?:r)?|ejecuta(?:r)?|clona(?:r)?|abre|abrir|build|create|make|develop|fix|debug|review|inspect|test|refactor|update|implement|clone|open)\b/;
const CODE_CONTEXT_RE = /\b(?:codigo|source code|codebase|repositorio|repo|github|software|sofware|aplicacion|app|web|website|backend|frontend|fullstack|full stack|api|endpoint|script|funcion|function|componente|component|programa|javascript|typescript|python|react|next\.?js|vue|svelte|django|flask|rust|golang|java|c\+\+)\b/;
const SENSITIVE_PROJECT_LABEL_RE = /\b(?:sk[-_]|rk_(?:live|test)_|pk_(?:live|test)_|gh[pousr]_|github_pat_|xox[abprs]-|AKIA|ASIA|AIza|Bearer\s|Basic\s|eyJ[\w-]{8,}\.|BEGIN\s+(?:RSA\s+|OPENSSH\s+)?PRIVATE\s+KEY)|[a-z]+:\/\/[^\s/@]+:[^\s/@]+@/i;
const CODE_CREATE_RE = /\b(?:crea(?:r|me|nos)?|crees|genera(?:r|me)?|haz(?:me)?|desarrolla(?:r|me)?|programa(?:r|me)?|construye|build|create|make|develop)\b/;
const SOURCE_FILE_RE = /\b[\w.-]+\.(?:[cm]?[jt]sx?|py|rb|rs|go|java|kt|swift|c|cpp|cs|h|html|css|scss|sql|sh)\b/;
const NON_SOFTWARE_CODE_RE = /\b(?:codigo|code)\s+(?:qr|postal|de\s+(?:verificacion|seguridad|acceso|descuento|seguimiento|activacion|barras|whatsapp))\b/;
const CODE_FOLLOWUP_RE = /\b(?:continua|continuar|sigue|prosigue|arregla|corrige|cambia|anade|agrega|quita|elimina|modifica|actualiza|hazlo|prueba|ejecuta|implementa|refactoriza|optimiza|revisa|verifica|instala|configura|publica|despliega|deploy|fix|update|continue|run|test|add|remove)\b/;
const WORKSPACE_EDIT_ACTION_RE = /\b(?:pon(?:le|me)?|anade(?:le|lo|la|los|las)|agrega(?:le|lo|la|los|las)|conecta|integra|haz)\b/;
const WORKSPACE_EDIT_TARGET_RE = /\b(?:fondo|colores?|diseno|interfaz|botones?|pantallas?|carrito|login|inicio de sesion|base de datos|autenticacion|registro|menu|navegacion|formularios?)\b/;
const WORKSPACE_APPEARANCE_RE = /^(?:(?:por favor|ahora)\s+)*(?:(?:quiero|necesito)\s+)?que\s+(?:se\s+vea|luzca|sea)\s+(?:(?:un\s+poco\s+)?mas\s+)?(?:modern[oa]|limpi[oa]|minimalista|elegante|profesional|clar[oa]|oscur[oa]|azul|rojo|verde|blanco|negro)\b/;
const EXPLANATION_ONLY_RE = /^(?:(?:por favor|quiero saber|necesito saber|dime)\s+)*(?:explica(?:me)?|ensena(?:me)?|que es|que significa|como (?:se |puedo |puede |funciona|crear|programar)|how (?:to|does)|what (?:is|does)|tutorial|pasos para)\b/;
const NEGATED_CODE_RE = /\b(?:no\s+(?:(?:quiero|necesito)\s+que\s+)?(?:crees|hagas|edites|modifiques|cambies|programes|construyas|pongas|conectes|integres|anadas|agregues)|(?:do not|don't)\s+(?:create|build|edit|modify|change))\b/;
const WORKSPACE_REUSE_CONSTRAINT_RE = /\b(?:no\s+(?:(?:quiero|necesito)\s+que\s+)?(?:crees|hagas|construyas)\s+(?:otro|un\s+nuevo)\s+proyecto|(?:do not|don't)\s+(?:create|build)\s+(?:another|a\s+new)\s+project)\b/g;

function stripFencedCode(text: string): string {
  return text.replace(/(`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*?(?:\1|$)/g, ' ');
}

export function chatGithubRepository(text: string): string | null {
  const raw = stripFencedCode(String(text || ''));
  const url = /(?:^|[\s(<"'])(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9._-]{0,38})\/([A-Za-z0-9._-]{1,100})/i.exec(raw);
  const named = url || /\b(?:repo(?:sitorio)?|github|pr\s+en|pull request\s+en)\s+(?:de\s+|en\s+)?([A-Za-z0-9][A-Za-z0-9_-]{0,38})\/([A-Za-z0-9._-]{1,100})/i.exec(raw);
  if (!named) return null;
  const owner = named[1];
  const repo = named[2].replace(/\.git$/i, '').replace(/[.,]+$/, '');
  if (!repo || owner.includes('..') || repo.includes('..') || /^(?:settings|login|signup|features|topics)$/i.test(owner)) return null;
  return `https://github.com/${owner}/${repo}`;
}

export function codingProjectName(text: string, repositoryUrl: string | null = null): string {
  const raw = String(text || '');
  if (SENSITIVE_PROJECT_LABEL_RE.test(raw) || SENSITIVE_PROJECT_LABEL_RE.test(repositoryUrl || '')) return 'Proyecto de código';
  if (repositoryUrl) return repositoryUrl.split('/').slice(-2).join('/').slice(0, 80);
  // A label, never an excerpt containing source code, URLs or credentials.
  const safe = String(text || '').split(/```/)[0]
    .replace(/https?:\/\/\S+|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, '')
    .split(/\b(?:api[_ -]?key|token|password|secret|clave|contrasena|contraseña)\b/i)[0]
    .replace(/[\r\n]+/g, ' ').trim();
  const named = /\b(?:llamad[ao]|nombre|named|called)\s+["“']([^"”'\n]{1,64})["”']/i.exec(safe);
  const product = /\b(?:sitio web|p[aá]gina web|web app|app web|aplicaci[oó]n web|tienda online|landing page|landing|e-?commerce|software|aplicaci[oó]n|app|web|api|script)\b(?:\s+(?:de|para)\s+[^,;.!?:]{1,65})?/i.exec(safe);
  const candidate = (named?.[1] || product?.[0] || 'Proyecto de código')
    .split(/\s+(?:con|usando|utilizando|que|y\s+(?:crea|genera|necesito|quiero|backend|frontend))\b/i)[0]
    .replace(/[<>\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return candidate ? candidate[0].toUpperCase() + candidate.slice(1) : 'Proyecto de código';
}

export function detectCodingIntent(text: string, options: { hasWorkspace?: boolean; hasAttachments?: boolean; modality?: string | null } = {}): CodingIntent {
  const none: CodingIntent = { active: false, kind: null, projectName: null, repositoryUrl: null };
  const raw = String(text || '');
  const hasInlineCode = /```(?:javascript|typescript|jsx|tsx|js|ts|python|py|ruby|rb|rust|rs|golang|go|java|kotlin|kt|swift|c|cpp|csharp|cs|php|html|css|scss|sql|bash|sh|shell|json|yaml|yml)\s*\r?\n[\s\S]*?```/i.test(raw);
  // Source-code comments and strings are task data, never routing instructions.
  const normalizedPrompt = normalize(stripFencedCode(raw));
  const n = options.hasWorkspace ? normalizedPrompt.replace(WORKSPACE_REUSE_CONSTRAINT_RE, ' ').trim() : normalizedPrompt;
  if (!n || options.modality) return none;
  // Greetings, instructions about documents and explicit educational asks
  // never create a cloud project, including inside an existing coding chat.
  if (/^(?:hola|hi|hey|hello|buenas(?: tardes| noches)?|buenos dias|ok(?:ay|ey)?|vale|gracias|thanks|si|no|adios|bye|chao|perfecto|dale|listo|de nada|yes|yeah)[\s.!?¡¿,;:👍🙏😊]*$/.test(n)) return none;
  if (/\b(?:api[ _-]?key|clave de api|token de acceso|contrasena)\b/.test(n) && !/\b(?:app|aplicacion|software|web|backend|frontend|codigo|repositorio|script)\b/.test(n) && !options.hasWorkspace) return none;
  if (EXPLANATION_ONLY_RE.test(n) || NEGATED_CODE_RE.test(n) || NON_SOFTWARE_CODE_RE.test(n)) return none;
  const buildsDocumentSoftware = /\b(?:app|aplicacion|software|web)\s+(?:para|que)\b/.test(n) && CODE_ACTION_RE.test(n);
  const targetsSoftware = /\b(?:app|aplicacion|software|sofware|backend|frontend|web|script|codigo|repositorio|api)\b/.test(n) && CODE_ACTION_RE.test(n);
  if ((isExplicitDocumentRequest(n) && !buildsDocumentSoftware) || (DIAGRAM_RE.test(n) && !targetsSoftware) || isCopyOrDataAsk(n)) return none;
  if (DOCUMENT_NOUN_RE.test(n) && !targetsSoftware) return none;
  if (/\b(?:crea|genera|hazme)\b\s+(?:(?:una?|la|el)\s+)?(?:imagen|video|musica|cancion|audio|voz)\b/.test(n)) return none;
  const repositoryUrl = chatGithubRepository(text);
  const action = CODE_ACTION_RE.test(n);
  const repoAsk = /\b(?:repo(?:sitorio)?|github|pull request|pr)\b/.test(n);
  const codeAsk = CODE_CONTEXT_RE.test(n) || SOURCE_FILE_RE.test(n) || hasInlineCode;
  let kind: CodingIntent["kind"] = null;
  if (action && (repositoryUrl || repoAsk)) kind = 'repository';
  else if (isSoftwareBuildRequest(n) || (buildsDocumentSoftware && action) || (CODE_CREATE_RE.test(n) && codeAsk)) kind = 'create';
  else if (action && codeAsk) kind = /\b(?:revisa|revisar|verifica|verificar|analiza|analizar|review|inspect)\b/.test(n) ? 'review' : 'edit';
  else if (options.hasWorkspace && !options.hasAttachments && (CODE_FOLLOWUP_RE.test(n)
    || (WORKSPACE_EDIT_ACTION_RE.test(n) && WORKSPACE_EDIT_TARGET_RE.test(n))
    || WORKSPACE_APPEARANCE_RE.test(n))) kind = 'followup';
  if (!kind) return none;
  return { active: true, kind, projectName: codingProjectName(text, repositoryUrl), repositoryUrl };
}
