
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

// Enhanced AI Service
export class AIService {
  private apiKey: string = process.env.NEXT_PUBLIC_OPENAI_API_KEY || ""


  //   async classifyIntent(prompt: string, conversationHistory: any[] = []): Promise<string> {
  //     const apiKey = process.env.NEXT_PUBLIC_OPENAI_API_KEY;
  //     if (!apiKey) {
  //       console.error("OpenAI API key not found for intent classification.");
  //       // Fallback to basic keyword matching
  //       const lowerCasePrompt = prompt.toLowerCase();
  //       if (/\b(gmail|email|mail|send to|compose)\b/i.test(lowerCasePrompt)) return 'gmail';
  //       if (/\b(calendar|event|meeting|schedule|drive|file|document|folder)\b/i.test(lowerCasePrompt)) return 'google_services';
  //       if (/\b(search|find|who is|what is|when is|tell me about)\b/i.test(lowerCasePrompt)) return 'web_search';
  //       if (/\b(image|photo|picture|drawing|logo)\b/i.test(lowerCasePrompt)) return 'image';
  //       if (/\b(video|clip|animation|movie)\b/i.test(lowerCasePrompt)) return 'video';
  //       if (/\b(ppt|presentation|slides)\b/i.test(lowerCasePrompt)) return 'ppt';
  //       if (/\b(chart|graph|diagram)\b/i.test(lowerCasePrompt)) return 'chart';
  //       if (/\b(website|webpage|html|css|javascript)\b/i.test(lowerCasePrompt)) return 'webdev';
  //       return 'text';
  //     }

  //     const history = conversationHistory
  //       .slice(-10) // Get the last 10 messages
  //       .map(msg => `${msg.role}: ${msg.content}`)
  //       .join('\n');

  //     try {
  //       const response = await fetch("https://api.openai.com/v1/chat/completions", {
  //         method: "POST",
  //         headers: {
  //           "Content-Type": "application/json",
  //           "Authorization": `Bearer ${apiKey}`
  //         },
  //         body: JSON.stringify({
  //           model: "gpt-3.5-turbo",
  //           messages: [
  //             {
  //               role: "system",
  //               content: `You are an expert at classifying user intent. Analyze the user's prompt (which could be in any language including Roman Urdu, Urdu, English, German, Spanish, etc.) and classify it into one of these categories: 'gmail', 'google_services', 'web_search', 'image', 'video', 'ppt', 'chart', 'webdev', or 'text'.

  // - 'gmail': Sending, reading, or managing emails. Examples: "send an email to hamza", "read my last 5 emails", "enviar un correo electrónico".
  // - 'google_services': Interacting with Google Calendar or Drive. Examples: "show my meetings for tomorrow", "find my marketing presentation on Drive", "mostrar mis eventos del calendario".
  // - 'web_search': Finding information on the internet. Examples: "who is the president of France?", "what is the weather today?", "¿quién es el presidente de Francia?".
  // - 'image': Generating images. Examples: "create an image of a sunset", "genera una imagen de un gato".
  // - 'video': Generating videos. Examples: "make a video of a beach", "crea un video de la ciudad".
  // - 'ppt': Creating PowerPoint presentations. Examples in multiple languages:
  //   * English: "create a presentation about AI", "make a PPT on climate change", "generate slides about marketing"
  //   * Roman Urdu: "AI ke bare mein presentation banao", "PPT banao machine learning par", "climate change par slides bana do"
  //   * Urdu: "مصنوعی ذہانت کے بارے میں پریزنٹیشن بنائیں", "پی پی ٹی بناؤ", "سلائیڈز تیار کرو"
  //   * German: "erstelle eine Präsentation über KI", "mach eine PPT zum Klimawandel"
  //   * Spanish: "crea una presentación sobre IA", "haz un PPT sobre el clima"
  //   * French: "crée une présentation sur l'IA", "génère des slides"
  // - 'chart': Creating charts or graphs. Examples: "create a bar chart", "make a pie graph".
  // - 'webdev': Building websites or UI components. Examples: "build a login page", "create a React component".
  // - 'text': For all other general conversation, questions, and text generation.


  // IMPORTANT: 
  //     - Consider the conversation history for context. A simple "yes" might mean "yes, create the website we just discussed."
  //     - - Only classify as 'webdev' if the user is **creating** or **building** a UI or web page. If the request involves **debugging**, **explaining**, or **reviewing code**, classify it as 'text'.
  //     - If the user asks for **specific languages** (e.g., "HTML", "React", "CSS"), check if the request is related to **building** a UI. If yes, classify as 'webdev'.
  //     - If the user is asking for a general explanation of something (e.g., "What is React?"), classify as 'text'.
  //    analyze with the intent of so that easy to understand intent what user talk about Conversation History:\n${history}
  // Respond with only one word.`,
  //             },
  //             { role: "user", content: prompt },
  //           ],
  //           temperature: 0.2,
  //         }),
  //       });

  //       if (!response.ok) throw new Error(`API error: ${response.statusText}`);
  //       const data = await response.json();
  //       const intent = data.choices[0].message.content.toLowerCase().trim();
  //       console.log('intent FROM OPEN AI', intent);

  //       const validIntents = ['gmail', 'google_services', 'web_search', 'image', 'video', 'ppt', 'chart', 'webdev', 'text'];
  //       if (validIntents.includes(intent)) {
  //         return intent;
  //       }
  //       return 'text'; // Default fallback
  //     } catch (error) {
  //       console.error("Intent classification failed:", error);
  //       return 'text'; // Default on error
  //     }
  //   }


  async analyzeIntent(prompt: string): Promise<ChatIntent> {

    console.error("Dummy Intent.");
    // Fallback to basic keyword matching
    const lowerCasePrompt = prompt.toLowerCase();
    if (/\b(gmail|email|mail|send to|compose)\b/i.test(lowerCasePrompt)) return 'gmail';
    if (/\b(calendar|event|meeting|schedule|drive|file|document|folder)\b/i.test(lowerCasePrompt)) return 'google_services';
    if (/\b(search|find|who is|what is|when is|tell me about)\b/i.test(lowerCasePrompt)) return 'web_search';
    if (/\b(image|photo|picture|drawing|logo)\b/i.test(lowerCasePrompt)) return 'image';
    if (/\b(video|clip|animation|movie)\b/i.test(lowerCasePrompt)) return 'video';
    if (/\b(ppt|presentation|slides)\b/i.test(lowerCasePrompt)) return 'ppt';
    if (/\b(chart|graph|diagram)\b/i.test(lowerCasePrompt)) return 'chart';
    if (/\b(flowchart|flow chart|flow diagram|process flow|workflow|figma|diagram design)\b/i.test(lowerCasePrompt)) return 'figma';
    if (/\b(plano|planta|blueprint|floor ?plan|arquitect|casa|vivienda|residencia|depto|departamento|dormitorio|dxf|arquitectónico)\b/i.test(lowerCasePrompt)) return 'plan';
    if (/\b(website|webpage|html|css|javascript)\b/i.test(lowerCasePrompt)) return 'webdev';
    return 'text';

  }

  async classifyIntent(
    prompt: string,
    conversationHistory: any[] = [],
    signal?: AbortSignal
  ): Promise<ChatIntent> {

    // Fast-path: unambiguous architectural-plan phrases bypass the
    // LLM classifier. Before this, "crea un plano de una casa" was
    // landing in 'webdev' because the classifier saw "crea" and
    // concluded the user wanted a UI page. A deterministic regex on
    // the specific word "plano" / "planta" / "blueprint" removes
    // that ambiguity entirely and saves ~1.5s per message.
    const lc = prompt.toLowerCase();
    const isGmailCommand = /\b(gmail|e-?mail|correo(s)?|mail|inbox|bandeja\s+de\s+entrada|redacta(r)?\s+(un\s+)?correo|env[ií]a(r)?\s+(un\s+)?correo)\b/i.test(lc);
    const isGoogleServicesCommand = /\b(google\s+(calendar|calendario|drive)|calendar|calendario|evento|event|meeting|reuni[oó]n|agenda|drive|carpeta|folder)\b/i.test(lc);
    if (isGmailCommand) return 'gmail';
    if (isGoogleServicesCommand) return 'google_services';

    // Compound agentic task — route BEFORE the document fast-path.
    // A prompt like "investiga X y dame un Word/Excel/PPT" is not a
    // simple file-generation request: it needs search, processing,
    // self-checking, and then a deliverable artifact.
    const asksForExternalResearch = /\b(investiga(r|ci[oó]n)?|investigate|research|busca(r)?|find|recopila(r)?|fuentes|citas|referencias|art[ií]culos?|papers?|literatura|acad[eé]mic[ao]s?|cient[ií]fic[ao]s?|mercado|benchmark|competidores|estado\s+del\s+arte)\b/i.test(lc);
    const asksForDeliverableFile = /\b(docx|xlsx|pptx|word|excel|power\s*point|powerpoint|pdf\b|informe|reporte|presentaci[oó]n|hoja\s+de\s+c[aá]lculo|spreadsheet|archivo|documento)\b/i.test(lc);
    const asksForDataWork = /\b(calcula(r)?|analiza(r)?|procesa(r)?|limpia(r)?|extrae(r)?|clasifica(r)?|resume(n|ir)?|tabla|matriz|gr[aá]fic[ao]|regresi[oó]n|estad[ií]stic[ao]|csv|datos|dataset)\b/i.test(lc);
    if (asksForDeliverableFile && (asksForExternalResearch || asksForDataWork)) {
      return 'agent_task';
    }
    if (asksForExternalResearch && /\b(investiga(r|ci[oó]n)?|investigate|research|busca(r)?|find|recopila(r)?|fuentes|citas|referencias|art[ií]culos?|papers?|literatura|acad[eé]mic[ao]s?|cient[ií]fic[ao]s?|mercado|benchmark|competidores|estado\s+del\s+arte|scielo|redalyc|dialnet|openalex|crossref|pubmed|doi)\b/i.test(lc)) {
      return 'web_search';
    }

    if (/\b(plano|planos|blueprint|floor[- ]?plan|planta\s+(arquitect|baj|alt))\b/i.test(lc)) {
      return 'plan';
    }
    // Artifact intent — interactive React component rendered live in
    // the chat (calculators, simulators, quizzes, dashboards with
    // inputs, editors with live validation). It must run before math
    // so "calculadora interactiva de Cronbach" becomes a live tool,
    // not a one-off statistical answer.
    if (/\b(calculadora\s+(interactiva|de|para|con)|simulador|quiz|cuestionario|widget|componente\s+interactivo|editor\s+(apa|en\s+tiempo\s+real|de\s+citas?)|dashboard\s+(interactivo|con\s+inputs|que\s+(calcul|actualiz|responda))|herramienta\s+(interactiva|para\s+calcular)|interfaz\s+interactiva|visualizador\s+(interactivo|que\s+recalcul)|mapa\s+interactivo|animaci[oó]n\s+3d|three\.?js|threejs|modelo\s+3d|visor\s+3d|evaluador\s+de\s+ensayos|grader|r[uú]brica\s+interactiva)\b/i.test(lc)) {
      return 'artifact';
    }
    // Same idea for math/science. Keywords that should never be
    // anything but 'math' — integrals, derivatives, statistics
    // helpers. The classifier LLM sometimes routes "calcula el
    // cronbach's alpha" to 'text', which skips the solver.
    if (/\b(integral|integrar|derivada|derivar|d\/dx|ecuaci[oó]n|resuelve(\s+la|\s+el)?|calcul[ae](\s+la|\s+el)?|cronbach|alpha\s+de\s+cronbach|autovalor|eigenval|matriz\s+(inversa|transpuesta|determinante)|regresi[oó]n|chi[- ]?cuadrado|anova|t[- ]?test|p[- ]valor|probabilidad\s+(de|binomial|normal|poisson)|varianza|desviaci[oó]n\s+est[aá]ndar|media\s+aritm|desv(iaci[oó]n)?\s+t[ií]pica|l[ií]mite\s+cuando|serie\s+de\s+fourier|transformada\s+de\s+laplace|sistema\s+de\s+ecuaciones|factorizar|simplifica\s+(la\s+)?expresi[oó]n|despejar|funci[oó]n\s+(derivada|continua|inversa))\b/i.test(lc)) {
      return 'math';
    }
    // Doc intent — generate a downloadable document (Word, Excel,
    // PowerPoint, PDF, SVG). Routes to /api/doc/generate which runs
    // python-docx / openpyxl / xlsxwriter / python-pptx / reportlab
    // in the sandbox and ships the file back as a base64 data URL.
    // We catch it BEFORE 'viz' so "dame un excel con..." doesn't get
    // grabbed by the plot regex (no 'grafico' keyword in that phrase
    // but guard against future edits) and BEFORE 'plan' so
    // "presentación / PPT / PowerPoint" wins over arch-plan.
    if (/\b(docx|xlsx|pptx|word|excel|power\s*point|powerpoint|pdf\b|informe\s+(apa|a\s*pa|word|pdf)|tesis\s+(formato|apa|word)|hoja\s+de\s+c[aá]lculo|spreadsheet|presentaci[oó]n(\s+ppt)?|descargar?\s+(un\s+)?(documento|archivo|informe|reporte|pdf|word|excel)|genera(r|me)?\s+(un\s+)?(documento|archivo|informe|reporte|pdf|word|excel|pptx?|docx?)|crea(me)?\s+(un\s+)?(documento|pdf|word|excel|pptx?|docx?|presentaci[oó]n)|exporta(r|me)?\s+(a|en|como)\s+(pdf|word|excel|docx|xlsx|pptx))\b/i.test(lc)) {
      return 'doc';
    }
    // Viz intent — charts, plots and technical diagrams. Broader than
    // the legacy 'chart' intent (which goes through OpenAI Code
    // Interpreter and returns PNG only): 'viz' routes through the
    // new /api/viz SSE pipeline that can emit matplotlib PNG, Plotly
    // interactive, Chart.js, Recharts, D3, or Mermaid based on what
    // best fits the user's brief.
    if (/\b(gr[aá]fic[oa]s?|plot|plotear|histogram(a|as)?|pareto|ishikawa|fishbone|espina\s+de\s+pescado|box[- ]?plot|diagrama\s+de\s+caja|scatter|dispersi[oó]n|s[- ]?curve|curva\s+s|earned\s+value|gantt|sankey|treemap|mapa\s+de\s+[aá]rbol|heatmap|mapa\s+de\s+calor|flujo\s+de\s+(datos|procesos?)|diagrama\s+(de\s+)?(flujo|ER|entidad[- ]relaci[oó]n|clases?|secuencia|estados?|uml|jerarqu[ií]a|jornada|journey)|dashboard\s+(de|para|con)|visuali(c|z)a[rc](i[oó]n)?|torta|pastel|barras\s+apiladas?)\b/i.test(lc)
        || /\b(grafica|grafic[ao]|grafico)(me|r)?\b/i.test(lc)) {
      return 'viz';
    }

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
- One thing make suer if user say or question about something code and according to user message that doesnot mean to create a website just like this intent so deal as text. basically that was a queston that user ask about code so deal as text.
- Only classify as 'webdev' if the user is **creating** or **building** a UI or web page. If the request involves **debugging**, **explaining**, or **reviewing code**, classify it as 'text'.
- If the user asks for **specific languages** (e.g., "HTML", "React", "CSS"), check if the request is related to **building** a UI. If yes, classify as 'webdev'.
- If the user is asking for a general explanation of something (e.g., "What is React?"), classify as 'text'.
- one more if user ask for website so create carefully detect what user want not give any developing or code detect as webdev first analyze what user want sometime they want another language code for example they want a python code so give them that code that not a webssdev.

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
- "Creating Word document or file" => text
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
