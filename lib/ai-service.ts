
"use client"

export interface IntentAnalysis {
  type: "search_tracks" | "search_artists" | "search_playlists" | "get_recommendations" | "general"
  query: string
  confidence: number
}

export type ChatIntent =
  | 'gmail'
  | 'google_services'
  | 'web_search'
  | 'image'
  | 'video'
  | 'ppt'
  | 'figma'
  | 'plan'
  | 'math'
  | 'viz'
  | 'doc'
  | 'artifact'
  | 'chart'
  | 'webdev'
  | 'agent_task'
  | 'text'

export const VALID_CHAT_INTENTS: ChatIntent[] = [
  'gmail',
  'google_services',
  'web_search',
  'image',
  'video',
  'ppt',
  'figma',
  'plan',
  'math',
  'viz',
  'doc',
  'artifact',
  'chart',
  'webdev',
  'agent_task',
  'text',
]

const normalizePrompt = (prompt: string) =>
  (prompt || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const ROUTING_PATTERNS = {
  gmail: /\b(gmail|e-?mail|correo(s)?|mail|inbox|bandeja de entrada|redacta(r)? (un )?correo|envia(r)? (un )?correo|responde(r)? (un )?correo|lee(r)? (mis )?correos)\b/i,
  googleServices: /\b(google (calendar|calendario|drive)|calendar|calendario|evento|event|meeting|reunion|agenda|drive|carpeta|folder)\b/i,
  externalResearch: /\b(investiga(r|cion)?|investigate|research|busca(r)?|find|recopila(r)?|fuentes|citas|referencias|articulos?|papers?|literatura|academicos?|cientificos?|mercado|benchmark|competidores|estado del arte|revision sistematica|metaanalisis|meta analisis|scielo|redalyc|dialnet|openalex|crossref|pubmed|doi|semantic scholar|doaj|scopus)\b/i,
  deliverableFile: /\b(docx|xlsx|pptx|word|excel|power\s*point|powerpoint|pdf\b|informe|reporte|presentacion|diapositivas|slides|hoja de calculo|spreadsheet|archivo|documento|matriz narrativa|matriz de consistencia|base de datos)\b/i,
  dataWork: /\b(calcula(r)?|analiza(r)?|procesa(r)?|limpia(r)?|extrae(r)?|clasifica(r)?|regresion|estadistica|csv|datos|dataset|cronbach|spearman|anova|correlacion|likert)\b/i,
  codeWork: /\b(codigo|code|programa|script|web|website|landing|sitio|frontend|backend|debug|bug|corrige(r)?|prueba(s)?|test(s)?|autocorrige(r)?|auto corrige(r)?|revisando y corrigiendo)\b/i,
  longRunningAgent: /\b(2 horas|dos horas|30 minutos|60 minutos|una hora|sin detenerse|sin parar|persistente|background|mientras salgo|aunque cierre|auto.?corrige|autonom(o|a)|verifica(r)?|self.?check|self.?supervision)\b/i,
  architecturePlan: /\b(plano|planos|blueprint|floor[- ]?plan|planta (arquitect|baj|alt)|plano arquitectonico|dxf)\b|\b(casa|vivienda|departamento|oficina)\b.*\b(plano|planta|arquitectonico|distribucion|habitaciones|dormitorios|banos)\b/i,
  artifact: /\b(calculadora (interactiva|de|para|con)|simulador|quiz|cuestionario|widget|componente interactivo|artifact|artefacto|editor (apa|en tiempo real|de citas?)|dashboard (interactivo|con inputs|que (calcul|actualiz|responda))|herramienta (interactiva|para calcular)|interfaz interactiva|visualizador (interactivo|que recalcul)|mapa interactivo|animacion(?:es)?(?: en)? 3d|three\.?js|threejs|modelo 3d|visor 3d|evaluador de ensayos|grader|rubrica interactiva)\b/i,
  math: /\b(integral|integrar|derivada|derivar|d\/dx|ecuacion|cronbach|alpha de cronbach|autovalor|eigenval|matriz (inversa|transpuesta|determinante)|regresion|chi[- ]?cuadrado|anova|t[- ]?test|p[- ]?valor|probabilidad (de|binomial|normal|poisson)|varianza|desviacion estandar|media aritmetica|desviacion tipica|limite cuando|serie de fourier|transformada de laplace|sistema de ecuaciones|factorizar|simplifica (la )?expresion|despejar|funcion (derivada|continua|inversa)|examen de (matematicas|fisica|quimica|estadistica)|problemas de (matematicas|fisica|quimica|estadistica))\b/i,
  doc: /\b(docx|xlsx|pptx|word|excel|power\s*point|powerpoint|pdf\b|informe (apa|word|pdf)|tesis (formato|apa|word)|apa 7|apa septima|plantilla upn|instrumento (bai|phq|gad|whoqol)|bai|whoqol|phq-?9|gad-?7|hoja de calculo|spreadsheet|presentacion( ppt)?|descargar? (un )?(documento|archivo|informe|reporte|pdf|word|excel)|genera(r|me)? (un )?(documento|archivo|informe|reporte|pdf|word|excel|pptx?|docx?)|crea(me)? (un )?(documento|pdf|word|excel|pptx?|docx?|presentacion)|exporta(r|me)? (a|en|como) (pdf|word|excel|docx|xlsx|pptx))\b/i,
  viz: /\b(graficos?|graficas?|plot|plotear|histogram(a|as)?|pareto|ishikawa|fishbone|espina de pescado|box[- ]?plot|diagrama de caja|scatter|dispersion|s[- ]?curve|curva s|earned value|gantt|sankey|treemap|mapa de arbol|heatmap|mapa de calor|flujo de (datos|procesos?)|diagrama (de )?(flujo|er|entidad[- ]relacion|clases?|secuencia|estados?|uml|jerarquia|jornada|journey)|dashboard (de|para|con)|visuali(c|z)a(r|cion)?|torta|pastel|barras apiladas?|mermaid|d3|plotly|recharts|chart\.?js)\b/i,
  image: /\b(imagen|image|photo|foto|picture|drawing|dibujo|logo|ilustracion|render)\b/i,
  video: /\b(video|clip|animacion|movie|veo 3|veo3|sora)\b/i,
  webdev: /\b(website|webpage|pagina web|sitio web|landing page|portfolio|html|css|javascript|react|next\.?js|frontend|web app|tienda online|ecommerce|e-commerce)\b/i,
  webdevBuildAction: /\b(crea(r|me)?|build|make|design|disena(r|me)?|diseña(r|me)?|desarrolla(r)?|programa(r)?|genera(r)?|haz|construye|implementa(r)?|maqueta(r)?)\b/i,
  figma: /\b(figma|wireframe|user flow|design system|diagrama de producto|prototipo navegable)\b/i,
}

export function classifyIntentFastPath(prompt: string): ChatIntent | null {
  const lc = normalizePrompt(prompt)

  if (ROUTING_PATTERNS.gmail.test(lc)) return 'gmail'
  if (ROUTING_PATTERNS.googleServices.test(lc)) return 'google_services'

  const asksForExternalResearch = ROUTING_PATTERNS.externalResearch.test(lc)
  const asksForDeliverableFile = ROUTING_PATTERNS.deliverableFile.test(lc)
  const asksForDataWork = ROUTING_PATTERNS.dataWork.test(lc)
  const asksForCodeWork = ROUTING_PATTERNS.codeWork.test(lc)
  const asksForLongRunningAgent = ROUTING_PATTERNS.longRunningAgent.test(lc)

  if (
    (asksForDeliverableFile && (asksForExternalResearch || asksForDataWork || asksForCodeWork))
    || (asksForLongRunningAgent && (asksForExternalResearch || asksForDeliverableFile || asksForDataWork || asksForCodeWork))
  ) {
    return 'agent_task'
  }

  if (asksForExternalResearch) return 'web_search'
  if (ROUTING_PATTERNS.architecturePlan.test(lc)) return 'plan'
  if (ROUTING_PATTERNS.artifact.test(lc)) return 'artifact'
  if (ROUTING_PATTERNS.math.test(lc)) return 'math'
  if (ROUTING_PATTERNS.doc.test(lc)) return 'doc'
  if (ROUTING_PATTERNS.viz.test(lc)) return 'viz'
  if (ROUTING_PATTERNS.video.test(lc)) return 'video'
  if (ROUTING_PATTERNS.image.test(lc)) return 'image'
  if (ROUTING_PATTERNS.figma.test(lc)) return 'figma'
  if (ROUTING_PATTERNS.webdev.test(lc) && ROUTING_PATTERNS.webdevBuildAction.test(lc)) return 'webdev'

  return null
}

// Enhanced AI Service
export class AIService {
  private apiKey: string = process.env.NEXT_PUBLIC_OPENAI_API_KEY || ""


  async analyzeIntent(prompt: string): Promise<ChatIntent> {
    return classifyIntentFastPath(prompt) || 'text'
  }

  async classifyIntent(
    prompt: string,
    conversationHistory: any[] = [],
    signal?: AbortSignal
  ): Promise<ChatIntent> {

    const deterministicIntent = classifyIntentFastPath(prompt);
    if (deterministicIntent) return deterministicIntent;

    try {

      const messages = [
        {
          role: "system",
          content: `You are an expert at classifying user intent. Analyze the user's prompt (which could be in any language including Roman Urdu, Urdu, English, German, Spanish, etc.) and classify it into exactly one of these categories: 'gmail', 'google_services', 'web_search', 'image', 'video', 'ppt', 'figma', 'plan', 'math', 'viz', 'doc', 'artifact', 'chart', 'webdev', 'agent_task', or 'text'.

- 'gmail': Sending, reading, or managing emails. Examples: "send an email to hamza", "read my last 5 emails", "enviar un correo electrónico".
- 'google_services': Interacting with Google Calendar or Drive. Examples: "show my meetings for tomorrow", "find my marketing presentation on Drive", "mostrar mis eventos del calendario".
- 'web_search': Any request that needs REAL external sources — academic papers, news, facts that could be out of the LLM's training cutoff, or anything where the user explicitly asks for references/citations. Triggers the multi-provider agentic pipeline (Scopus, OpenAlex, SciELO, Semantic Scholar, Crossref, PubMed, DOAJ). Examples:
  * "busca 10 artículos sobre embarazo adolescente" / "dame 20 fuentes sobre alfa de Cronbach"
  * "find papers on gene editing crispr 2024" / "give me sources for systematic review on SMED"
  * "¿quién es el presidente de Francia?" / "who is the president of France?"
  * "what's the latest news on OpenAI?" / "últimas noticias de la NASA"
  * "investiga sobre X" / "investigate X" / "research X"
  * Any question where the user wants citations, a literature scan, or an answer grounded in real web/scholarly sources. If in doubt AND the request asks for information the LLM cannot safely answer from memory, prefer 'web_search' over 'text'.
- 'image': Generating images. Examples: "create an image of a sunset", "genera una imagen de un gato".
- 'video': Generating videos. Examples: "make a video of a beach", "crea un video de la ciudad".
- 'ppt': Creating PowerPoint presentations. Examples in multiple languages:
* English: "create a presentation about AI", "make a PPT on climate change", "generate slides about marketing"
* Roman Urdu: "AI ke bare mein presentation banao", "PPT banao machine learning par", "climate change par slides bana do"
* Urdu: "مصنوعی ذہانت کے بارے میں پریزنٹیشن بنائیں", "پی پی ٹی بناؤ", "سلائیڈز تیار کرو"
* German: "erstelle eine Präsentation über KI", "mach eine PPT zum Klimawandel"
* Spanish: "crea una presentación sobre IA", "haz un PPT sobre el clima"
* French: "crée une présentation sur l'IA", "génère des slides"
- 'chart': Creating charts or graphs. Examples: "create a bar chart", "make a pie graph".
- 'figma': Creating flowcharts, process diagrams,sequence diagrams, class diagrams, state diagrams, ER diagrams, user journey diagrams, git graphs, or design diagrams. Examples: "create a flowchart of login flow", "make a process diagram", "design a workflow".
- 'plan': Creating architectural FLOOR PLANS / blueprints of buildings, houses, apartments, rooms. The output is a CAD/DXF drawing with walls, doors, windows, dimensions. Examples in multiple languages: "crea el plano de una casa", "dibújame un plano arquitectónico", "blueprint for a 3 bedroom house", "planta de un departamento 80 m2", "floor plan of an office", "plano de una vivienda con 2 baños". Do NOT classify generic "house" conversation as 'plan' — only when the user is explicitly asking for a drawing / plano / blueprint / floor plan / planta arquitectónica.
- 'artifact': Building an INTERACTIVE React component that runs live inside the chat (calculator, simulator, quiz, dashboard with inputs, editor with real-time validation, interactive map). The user expects to TYPE / CLICK / DRAG something and see the UI respond. Examples: "calculadora de Cronbach's alpha donde pegue los valores", "simulador SMED con inputs", "quiz con 10 preguntas sobre X", "dashboard de tesis con filtros", "editor de citas APA 7 en tiempo real", "visualizador S-curve EVM que recalcule al cambiar inputs". Only route here when the output is clearly a LIVE, stateful UI — not a static chart (that is 'viz') and not a downloadable document (that is 'doc').
- 'doc': Generating a downloadable document — Word (.docx), Excel (.xlsx), PowerPoint (.pptx), PDF, or SVG. Examples: "dame un informe en Word con...", "genera un Excel con estas columnas", "crea una presentación PowerPoint de defensa de tesis", "exporta a PDF el contrato", "genera un archivo SVG del logo". Only route here when the user clearly wants a FILE they can download (keywords: word, excel, pptx, docx, pdf, hoja de cálculo, presentación, informe, exportar).
- 'viz': Building a chart, plot, or technical diagram. Covers S-curve Earned Value charts, Pareto diagrams, Ishikawa fishbone diagrams, histograms, scatter + regression, box plots, interactive dashboards, heatmaps, sankey, treemaps, flowcharts, ER diagrams, UML class/sequence/state diagrams, Gantt charts, user-journey diagrams. Examples: "dibuja un diagrama de Pareto con estos datos", "plot a histogram of weights", "interactive scatter with hover", "flowchart del proceso de onboarding", "diagrama ER de un e-commerce", "Gantt de 5 fases del proyecto", "S-curve de Earned Value". If the user wants to SEE data rendered as a picture / plot / diagram → 'viz'. If they want to COMPUTE a statistic → 'math'.
- 'math': Solving a mathematics, statistics, or quantitative-science problem that benefits from LaTeX formulas and (optionally) numerical Python execution. Examples: "resuelve la integral de x^2·sin(x) dx por partes", "calcula el Cronbach's alpha de [...]", "autovalores de la matriz [[2,1],[1,3]]", "probabilidad binomial n=10 p=0.3 k=4", "derivada parcial de x^2·y respecto a y", "solve the system 2x + 3y = 12, x - y = 1", "factoriza x^3 - 6x^2 + 11x - 6", "limite cuando x->0 de sin(x)/x". Generic "what is 2+2" stays 'text'. Only route to 'math' when the problem has symbolic or numerical content worth showing with LaTeX or running Python on.
- 'webdev': Building websites or UI components. Examples: "build a login page", "create a React component".
- 'agent_task': Multi-step compound tasks that require BOTH research AND building a deliverable file (Excel/Word/PPT/PDF) AND running code. The task agent will plan, search the web, write Python, generate the document, and self-verify before delivering. Use this when the user asks for things like:
  * "busca 30 artículos sobre X y mételos en un Excel" / "find 30 papers on X and put them in an Excel"
  * "investiga sobre Y y dame un informe Word con citas APA" / "research Y and give me a Word report with APA citations"
  * "crea un PPT con los datos del CSV adjunto" / "build a PPT from the attached CSV"
  * "calcula la regresión lineal de estos datos y entrega un PDF con la gráfica"
  * Anything that combines: search → process → produce file. Single-deliverable requests like "just create an empty Word doc" stay in 'doc'; pure data analysis without a deliverable file stays in 'math' or 'viz'.
- 'text': For all other general conversation, questions, and text generation.
  This includes structured text outputs such as tables, dummy data, formatted lists, or code-generated textual data.
  If the user asks to create a "table", "list", "dataset", or "dummy data" without explicitly mentioning charts, slides, or presentations, classify as 'text'.

IMPORTANT:
- Classify by the action the user expects, not only by keywords.
- Only classify as 'webdev' when the user wants a website, landing page, web app, or UI built. Code debugging, code review, or explanations stay 'text' unless the user asks for autonomous repair plus deliverables, which is 'agent_task'.
- If the user asks for a specific programming language (Python, JavaScript, HTML), inspect whether they want a UI. If not, classify as 'text'.
- If the user asks for a downloadable Word/Excel/PDF/PPTX, classify as 'doc' unless the request also needs external research, data processing, or long-running self-verification, which is 'agent_task'.
- If the user asks for a live calculator, simulator, quiz, dashboard with inputs, editor, 3D viewer, or persistent in-chat tool, classify as 'artifact'.
- If a request explicitly needs real citations, current facts, market data, scientific papers, or source verification, prefer 'web_search' over 'text'.

Examples:
- "Design a dark mode developer portfolio" → 'webdev' (web development)
 
- "Build a landing page" → 'webdev' (web development)
- "Make me a website for my business" → 'webdev' (web development)
- "Create HTML/CSS for a login form" → 'webdev' (web development)
- "encuentra mi presentación de marketing del último trimestre en Drive" → 'google_services'
- "Generate an image of a cat" → 'image' (visual content)
- "Create a logo design" → 'image' (visual design)
- "Make a video of sunset" → 'video' (video content)
- "Explain how React works" → 'text' (explanation)
- "What is JavaScript?" → 'text' (question)
- "Create a Word document with APA 7 structure" → 'doc'
- "Research 30 papers and put them in Excel" → 'agent_task'
Respond with only one word.

`,
        }
      ];

      if (Array.isArray(conversationHistory) && conversationHistory.length > 0) {
        const recentMessages = conversationHistory.slice(-2);
        for (const msg of recentMessages) {
          const role = msg.role === "USER" ? "user" : "assistant";
          const textPart = Array.isArray(msg.content)
            ? msg.content.find((c: any) => c.type === "text")?.text || ""
            : msg.content;
          messages.push({ role, content: textPart });
        }
      }

      // ✅ Finally add the new user prompt
      messages.push({ role: "user", content: prompt });

      // const response = await fetch("https://api.openai.com/v1/chat/completions", {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api'}/proxy/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-3.5-turbo",
            messages,
          }),
          // Allow caller to abort the request (used by Stop button)
          signal,
        }
      );

      if (!response.ok) throw new Error(`API error: ${response.statusText}`);
      const data = await response.json();
      const intent = data.choices[0].message.content.toLowerCase().trim();
      console.log('intent FROM OPEN AI', intent);

      if (VALID_CHAT_INTENTS.includes(intent as ChatIntent)) {
        return intent as ChatIntent;
      }
      return 'text'; // Default fallback
    } catch (error: any) {
      // If this was explicitly aborted (e.g. user pressed Stop), don't try to
      // recover or return any fallback intent. Let caller decide what to do.
      if (error?.name === 'AbortError') {
        throw error;
      }

      console.error("Intent classification failed:", error);
      const fallbackIntent = await this.analyzeIntent(prompt);
      return fallbackIntent || 'text';
    }
  }
}

export const aiService = new AIService()
