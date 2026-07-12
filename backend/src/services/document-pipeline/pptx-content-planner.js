const GENERIC_PLACEHOLDER_RE = /\b(Bloque\s+\d+|pipeline documental|Jerarqu[ií]a visual clara|Contenido editable en PowerPoint|Notas del presentador incluidas|generador autom[aá]tico de contenido no estuvo disponible|Contenido espec[ií]fico pendiente|esqueleto y maquetaci[oó]n)\b/i;

function stripAccents(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalize(value = '') {
  return stripAccents(value)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(value = '', max = 220) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const clipped = text.slice(0, max).trim();
  const boundary = clipped.lastIndexOf(' ');
  return `${clipped.slice(0, boundary > 80 ? boundary : clipped.length).trim()}...`;
}

function hasGenericPlaceholderText(value = '') {
  return GENERIC_PLACEHOLDER_RE.test(String(value || ''));
}

function isBusinessAdministrationTopic(prompt = '', title = '') {
  const text = normalize(`${prompt} ${title}`);
  return /\b(administracion|gestion|direccion)\s+(de\s+)?(empresas|empresarial|negocios|organizaciones)\b/.test(text)
    || /\bempresa(s)?\b/.test(text) && /\b(administracion|gestion|direccion)\b/.test(text);
}

function extractTopic({ prompt = '', title = '' } = {}) {
  const raw = String(title || prompt || 'Tema profesional')
    .replace(/\b(crea|crear|genera|generar|haz|hacer|prepara|elabora|pptx?|powerpoint|presentaci[oó]n|diapositivas|slides?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return raw || 'Tema profesional';
}

function splitBullet(value) {
  if (typeof value === 'object' && value !== null) {
    return {
      label: cleanText(value.label || '', 34),
      text: cleanText(value.text || value.value || '', 150),
    };
  }
  const text = cleanText(value, 170);
  const match = text.match(/^([^:.;]{3,34})[:.-]\s+(.+)$/);
  if (!match) return { label: '', text };
  return { label: cleanText(match[1], 34), text: cleanText(match[2], 150) };
}

function businessAdministrationSlides(title) {
  return [
    {
      title: 'La gestión alinea toda la empresa',
      kicker: 'Propósito de gestión',
      summary: 'La administración de empresas convierte recursos limitados en resultados sostenibles. Integra personas, procesos, finanzas y mercado para crear valor con control y dirección.',
      bullets: [
        { label: 'Objetivo', text: 'alinear estrategia, operación y cultura hacia metas medibles' },
        { label: 'Alcance', text: 'coordinar áreas funcionales sin perder foco en cliente y rentabilidad' },
        { label: 'Criterio', text: 'decidir con información, prioridades claras y seguimiento continuo' },
        { label: 'Resultado', text: 'organizaciones más productivas, adaptables y financieramente sanas' },
      ],
      metrics: [
        { label: 'Estrategia', value: 88 },
        { label: 'Operación', value: 82 },
        { label: 'Control', value: 79 },
      ],
      notes: 'Abrir explicando que administrar no es solo supervisar tareas: es diseñar un sistema para lograr objetivos, anticipar riesgos y aprender de los resultados.',
    },
    {
      title: 'El ciclo directivo reduce incertidumbre',
      kicker: 'Ciclo directivo',
      summary: 'El ciclo clásico de administración ordena el trabajo directivo en planificación, organización, dirección y control. Cada función reduce incertidumbre y mejora la ejecución.',
      bullets: [
        { label: 'Planificación', text: 'define metas, prioridades, presupuestos y escenarios de acción' },
        { label: 'Organización', text: 'asigna responsabilidades, recursos, procesos y autoridad' },
        { label: 'Dirección', text: 'moviliza equipos mediante liderazgo, comunicación y motivación' },
        { label: 'Control', text: 'mide avances, corrige desviaciones y preserva estándares' },
      ],
      metrics: [
        { label: 'Planificar', value: 90 },
        { label: 'Organizar', value: 84 },
        { label: 'Dirigir', value: 87 },
        { label: 'Controlar', value: 81 },
      ],
      notes: 'Presentar el ciclo como una rueda: cada vuelta entrega datos para mejorar la siguiente planificación.',
    },
    {
      title: 'Las áreas funcionan como un sistema',
      kicker: 'Sistema empresarial',
      summary: 'Una empresa funciona como un sistema interdependiente. Finanzas, marketing, operaciones, talento y tecnología deben trabajar con objetivos compartidos.',
      bullets: [
        { label: 'Finanzas', text: 'gestiona liquidez, inversión, costos, margen y riesgo financiero' },
        { label: 'Marketing y ventas', text: 'entiende el mercado, posiciona la oferta y desarrolla ingresos' },
        { label: 'Operaciones', text: 'transforma recursos en productos o servicios con calidad y eficiencia' },
        { label: 'Talento y tecnología', text: 'habilitan capacidades, cultura, datos y mejora continua' },
      ],
      layout: 'two_column',
      columns: [
        {
          heading: 'Finanzas y mercado',
          items: [
            'gestiona liquidez, inversión, costos, margen y riesgo financiero',
            'entiende el mercado, posiciona la oferta y desarrolla ingresos',
          ],
        },
        {
          heading: 'Operaciones y capacidades',
          items: [
            'transforma recursos en productos o servicios con calidad y eficiencia',
            'habilita talento, tecnología, cultura, datos y mejora continua',
          ],
        },
      ],
      metrics: [
        { label: 'Finanzas', value: 86 },
        { label: 'Mercado', value: 83 },
        { label: 'Operación', value: 89 },
        { label: 'Talento', value: 80 },
      ],
      notes: 'Usar esta lámina para explicar por qué los problemas empresariales rara vez pertenecen a una sola área.',
    },
    {
      title: 'La disciplina convierte estrategia en hábitos',
      kicker: 'Gobernanza y ejecución',
      summary: 'La gestión profesional combina objetivos claros, procesos simples, roles definidos y reuniones de seguimiento. El valor aparece cuando la estrategia se traduce en hábitos operativos.',
      bullets: [
        { label: 'Gobernanza', text: 'establece responsables, reglas de decisión y cadencia de revisión' },
        { label: 'Procesos', text: 'documenta flujos críticos para reducir errores y dependencia personal' },
        { label: 'Datos', text: 'construye tableros que separan señales importantes de ruido operativo' },
        { label: 'Ritmo', text: 'usa reuniones breves para destrabar problemas y confirmar avances' },
      ],
      metrics: [
        { label: 'Roles', value: 78 },
        { label: 'Procesos', value: 85 },
        { label: 'Datos', value: 82 },
      ],
      notes: 'Conectar la gestión profesional con disciplina de ejecución: lo que no tiene dueño, fecha y métrica suele quedarse en intención.',
    },
    {
      title: 'Definir el problema mejora las decisiones',
      kicker: 'De intuición a evidencia',
      summary: 'La administración de empresas mejora cuando las decisiones combinan experiencia, datos y análisis de alternativas. La calidad de decisión depende del problema que se define.',
      bullets: [
        { label: 'Diagnóstico', text: 'separar síntomas de causas mediante datos y observación directa' },
        { label: 'Alternativas', text: 'comparar opciones por costo, impacto, tiempo y riesgo' },
        { label: 'Implementación', text: 'convertir la decisión en tareas, responsables y recursos' },
        { label: 'Aprendizaje', text: 'medir resultados y ajustar el criterio para futuras decisiones' },
      ],
      metrics: [
        { label: 'Diagnóstico', value: 84 },
        { label: 'Opciones', value: 76 },
        { label: 'Ejecución', value: 88 },
        { label: 'Aprendizaje', value: 82 },
      ],
      notes: 'Resaltar que decidir rápido no siempre es decidir bien; la rapidez debe estar apoyada en información suficiente y criterios explícitos.',
    },
    {
      title: 'Los KPI convierten objetivos en señales',
      kicker: 'Control ejecutivo',
      summary: 'Los KPI convierten objetivos en señales de gestión. Deben medir productividad, rentabilidad, satisfacción, cumplimiento y salud operativa sin saturar al equipo.',
      bullets: [
        { label: 'Productividad', text: 'producción, tiempos de ciclo, uso de capacidad y retrabajo' },
        { label: 'Rentabilidad', text: 'margen bruto, EBITDA, flujo de caja y costo por unidad' },
        { label: 'Cliente', text: 'satisfacción, retención, reclamos y valor de vida del cliente' },
        { label: 'Gestión', text: 'cumplimiento de presupuesto, proyectos a tiempo y rotación de talento' },
      ],
      metrics: [
        { label: 'Margen', value: 82 },
        { label: 'Cliente', value: 86 },
        { label: 'Ejecución', value: 79 },
        { label: 'Talento', value: 74 },
      ],
      notes: 'Recomendar pocos indicadores bien definidos. Un tablero útil muestra causas probables y acciones, no solo números.',
    },
    {
      title: 'Los controles protegen velocidad y valor',
      kicker: 'Prevención ejecutiva',
      summary: 'La administración profesional identifica riesgos antes de que se conviertan en crisis. Los controles deben ser proporcionales, simples y visibles para los equipos.',
      bullets: [
        { label: 'Riesgo financiero', text: 'falta de liquidez, costos crecientes o márgenes deteriorados' },
        { label: 'Riesgo operativo', text: 'procesos frágiles, baja calidad o dependencia de personas clave' },
        { label: 'Riesgo comercial', text: 'pérdida de clientes, mala segmentación o propuesta de valor débil' },
        { label: 'Control', text: 'alertas tempranas, auditorías ligeras y responsables definidos' },
      ],
      metrics: [
        { label: 'Financiero', value: 72 },
        { label: 'Operativo', value: 80 },
        { label: 'Comercial', value: 75 },
        { label: 'Control', value: 84 },
      ],
      notes: 'Explicar que el control no debe frenar la empresa; debe proteger la velocidad con límites claros.',
    },
    {
      title: 'Próximos pasos con un plan 30-60-90',
      kicker: 'Implementación',
      summary: 'La ejecución comienza con un plan 30-60-90 que transforma el diagnóstico en prioridades concretas, responsables visibles y revisiones periódicas.',
      bullets: [
        { label: '30 días', text: 'diagnosticar procesos críticos, KPIs actuales y brechas de coordinación' },
        { label: '60 días', text: 'rediseñar responsabilidades, tablero de control y cadencia de seguimiento' },
        { label: '90 días', text: 'estandarizar procesos, revisar resultados y ajustar prioridades estratégicas' },
        { label: 'Gobierno', text: 'mantener responsables, fechas, evidencia y decisiones documentadas' },
      ],
      metrics: [
        { label: '30 días', value: 70 },
        { label: '60 días', value: 84 },
        { label: '90 días', value: 92 },
      ],
      notes: 'Cerrar invitando a pasar de conceptos a práctica: seleccionar tres procesos críticos y diseñar su tablero de gestión.',
    },
  ].map((slide) => ({
    ...slide,
    deckTitle: title,
  }));
}

function blockLooksUsable(block) {
  if (!block || block._error) return false;
  const joined = [block.paragraph, ...(block.bullets || []), block.notes].join(' ');
  if (hasGenericPlaceholderText(joined)) return false;
  return String(block.paragraph || '').trim().length > 80
    && Array.isArray(block.bullets)
    && block.bullets.filter(Boolean).length >= 3;
}

function slideFromBlock(block, index) {
  const bullets = (block.bullets || [])
    .map(splitBullet)
    .filter((bullet) => bullet.text)
    .slice(0, 5);
  return {
    title: cleanText(block.section || `Sección ${index + 1}`, 70),
    kicker: `Parte ${index + 1}`,
    summary: cleanText(block.paragraph, 260),
    bullets,
    metrics: [
      { label: 'Claridad', value: 82 + (index % 4) },
      { label: 'Impacto', value: 78 + (index % 5) },
      { label: 'Acción', value: 80 + (index % 6) },
    ],
    notes: cleanText(block.notes || `Desarrollar la idea central de ${block.section}.`, 300),
  };
}

function genericSlide(section, topic, index) {
  const normalizedSection = normalize(section);
  const lowerTopic = cleanText(topic, 120).toLowerCase();
  if (/resumen|ejecutivo|contexto/.test(normalizedSection)) {
    return {
      title: cleanText(section, 70),
      kicker: 'Lectura ejecutiva',
      summary: `${topic} requiere una lectura clara del objetivo, las partes involucradas y los criterios de éxito. Esta sección instala el marco para decidir con orden.`,
      bullets: [
        { label: 'Alcance', text: `delimitar qué problema de ${lowerTopic} se resolverá` },
        { label: 'Audiencia', text: 'identificar quién decide, quién ejecuta y quién recibe impacto' },
        { label: 'Criterio', text: 'definir métricas, restricciones y nivel de profundidad esperado' },
      ],
    };
  }
  if (/kpi|indicador|m[eé]trica|resultado/.test(normalizedSection)) {
    return {
      title: cleanText(section, 70),
      kicker: 'Medición',
      summary: `Los indicadores convierten ${lowerTopic} en señales observables. Una buena medición muestra avance, calidad, costo e impacto sin crear ruido.`,
      bullets: [
        { label: 'Resultado', text: 'medir el efecto final esperado y no solo actividades' },
        { label: 'Proceso', text: 'monitorear tiempos, calidad, cumplimiento y capacidad' },
        { label: 'Decisión', text: 'asociar cada indicador a una acción correctiva concreta' },
      ],
    };
  }
  if (/riesgo|control|amenaza/.test(normalizedSection)) {
    return {
      title: cleanText(section, 70),
      kicker: 'Gestión de riesgo',
      summary: `Todo plan sobre ${lowerTopic} necesita anticipar fallas probables. El control profesional reduce incertidumbre sin bloquear la ejecución.`,
      bullets: [
        { label: 'Riesgos', text: 'mapear causas, probabilidad, impacto y señales tempranas' },
        { label: 'Controles', text: 'asignar responsables, umbrales y revisiones periódicas' },
        { label: 'Respuesta', text: 'preparar acciones de mitigación antes del punto crítico' },
      ],
    };
  }
  if (/plan|acci[oó]n|recomendaci[oó]n|conclusi[oó]n/.test(normalizedSection)) {
    return {
      title: cleanText(section, 70),
      kicker: 'Ejecución',
      summary: `La parte final debe convertir ${lowerTopic} en decisiones y próximos pasos. Un cierre útil prioriza acciones, dueños y fechas.`,
      bullets: [
        { label: 'Prioridad', text: 'elegir pocas iniciativas con mayor impacto esperado' },
        { label: 'Responsable', text: 'asignar dueño operativo, recursos y fecha de revisión' },
        { label: 'Seguimiento', text: 'mantener evidencia visible para aprender y corregir' },
      ],
    };
  }
  return {
    title: cleanText(section, 70),
    kicker: `Parte ${index + 1}`,
    summary: `${section} desarrolla un componente central de ${lowerTopic}. La lámina debe explicar la idea, conectar implicancias y traducirlas en decisiones concretas.`,
    bullets: [
      { label: 'Idea central', text: `definir el rol de ${section.toLowerCase()} dentro de ${lowerTopic}` },
      { label: 'Implicancia', text: 'mostrar cómo afecta costos, tiempos, calidad o experiencia' },
      { label: 'Acción', text: 'proponer una decisión práctica y medible' },
    ],
  };
}

function genericSlides({ title, prompt, sections = [], blocks = [] }) {
  const topic = extractTopic({ prompt, title });
  const usableBlocks = Array.isArray(blocks) ? blocks.filter(blockLooksUsable) : [];
  if (usableBlocks.length >= 3) return usableBlocks.slice(0, 8).map(slideFromBlock);
  const baseSections = Array.isArray(sections) && sections.length > 0
    ? sections
    : ['Resumen ejecutivo', 'Contexto', 'Análisis', 'Riesgos', 'Plan de acción', 'Conclusiones'];
  return baseSections.slice(0, 8).map((section, index) => {
    const slide = genericSlide(section, topic, index);
    return {
      ...slide,
      metrics: [
        { label: 'Claridad', value: 80 + (index % 6) },
        { label: 'Impacto', value: 76 + (index % 7) },
        { label: 'Ejecución', value: 78 + (index % 8) },
      ],
      notes: `Explicar ${section.toLowerCase()} con ejemplos conectados a ${topic}. Mantener la lámina enfocada en una sola decisión o aprendizaje.`,
    };
  });
}

function normalizeSlides(slides) {
  return slides
    .filter(Boolean)
    .map((slide, index) => {
      const bullets = (slide.bullets || []).map(splitBullet).filter((bullet) => bullet.text).slice(0, 5);
      const explicitColumns = (Array.isArray(slide.columns) ? slide.columns : [])
        .slice(0, 2)
        .map((column) => ({
          heading: cleanText(column?.heading || '', 42),
          items: (Array.isArray(column?.items) ? column.items : []).map((item) => cleanText(item, 120)).filter(Boolean).slice(0, 4),
        }))
        .filter((column) => column.items.length > 0);
      const useColumns = explicitColumns.length === 2 || (index > 0 && index % 3 === 2 && bullets.length >= 4);
      return {
        layout: useColumns ? 'two_column' : (slide.layout || 'bullets'),
        title: cleanText(slide.title || `Sección ${index + 1}`, 70),
        kicker: cleanText(slide.kicker || `Parte ${index + 1}`, 42),
        summary: cleanText(slide.summary || '', 280),
        bullets,
        columns: useColumns ? (explicitColumns.length === 2 ? explicitColumns : [
          { heading: [bullets[0]?.label, bullets[1]?.label].filter(Boolean).join(' y ') || 'Prioridades', items: bullets.slice(0, 2).map((bullet) => bullet.text) },
          { heading: [bullets[2]?.label, bullets[3]?.label].filter(Boolean).join(' y ') || 'Ejecución', items: bullets.slice(2, 4).map((bullet) => bullet.text) },
        ]) : undefined,
        takeaway: cleanText(slide.takeaway || bullets[0]?.text || '', 130),
        // Decorative percentages such as "claridad 82" or "impacto 78"
        // are deliberately discarded. Charts only survive the grounded LLM
        // path, where every numeric value must exist in source evidence.
        metrics: [],
        notes: cleanText(slide.notes || `Presentar ${slide.title || `sección ${index + 1}`}.`, 320),
      };
    })
    .filter((slide) => slide.summary || slide.bullets.length > 0);
}

function buildPptxContentPlan({ title, prompt, template, sections = [], blocks = [], referenceBriefs = [] } = {}) {
  const topic = extractTopic({ prompt, title });
  const slides = isBusinessAdministrationTopic(prompt, title)
    ? businessAdministrationSlides(topic)
    : genericSlides({ title: topic, prompt, template, sections, blocks });
  const normalizedSlides = normalizeSlides(slides);
  const references = Array.isArray(referenceBriefs)
    ? referenceBriefs.slice(0, 4).map((ref) => ({
      name: cleanText(ref.name || 'Referencia', 80),
      excerpt: cleanText(ref.excerpt || '', 180),
    }))
    : [];
  return {
    topic,
    source: isBusinessAdministrationTopic(prompt, title) ? 'domain:business-administration' : 'structured-content',
    thesis: isBusinessAdministrationTopic(prompt, title)
      ? 'Administrar empresas significa coordinar estrategia, personas, procesos y finanzas para crear valor sostenible.'
      : `${topic} se presenta con narrativa ejecutiva, criterios de decisión y acciones verificables.`,
    agenda: normalizedSlides.map((slide) => slide.title).slice(0, 7),
    slides: normalizedSlides,
    references,
  };
}

module.exports = {
  GENERIC_PLACEHOLDER_RE,
  buildPptxContentPlan,
  hasGenericPlaceholderText,
};
