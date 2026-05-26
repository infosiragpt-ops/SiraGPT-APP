'use strict';

/**
 * Multilingual lexicon — extensions for PT, FR, DE, IT.
 *
 * Paper observation: language-independent reasoning circuits exist
 * (translation features fire regardless of source/target language). For
 * intent attribution, we want the same: the user's *intent* should be
 * identified independent of which language they wrote in. We supplement
 * the core ES/EN extractor with lexical entries for the four most-common
 * additional Western European languages SiraGPT serves.
 *
 * Used by feature-extractor when the detected language is one of these.
 * Kept separate from the main extractor so the core stays tractable.
 */

const EXTRA_ACTION_LEXICON = [
  // Portuguese
  { pattern: /\b(cri(?:a|ar|e|emos)|gera(?:r)?|fa(?:ça|zer)|constru(?:a|ir)|desenvolv(?:a|er)|implementa(?:r)?|escrev(?:a|er)|redig(?:a|ir))\b/i, label: 'create', weight: 1.0, lang: 'pt' },
  { pattern: /\b(modific(?:a|ar|amos)|melhor(?:a|ar|amos)|atualiz(?:a|ar|amos)|corrij(?:a|ir)|arrum(?:a|ar)|consert(?:a|ar)|repar(?:a|ar)|ajust(?:a|ar))\b/i, label: 'modify', weight: 0.95, lang: 'pt' },
  { pattern: /\b(analis(?:a|ar|amos)|revis(?:a|ar|amos)|estud(?:a|ar|amos)|investig(?:a|ar))\b/i, label: 'analyze', weight: 0.9, lang: 'pt' },
  { pattern: /\b(explic(?:a|ar|amos)|descrev(?:a|er)|conte(?:-me)?|porqu[eê])\b/i, label: 'explain', weight: 0.85, lang: 'pt' },
  { pattern: /\b(implant(?:a|ar)|publica(?:r)?|execut(?:a|ar)|inici(?:a|ar)|lanc(?:a|ar))\b/i, label: 'execute', weight: 0.95, lang: 'pt' },
  { pattern: /\b(test(?:a|ar|amos)|verific(?:a|ar)|valid(?:a|ar)|confirm(?:a|ar))\b/i, label: 'verify', weight: 0.85, lang: 'pt' },
  { pattern: /\b(remov(?:a|er)|apag(?:a|ar)|elimin(?:a|ar)|delet(?:a|ar)|excluir)\b/i, label: 'remove', weight: 0.95, lang: 'pt' },
  { pattern: /\b(busc(?:a|ar)|encontr(?:a|ar)|procur(?:a|ar)|localiz(?:a|ar))\b/i, label: 'search', weight: 0.85, lang: 'pt' },
  { pattern: /\b(compar(?:a|ar)|contrast(?:a|ar))\b/i, label: 'compare', weight: 0.85, lang: 'pt' },
  { pattern: /\b(resum(?:a|ir)|sintetiz(?:a|ar)|sumariz(?:a|ar))\b/i, label: 'summarize', weight: 0.85, lang: 'pt' },
  { pattern: /\b(traduz(?:a|ir)|traduc(?:a|ir)|localiz(?:a|ar))\b/i, label: 'translate', weight: 0.9, lang: 'pt' },
  { pattern: /\b(continu(?:a|ar)|prossig(?:a|ir)|seg(?:ue|uir|amos))\b/i, label: 'continue', weight: 0.9, lang: 'pt' },

  // French
  { pattern: /\b(cré(?:e|ez|er|ons)|génér(?:e|er|ons)|fai(?:s|tes|re)|construi(?:s|re|sez)|développ(?:e|er|ons)|implémen(?:te|ter|tons)|écri(?:s|re|vez))\b/i, label: 'create', weight: 1.0, lang: 'fr' },
  { pattern: /\b(modifi(?:e|er|ons)|amélior(?:e|er|ons)|actualis(?:e|er|ons)|corrig(?:e|er|ons)|répar(?:e|er|ons)|ajust(?:e|er|ons))\b/i, label: 'modify', weight: 0.95, lang: 'fr' },
  { pattern: /\b(analys(?:e|er|ons)|révis(?:e|er|ons)|étudi(?:e|er|ons)|examin(?:e|er|ons)|évalu(?:e|er|ons))\b/i, label: 'analyze', weight: 0.9, lang: 'fr' },
  { pattern: /\b(expliqu(?:e|er|ons)|décri(?:s|re|vez)|pourquoi|comment)\b/i, label: 'explain', weight: 0.85, lang: 'fr' },
  { pattern: /\b(déploi(?:e|er|ons)|publi(?:e|er|ons)|exécut(?:e|er|ons)|lanc(?:e|er|ons)|démarr(?:e|er|ons))\b/i, label: 'execute', weight: 0.95, lang: 'fr' },
  { pattern: /\b(test(?:e|er|ons)|vérifi(?:e|er|ons)|valid(?:e|er|ons)|confirm(?:e|er|ons))\b/i, label: 'verify', weight: 0.85, lang: 'fr' },
  { pattern: /\b(supprim(?:e|er|ons)|enlèv(?:e|er|ons)|efface(?:r|z)?|retir(?:e|er|ons))\b/i, label: 'remove', weight: 0.95, lang: 'fr' },
  { pattern: /\b(cherch(?:e|er|ons)|trouv(?:e|er|ons)|localis(?:e|er|ons))\b/i, label: 'search', weight: 0.85, lang: 'fr' },
  { pattern: /\b(compar(?:e|er|ons)|contrast(?:e|er|ons))\b/i, label: 'compare', weight: 0.85, lang: 'fr' },
  { pattern: /\b(résum(?:e|er|ons)|synthétis(?:e|er|ons))\b/i, label: 'summarize', weight: 0.85, lang: 'fr' },
  { pattern: /\b(tradui(?:s|re|sez)|localis(?:e|er|ons))\b/i, label: 'translate', weight: 0.9, lang: 'fr' },
  { pattern: /\b(continu(?:e|er|ons)|poursui(?:s|vre|vez))\b/i, label: 'continue', weight: 0.9, lang: 'fr' },

  // German
  { pattern: /\b(erstell(?:e|en|t)|erzeug(?:e|en|t)|baue(?:n)?|entwickl(?:e|en|t)|implementier(?:e|en|t)|schreib(?:e|en|t))\b/i, label: 'create', weight: 1.0, lang: 'de' },
  { pattern: /\b(ändere(?:n)?|verbess(?:ere|ern|ert)|aktualisi(?:ere|eren|ert)|repari(?:ere|eren|ert)|behebe(?:n)?|justi(?:ere|eren))\b/i, label: 'modify', weight: 0.95, lang: 'de' },
  { pattern: /\b(analysi(?:ere|eren|ert)|überprüfe(?:n)?|untersuche(?:n)?|prüfe(?:n)?|werte(?:n)? aus)\b/i, label: 'analyze', weight: 0.9, lang: 'de' },
  { pattern: /\b(erkläre(?:n)?|beschreibe(?:n)?|warum|wieso|wie funktioniert)\b/i, label: 'explain', weight: 0.85, lang: 'de' },
  { pattern: /\b(deploye(?:n)?|veröffentliche(?:n)?|starte(?:n)?|führe(?:n)? aus|publizi(?:ere|eren))\b/i, label: 'execute', weight: 0.95, lang: 'de' },
  { pattern: /\b(teste(?:n)?|verifizi(?:ere|eren|ert)|validi(?:ere|eren|ert)|bestätig(?:e|en|t))\b/i, label: 'verify', weight: 0.85, lang: 'de' },
  { pattern: /\b(lösche(?:n)?|entferne(?:n)?|beseitig(?:e|en|t))\b/i, label: 'remove', weight: 0.95, lang: 'de' },
  { pattern: /\b(suche(?:n)?|finde(?:n)?|recherchi(?:ere|eren))\b/i, label: 'search', weight: 0.85, lang: 'de' },
  { pattern: /\b(vergleich(?:e|en|t)|kontrasti(?:ere|eren))\b/i, label: 'compare', weight: 0.85, lang: 'de' },
  { pattern: /\b(zusammenfasse(?:n)?|fasse(?:n)? zusammen)\b/i, label: 'summarize', weight: 0.85, lang: 'de' },
  { pattern: /\b(übersetze(?:n)?|lokalisi(?:ere|eren))\b/i, label: 'translate', weight: 0.9, lang: 'de' },
  { pattern: /\b(weiter(?:machen)?|fortfahre(?:n)?|fortsetze(?:n)?)\b/i, label: 'continue', weight: 0.9, lang: 'de' },

  // Italian
  { pattern: /\b(crea(?:re|te|iamo)?|gener(?:a|are|ate)|costru(?:isci|ire|iamo)|svilupp(?:a|are|iamo)|implement(?:a|are|iamo)|scriv(?:i|ere|iamo))\b/i, label: 'create', weight: 1.0, lang: 'it' },
  { pattern: /\b(modific(?:a|are|hiamo)|miglior(?:a|are|iamo)|aggiorn(?:a|are|iamo)|corregg(?:i|ere|iamo)|ripar(?:a|are|iamo)|sistem(?:a|are|iamo))\b/i, label: 'modify', weight: 0.95, lang: 'it' },
  { pattern: /\b(analizz(?:a|are|iamo)|esamin(?:a|are|iamo)|controll(?:a|are|iamo)|valut(?:a|are|iamo))\b/i, label: 'analyze', weight: 0.9, lang: 'it' },
  { pattern: /\b(spieg(?:a|are|hiamo)|descriv(?:i|ere|iamo)|perch[eé]|come funziona)\b/i, label: 'explain', weight: 0.85, lang: 'it' },
  { pattern: /\b(distribu(?:isci|ire)|pubblic(?:a|are|hiamo)|esegu(?:i|ire|iamo)|avvi(?:a|are|iamo)|lanci(?:a|are|amo))\b/i, label: 'execute', weight: 0.95, lang: 'it' },
  { pattern: /\b(test(?:a|are|iamo)|verific(?:a|are|hiamo)|valid(?:a|are|iamo)|conferm(?:a|are|iamo))\b/i, label: 'verify', weight: 0.85, lang: 'it' },
  { pattern: /\b(rimuov(?:i|ere|iamo)|cancell(?:a|are|iamo)|elimin(?:a|are|iamo))\b/i, label: 'remove', weight: 0.95, lang: 'it' },
  { pattern: /\b(cerc(?:a|are|hiamo)|trov(?:a|are|iamo)|localizz(?:a|are|iamo))\b/i, label: 'search', weight: 0.85, lang: 'it' },
  { pattern: /\b(confront(?:a|are|iamo)|paragon(?:a|are|iamo))\b/i, label: 'compare', weight: 0.85, lang: 'it' },
  { pattern: /\b(riassum(?:i|ere|iamo)|sintetizz(?:a|are|iamo))\b/i, label: 'summarize', weight: 0.85, lang: 'it' },
  { pattern: /\b(traduc(?:i|ere|iamo)|localizz(?:a|are|iamo))\b/i, label: 'translate', weight: 0.9, lang: 'it' },
  { pattern: /\b(continu(?:a|are|iamo)|proced(?:i|ere|iamo))\b/i, label: 'continue', weight: 0.9, lang: 'it' },
];

const EXTRA_OBJECT_LEXICON = [
  // Portuguese
  { pattern: /\b(c[oó]digo|fun[çc][aã]o|m[oó]dulo|componente|classe)\b/i, label: 'code-artifact', lang: 'pt' },
  { pattern: /\b(banco de dados|esquema|tabela|migra[çc][aã]o)\b/i, label: 'database', lang: 'pt' },
  { pattern: /\b(teste|cobertura|especifica[çc][aã]o)\b/i, label: 'test-suite', lang: 'pt' },
  { pattern: /\b(documento|relat[oó]rio|informe)\b/i, label: 'document', lang: 'pt' },
  { pattern: /\b(seguran[çc]a|autoriza[çc][aã]o|permiss[aã]o)\b/i, label: 'security', lang: 'pt' },
  { pattern: /\b(implanta[çc][aã]o|produ[çc][aã]o|libera[çc][aã]o)\b/i, label: 'deployment', lang: 'pt' },

  // French
  { pattern: /\b(code|fonction|module|composant|classe)\b/i, label: 'code-artifact', lang: 'fr' },
  { pattern: /\b(base de données|schéma|table|migration)\b/i, label: 'database', lang: 'fr' },
  { pattern: /\b(test|tests|couverture)\b/i, label: 'test-suite', lang: 'fr' },
  { pattern: /\b(document|rapport)\b/i, label: 'document', lang: 'fr' },
  { pattern: /\b(sécurité|autorisation|permission)\b/i, label: 'security', lang: 'fr' },
  { pattern: /\b(déploiement|production|publication)\b/i, label: 'deployment', lang: 'fr' },

  // German
  { pattern: /\b(Code|Funktion|Modul|Komponente|Klasse)\b/i, label: 'code-artifact', lang: 'de' },
  { pattern: /\b(Datenbank|Schema|Tabelle|Migration)\b/i, label: 'database', lang: 'de' },
  { pattern: /\b(Test|Tests|Abdeckung)\b/i, label: 'test-suite', lang: 'de' },
  { pattern: /\b(Dokument|Bericht)\b/i, label: 'document', lang: 'de' },
  { pattern: /\b(Sicherheit|Autorisierung|Berechtigung)\b/i, label: 'security', lang: 'de' },
  { pattern: /\b(Bereitstellung|Produktion|Veröffentlichung)\b/i, label: 'deployment', lang: 'de' },

  // Italian
  { pattern: /\b(codice|funzione|modulo|componente|classe)\b/i, label: 'code-artifact', lang: 'it' },
  { pattern: /\b(database|schema|tabella|migrazione)\b/i, label: 'database', lang: 'it' },
  { pattern: /\b(test|copertura|specifica)\b/i, label: 'test-suite', lang: 'it' },
  { pattern: /\b(documento|relazione|rapporto)\b/i, label: 'document', lang: 'it' },
  { pattern: /\b(sicurezza|autorizzazione|permesso)\b/i, label: 'security', lang: 'it' },
  { pattern: /\b(distribuzione|produzione|rilascio)\b/i, label: 'deployment', lang: 'it' },
];

function detectExtendedLanguage(text) {
  if (!text || typeof text !== 'string') return null;
  const counts = {
    pt: (text.match(/\b(você|está|não|também|porque|isto|isso|aquilo|nós|eles|aqui|necessário|precisamos|fazer|favor|crie|criar)\b/gi) || []).length,
    fr: (text.match(/\b(le|la|les|que|qui|pour|avec|dans|cette|cet|comment|pourquoi|nous|vous|veuillez|c'est|n'est|créer)\b/gi) || []).length,
    de: (text.match(/\b(der|die|das|und|für|mit|ist|nicht|sie|wir|warum|wie|bitte|wichtig|brauchen|erstellen)\b/gi) || []).length,
    it: (text.match(/\b(il|la|che|per|con|sono|non|come|perché|sull|questo|abbiamo|bisogno|favore|del|della|crea)\b/gi) || []).length,
  };
  if (/\b(você|crie|criar|também|necessário)\b/i.test(text)) counts.pt += 3;
  if (/[ãõ]|\bnão\b|ç[aãoõ]/i.test(text)) counts.pt += 2;
  if (/\bveuillez\b|\bs'il vous plaît\b|[œ]/i.test(text)) counts.fr += 3;
  if (/\b(bitte|warum|brauchen)\b|[äöüß]/i.test(text)) counts.de += 3;
  if (/\b(perché|abbiamo|bisogno|favore)\b/i.test(text)) counts.it += 3;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (sorted[0][1] < 2) return null;
  return sorted[0][0];
}

module.exports = {
  EXTRA_ACTION_LEXICON,
  EXTRA_OBJECT_LEXICON,
  detectExtendedLanguage,
};
