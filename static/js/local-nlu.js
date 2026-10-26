// Compréhension simplifiée, sans IA : commandes vocales et mode de secours
// quand le service d'intelligence artificielle ne répond pas.

export function normalize(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[’']/g, ' ').replace(/[^a-z0-9/%,. ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const COMMANDS = [
  ['repeat', /^(tu peux |vous pouvez |peux tu |pouvez vous )?(repete[rz]?|repetez|redis|redire|encore une fois|pardon|quoi|comment)( la question)?( s il (te|vous) plait)?$/],
  ['back', /^(question )?(precedente?|retour( en arriere)?|revenir( en arriere)?|reviens( en arriere)?)$/],
  ['back', /^(je veux |je voudrais |on peut |peut on |on va )?(revenir|retourner|aller|repasser) (a |sur )?(la )?question precedente$/],
  ['skip', /^(passer|passe|suivante?|question suivante|je passe|je prefere ne pas repondre|on passe)$/],
  ['help', /^(je (ne )?comprends? pas|j ai pas compris|je n ai pas compris|c est quoi|ca veut dire quoi|explique[rz]?( moi)?|aide|au secours)$/],
  ['help', /^(tu peux |vous pouvez |peux tu |pouvez vous )?(reformule[rz]?|dis le autrement|dites le autrement|plus simplement|plus simple)( la question)?( s il (te|vous) plait)?$/],
  ['pause', /^(pause|stop|arrete[rz]?|on arrete|je fais une pause)$/],
  // « j'ai terminé » est réservé à la fin de l'écoute (voir voice.js).
  ['finish', /^(je veux |je voudrais |on peut )?(aller au|voir le|afficher le|passer au) recapitulatif$|^(terminer|finir|arreter) (le|ce) (questionnaire|formulaire)$/],
  ['dontknow', /^(je (ne )?(sais|sait|sai) (pas|plus|rien)|j en sais rien|j en ai aucune idee|aucune idee|je (ne )?(me )?(souviens|rappelle) (pas|plus)|je n ai pas l information|je ne suis pas sure?|pas sure?)( du tout)?( trop)?( desole(e)?)?$/],
];

/** « On commence » (écran « Avant de commencer ») : l'usager est prêt à répondre aux questions. */
export function detectBegin(utterance) {
  const n = normalize(utterance).replace(/[.,!]/g, '').trim();
  return /^((alors|bon|oui|ok|okay|d accord) )*(on (commence|y va|demarre|peut commencer)|commencer?|commencons|je commence|c est parti|allons y|vas y|allez y|go|oui|ok|okay|d accord|je suis pret(e)?|pret(e)?|(question )?suivante?)$/.test(n);
}

/** « Lis-moi les réponses » : l'usager veut entendre toutes les réponses possibles de la question. */
export function detectListRequest(utterance) {
  const n = normalize(utterance).replace(/[.,!?]/g, '').trim();
  return /\b(lis|lisez|lire|relis|relisez|redis|redites|donne|donnez|dis|dites|entendre|ecouter|connaitre|quelles? sont)\b.*\b(reponses|choix|propositions|possibilites|liste)\b/.test(n)
    || /^(la |les )?(liste|reponses|choix|propositions)( possibles?)?$/.test(n);
}

/** « C'est tout », « non », « rien d'autre » : l'usager n'a rien à ajouter à sa réponse. */
export function detectDone(utterance) {
  const n = normalize(utterance).replace(/[.,!?]/g, '').trim().replace(/^((euh|heu|ben|bah|alors|bon|ok|d accord) )+/, '');
  return /^(non|nan|non non|non merci|non c est tout|c est tout|c est bon|ca ira|ca suffit|non ca va|non ca ira|rien|rien d autre|non rien( d autre)?|plus rien|pas d autre chose|non pas d autre chose|c est fini|j ai fini|termine|je pense que c est tout|(question )?suivante?|on passe|passer)( merci)?$/.test(n);
}

/** « Étape suivante » → 'next', « (revenir à l')étape précédente » → 'prev', sinon null. */
export function detectStepCommand(utterance) {
  const n = normalize(utterance).replace(/[.,!]/g, '').trim();
  if (/^((on )?(passe|passer|va|aller|allons) (a |a l )?|je veux (passer|aller) (a |a l )?)?(l )?etape suivante$/.test(n)) return 'next';
  if (/^((on )?(revient|revenir|retourne|retourner|retour) (a |a l )?|je veux (revenir|retourner) (a |a l )?)?(l )?etape precedente$/.test(n)) return 'prev';
  return null;
}

// ---------- Retour à une question précise ----------

const NUMBER_WORDS = {
  un: 1, une: 1, premiere: 1, premier: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
  onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16, vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60,
};

/** « 12 », « douze », « vingt-trois », « trente et un » → nombre (ou null). */
export function parseNumber(text) {
  const n = normalize(text).replace(/-/g, ' ');
  const digits = n.match(/\b(\d{1,3})\b/);
  if (digits) return Number(digits[1]);
  let total = 0;
  let found = false;
  for (const w of n.split(' ')) {
    if (w === 'et') continue;
    if (w in NUMBER_WORDS) { total += NUMBER_WORDS[w]; found = true; } else if (found) break;
  }
  return found ? total : null;
}

const NAV_VERB = '(revenir|retourner|reviens|retourne|revenons|retournons|aller|va|allez|allons|passer|reprendre|corriger|modifier|changer|rectifier)';

/**
 * Demande de retour à une question précise (autre que la précédente) :
 * { number } pour « revenir à la question 5 », { target } pour « revenir à la question sur le logement »
 * ou « corriger ma réponse sur l'AAH ». null sinon.
 */
export function detectNavigation(utterance) {
  const n = normalize(utterance).replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\bprecedente?\b|\ben arriere\b/.test(n)) return null; // « question précédente » : commande « back »
  let m = n.match(new RegExp(`\\b${NAV_VERB}\\b.*?\\bquestions? (numero |n |no )?([a-z0-9 -]+)$`));
  if (m) {
    const number = parseNumber(m[3]);
    if (number) return { number };
  }
  m = n.match(new RegExp(`\\b${NAV_VERB}\\b (a |sur |vers )?(la |ma |une )?(question|reponse)s? (sur |a propos d(e|u|es) |concernant |de |du |des |pour |ou |d |qui parle d(e|u|es) )(.+)$`));
  if (m) return { target: m[m.length - 1].trim() };
  m = n.match(/\b(revenir|retourner|reviens|retourne|revenons|retournons) (a la |a l |a |au |aux |sur |vers )(.+)$/);
  if (m) return { target: m[3].trim() };
  return null;
}

const NAV_STOP = new Set(['question', 'questions', 'reponse', 'reponses', 'celle', 'parle', 'avais', 'dit', 'j', 'ai', 'moi']);

/**
 * Recherche sans IA : `candidates` = [{ id, text, answer }] (question et réponses possibles,
 * réponse actuelle). Un mot trouvé dans la réponse de l'usager compte double : « mon chien »
 * désigne la question où il en a parlé. Renvoie les ids les mieux notés (plusieurs si égalité).
 */
export function findQuestions(candidates, target) {
  const words = normalize(target).split(/[ ,.]+/).filter((w) => w.length >= 3 && !STOP.has(w) && !NAV_STOP.has(w));
  if (!words.length) return [];
  const scored = candidates.map((c) => {
    const hay = ` ${normalize(c.text)} `;
    const answer = ` ${normalize(c.answer || '')} `;
    return { id: c.id, s: words.filter((w) => hay.includes(w)).length + 2 * words.filter((w) => answer.includes(w)).length };
  }).filter((x) => x.s > 0);
  const best = Math.max(0, ...scored.map((x) => x.s));
  return scored.filter((x) => x.s === best).map((x) => x.id);
}

/** Commandes courtes reconnues localement (plus rapide que l'IA). */
export function detectCommand(utterance) {
  // Hésitations en début de phrase (« euh, je ne sais pas ») : ignorées.
  const n = normalize(utterance).replace(/[.,]/g, '').trim().replace(/^((euh|heu|bah|ben|bof|hmm|alors|ah|oh|franchement|honnetement) )+/, '');
  if (n.split(' ').length > 7) return null;
  for (const [intent, re] of COMMANDS) if (re.test(n)) return intent;
  return null;
}

const STOP = new Set(['pour', 'vous', 'votre', 'vos', 'avec', 'dans', 'une', 'des', 'les', 'aux', 'autre', 'autres',
  'etes', 'avez', 'd', 'l', 'un', 'de', 'du', 'la', 'le', 'ou', 'et', 'en', 'se', 'son', 'sa', 'ses', 'eux', 'entre',
  'etc', 'par', 'sur', 'aller', 'ex', 'qui', 'quelqu', 'sont', 'fait', 'faire', 'mon', 'mes', 'est', 'pas', 'que', 'aide']);

function keywords(label) {
  return normalize(label.replace(/\(.*?\)/g, '')).split(/[ ,.]+/).filter((w) => w.length >= 3 && !STOP.has(w));
}

// Glossaire des sigles du formulaire (« ESAT » → « établissement et service d'aide par le travail »).
let GLOSSARY = {};
export function setGlossary(glossary) { GLOSSARY = glossary || {}; }

/** Sigles d'un libellé, entre parenthèses ou non : « (AAH) », « en ESAT » → « aah », « esat ». */
function acronyms(label) {
  return [...label.matchAll(/\b[A-Z]{2,6}\b/g)].map((m) => m[0].toLowerCase());
}

/** Lettres épelées recollées : « a a h », « a.a.h. » → « aah ». */
const joinSpelled = (n) => n.replace(/\b[a-z]\b(?:[ .]+[a-z]\b)+/g, (m) => m.replace(/[ .]/g, ''));

/** Termes reconnus pour une option : mots-clés du libellé complet, ou sigle seul (« l'AAH », « le RSA »). */
/** Exemples entre parenthèses (« (barre d'appui, déambulateur…) »), hors sigles. */
function examples(label) {
  const inside = [...label.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]).filter((t) => !/^[A-Z]{2,6}$/.test(t));
  return inside.flatMap((t) => keywords(t));
}

function optionMatches(o, n) {
  const joined = joinSpelled(n);
  const pad = (t) => ` ${t.replace(/[,.]/g, ' ').replace(/\s+/g, ' ')} `;
  const padded = pad(n);
  const paddedJoined = pad(joined);
  const hasPhrase = (p) => p && (padded.includes(` ${p} `) || paddedJoined.includes(` ${p} `));
  const expansion = (a) => normalize(GLOSSARY[a.toUpperCase()] || '');
  return [
    ...keywords(o.label).filter((k) => n.includes(k)),
    ...examples(o.label).filter((k) => n.includes(k)),
    // Synonymes du formulaire (« bus » → transports en commun, « ASI »), en mots entiers.
    ...(o.synonyms || []).map(normalize).filter(hasPhrase),
    // Sigle dit tel quel ou épelé (« l'AAH », « a a h »), ou sa forme développée.
    ...acronyms(o.label).filter((a) => new RegExp(`\\b[ld]?${a}\\b`).test(joined) || hasPhrase(expansion(a))),
  ];
}

/**
 * Options reconnues, la plus probable d'abord. Une option dont tous les termes reconnus
 * sont aussi ceux d'une option mieux reconnue est écartée : « allocation de solidarité
 * spécifique » ne coche pas en plus les autres allocations.
 */
function matchOptions(options, n) {
  const hits = options.map((o) => ({ o, m: optionMatches(o, n) })).filter((x) => x.m.length);
  return hits
    .filter((x) => !hits.some((y) => y.m.length > x.m.length && x.m.every((t) => y.m.includes(t))))
    .sort((a, b) => b.m.length - a.m.length)
    .map((x) => x.o);
}

const YES = /\b(oui|ouais|bien sur|exact|exactement|tout a fait|affirmatif|d accord|c est ca|voila)\b/;
const NO = /\b(non|pas du tout|jamais|aucun|aucune|rien|nan|concerne pas|pas concernee?)\b/;
const MONTHS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];

function parseDate(n) {
  let m = n.match(/\b(\d{1,2})[/ .-](\d{1,2})[/ .-](\d{4})\b/);
  if (m) return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
  m = n.match(/\b(?:(\d{1,2}|premier|1er) )?(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre) (\d{4})\b/);
  if (m) {
    const day = !m[1] || m[1].startsWith('prem') || m[1] === '1er' ? '01' : m[1].padStart(2, '0');
    return `${day}/${String(MONTHS.indexOf(m[2]) + 1).padStart(2, '0')}/${m[3]}`;
  }
  return null;
}

/** Interprétation minimale, même forme de résultat que /api/interpret. */
export function interpretLocally(q, utterance, { draft } = {}) {
  const n = normalize(utterance);
  const base = {
    intent: 'answer', selected: [], none_apply: false, yes_no: null, date: null, number: null,
    text: null, rows: [], complete: true, awaiting_validation: false, precisions: [], message: '',
  };
  const cmd = detectCommand(utterance);
  // « Je ne sais pas » : on passe à la question suivante, l'usager pourra y revenir.
  if (cmd === 'dontknow') {
    return { ...base, intent: 'skip', message: 'Ce n’est pas grave. On passe à la suite, vous pourrez y revenir plus tard.' };
  }
  if (cmd) return { ...base, intent: cmd, complete: cmd === 'skip' };

  const clarify = (message) => ({ ...base, intent: 'clarify', complete: false, message });

  switch (q.type) {
    case 'single':
    case 'multi': {
      const matched = matchOptions(q.options, n);
      if (q.allowNone && NO.test(n) && !matched.length) {
        return { ...base, none_apply: true, message: 'C’est noté : cela ne vous concerne pas.' };
      }
      if (q.options.some((o) => o.id === 'non') && NO.test(n) && !matched.length) {
        return { ...base, selected: ['non'], message: 'C’est noté : non.' };
      }
      // Réponse hors liste : on coche « Autre » et on garde la phrase comme précision.
      const other = q.options.find((o) => o.id === 'autre' || o.id === 'autres');
      if (!matched.length && other && !NO.test(n)) {
        if (/^(une? )?(autres?|autre chose)$/.test(n)) return { ...base, selected: [other.id], message: `C’est noté : ${other.label}.` };
        if (n.split(' ').length >= 2) {
          const text = utterance.trim();
          return { ...base, selected: [other.id], precisions: [{ option: other.id, text }], message: `C’est noté : ${other.label} : ${text}.` };
        }
      }
      if (!matched.length) return clarify('Je n’ai pas bien compris. Pouvez-vous choisir parmi les réponses affichées ?');
      const selected = q.type === 'single' ? [matched[0].id] : matched.map((o) => o.id);
      const labels = selected.map((id) => q.options.find((o) => o.id === id).label).join(', ');
      return { ...base, selected, message: `C’est noté : ${labels}.` };
    }
    case 'yesno':
      if (YES.test(n)) return { ...base, yes_no: 'oui', message: 'C’est noté : oui.' };
      if (NO.test(n)) return { ...base, yes_no: 'non', message: 'C’est noté : non.' };
      return clarify('Pouvez-vous répondre par oui ou par non ?');
    case 'date': {
      const date = parseDate(n);
      if (!date) return clarify('Je n’ai pas compris la date. Dites par exemple : 15 mars 2024.');
      return { ...base, date, message: `C’est noté : ${date}.` };
    }
    case 'number': {
      const m = n.match(/\d+(?:[.,]\d+)?/);
      if (m) return { ...base, number: Number(m[0].replace(',', '.')), message: `C’est noté : ${m[0]}.` };
      if (NO.test(n)) return { ...base, number: 0, message: 'C’est noté : zéro.' };
      return clarify('Pouvez-vous dire un nombre ? Par exemple : 20.');
    }
    case 'table':
      if (NO.test(n) && n.split(' ').length < 5) return { ...base, none_apply: true, message: 'C’est noté : rien à déclarer.' };
      return { ...base, rows: [{ [q.columns[0].id]: utterance.trim() }], message: 'C’est noté. Vous pouvez compléter les détails dans le formulaire.' };
    case 'longtext':
      if (draft && YES.test(n) && n.split(' ').length < 6) return { ...base, text: draft, message: 'Le texte est enregistré.' };
      return {
        ...base, text: [draft, utterance.trim()].filter(Boolean).join('\n'), complete: false, awaiting_validation: true,
        message: 'J’ai ajouté ce que vous avez dit au texte. Dites « oui » pour valider, ou continuez à parler pour compléter.',
      };
    default:
      if (q.optional && NO.test(n) && n.split(' ').length < 4) return { ...base, message: 'D’accord.' };
      return { ...base, text: utterance.trim(), message: 'C’est noté.' };
  }
}
