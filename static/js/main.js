import {
  loadSchema, renderForm, writeValue, computeVisibility, maxVisible, showQuestion, parentOf, isFollowUp, rootOf,
  isAnswered, formatValue, dateError, NONE,
} from './form.js';
import { Speaker, Listener, canListen, canSpeak, OPTION_BREAK } from './voice.js';
import { Memory } from './memory.js';
import {
  detectCommand, detectBegin, detectStepCommand, detectListRequest, detectDone, interpretLocally, setGlossary, detectNavigation, findQuestions, parseNumber,
} from './local-nlu.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'mdph-partie-b-v1';
const PREFS_KEY = 'mdph-preferences-v1';
// Réponses, mémoire et transcription gardées sur l'appareil : effacées 7 jours après la dernière activité.
const STORE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const S = {
  schema: null,
  answers: {},
  perQ: {},          // { qid: { history: [{role, text}], draft } }
  currentId: null,
  mode: 'voice',
  finished: false,
  busy: false,
  llmOk: true,
  llmRetryAt: 0,     // après une erreur de l'IA : mode simplifié jusqu'à cette heure, puis on réessaie
  ttsVoices: [],     // voix naturelles (Piper) proposées par le serveur
  returnTo: null,    // question où reprendre après un retour à une question antérieure
  pendingNav: false, // l'assistant attend le numéro de la question à revoir
  keepTop: false,    // arrivée sur un écran : la page reste en haut jusqu'à la première action
  lastSaved: null,   // { qid, extra: [ids de précision] } : dernière réponse enregistrée
  prefilled: {},     // { qid: { facts: [ids], confirmed } } : réponses pré-remplies depuis la mémoire
  confirming: null,  // question pré-remplie dont l'assistant attend la confirmation (oui / non)
  conflicts: [],     // [{ qid, factId }] : information qui contredit une réponse déjà donnée
  resolving: null,   // { qid, factId, next } : l'assistant demande s'il faut changer cette réponse
};

// Mémoire de la conversation (transcription et faits), gardée avec les réponses.
const memory = new Memory();

const prefs = { speak: true, handsfree: true, rate: 0.9 };
// Fixés (non réglables) : voix naturelle féminine, 4 secondes de silence avant la fin de l'écoute.
const VOICE = 'femme';
const SILENCE_MS = 4000;

const speaker = new Speaker();
speaker.onFallback = () => announce('La voix naturelle ne répond pas. La voix du navigateur prend le relais.');
const listener = new Listener({
  onInterim: (t) => { showTranscription(t); scheduleExtract(t); },
  onState: (st) => renderMicState(st),
  onSegment: (t) => {
    if (!S.turn || S.turn.ended) return;
    S.turn.segments.push(t);
    S.turn.lastSegmentAt = performance.now();
    quickEnd(S.turn);
  },
});

// ---------- Stockage ----------
// Réponses (données de santé), mémoire et transcription : localStorage, sur l'appareil seulement,
// pour reprendre après une coupure ou la fermeture de l'onglet. Effacées après STORE_MAX_AGE_MS sans
// activité, ou quand l'usager choisit d'effacer ses réponses. Rien n'est gardé sur le serveur.
// Préférences d'affichage et de voix : localStorage.

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

function save() {
  safe(() => localStorage.setItem(STORE_KEY, JSON.stringify({
    savedAt: Date.now(),
    answers: S.answers, perQ: S.perQ, currentId: S.currentId, finished: S.finished, returnTo: S.returnTo,
    prefilled: S.prefilled, conflicts: S.conflicts, memory,
  })));
}

/** Données enregistrées, si elles ne sont pas trop anciennes. */
function loadStored() {
  // Anciennes versions : réponses dans sessionStorage. On les reprend une fois.
  const old = safe(() => sessionStorage.getItem(STORE_KEY), null);
  if (old) {
    safe(() => sessionStorage.removeItem(STORE_KEY));
    if (!safe(() => localStorage.getItem(STORE_KEY), null)) safe(() => localStorage.setItem(STORE_KEY, old));
  }
  const data = safe(() => JSON.parse(localStorage.getItem(STORE_KEY)), null);
  if (!data || typeof data !== 'object') return null;
  // Sans date (reprise depuis sessionStorage) : considéré comme récent.
  if (data.savedAt && Date.now() - data.savedAt > STORE_MAX_AGE_MS) {
    safe(() => localStorage.removeItem(STORE_KEY));
    return null;
  }
  return data;
}

function restore() {
  const data = loadStored();
  if (!data) return false;
  memory.load(data.memory);
  // Réponses aux questions retirées du formulaire (par exemple l'ancien nom / prénom) : effacées.
  const known = (id) => S.schema.questions.some((q) => q.id === id);
  const keep = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([id]) => known(id)));
  Object.assign(S, {
    answers: keep(data.answers), perQ: keep(data.perQ),
    currentId: known(data.currentId) ? data.currentId : null, finished: !!data.finished,
    returnTo: known(data.returnTo) ? data.returnTo : null,
    prefilled: keep(data.prefilled),
    conflicts: (Array.isArray(data.conflicts) ? data.conflicts : []).filter((c) => known(c?.qid)),
  });
  save();
  // Parcours commencé : au moins une réponse, ou une question déjà posée.
  return Object.keys(S.answers).length > 0 || Boolean(S.currentId);
}

function loadPrefs() {
  const saved = safe(() => JSON.parse(localStorage.getItem(PREFS_KEY)), null) || {};
  for (const key of Object.keys(prefs)) if (key in saved) prefs[key] = saved[key];
  $('pref-speak').checked = prefs.speak;
  $('pref-handsfree').checked = prefs.handsfree;
  // Anciennes vitesses enregistrées (0,75 ; 1,1) : on prend l'option la plus proche.
  const rates = [...$('pref-rate').options].map((o) => Number(o.value));
  prefs.rate = rates.reduce((a, b) => (Math.abs(b - prefs.rate) < Math.abs(a - prefs.rate) ? b : a));
  $('pref-rate').value = String(prefs.rate);
  applyPrefs();
}

function applyPrefs() {
  speaker.enabled = prefs.speak;
  speaker.rate = Number(prefs.rate);
  // Voix naturelle (Piper) seulement si le serveur la propose.
  speaker.engine = S.ttsVoices.includes(VOICE) ? 'piper' : 'browser';
  speaker.piperVoice = VOICE;
  // Écoute automatique : l'écoute s'ouvre seule et se ferme après un silence. Sinon, l'usager
  // l'ouvre avec « Parler » et la ferme avec « J’ai fini de parler ».
  listener.continuous = !prefs.handsfree;
  listener.silenceMs = SILENCE_MS;
  safe(() => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)));
  renderPause();
}

// ---------- Utilitaires ----------

const question = (id) => S.schema.questions.find((q) => q.id === id);
const stateOf = (id) => (S.perQ[id] ||= { history: [], draft: '' });

function visibleQuestions() {
  const vis = computeVisibility(S.schema, S.answers);
  return S.schema.questions.filter((q) => vis[q.id]);
}

/**
 * Les réponses ont changé : les champs de précision apparaissent ou disparaissent dans la question
 * en cours.
 */
function refreshVisibility() {
  if (S.currentId) showQuestion($('form-b'), S.currentId, computeVisibility(S.schema, S.answers));
}

/** Question telle qu'affichée : pour un champ de précision, sa question à choix. */
const topQuestion = (q) => question(rootOf(q.id));

// ---------- Étapes ----------
// Les étapes regroupent les sections du questionnaire (form-b.json) ; la dernière, « Imprimer ou
// enregistrer », est l'écran de fin.

const FIN = 'Imprimer ou enregistrer';
const stepIndexOf = (q) => S.schema.steps.findIndex((st) => st.sections.includes(q.section));
// Questions de l'étape, sans les champs de précision (affichés dans leur question).
const stepQuestions = (i, vis = computeVisibility(S.schema, S.answers)) =>
  S.schema.questions.filter((q) => vis[q.id] && !parentOf(q.id) && stepIndexOf(q) === i);
/**
 * Question complète : répondue, ainsi que ses champs de précision et ses questions de suivi affichés
 * (et les leurs, par exemple l'organisme d'indemnisation sous « demande d'indemnisation »).
 */
/**
 * Total de questions d'une étape, tel qu'affiché (« Question 2 sur N ») : le maximum possible compte
 * tenu des réponses des AUTRES étapes seulement. Les réponses données dans l'étape n'y entrent pas :
 * le total reste fixe pendant toute l'étape (il ne monte ni ne descend en cours de route) ; au pire,
 * l'étape se termine avant ce total (« 5 sur 6 »), jamais après.
 */
function stepTotal(i) {
  const inStep = S.schema.questions.filter((q) => stepIndexOf(q) === i);
  const others = Object.fromEntries(Object.entries(S.answers).filter(([id]) => !inStep.some((q) => q.id === id)));
  return Math.max(stepQuestions(i).length, maxVisible(S.schema, others, inStep.filter((q) => !parentOf(q.id))));
}

const complete = (q, vis) => isAnswered(q, S.answers[q.id])
  && S.schema.questions.every((p) => parentOf(p.id) !== q.id || !vis[p.id] || p.optional || complete(p, vis));
const stepDone = (i, vis) => stepQuestions(i, vis).every((q) => q.optional || complete(q, vis));

/**
 * Indicateur d'étapes : les étapes de questions seulement (« Imprimer ou enregistrer » est une page à
 * part, accessible à tout moment). Dernière étape : pas d'« Étape suivante » (DSFR).
 */
function renderStepper(i) {
  const steps = S.schema.steps;
  const total = steps.length;
  $('etape-titre').textContent = steps[i].title;
  $('etape-etat').textContent = `Étape ${i + 1} sur ${total}`;
  const bar = $('etape-barre');
  bar.dataset.frCurrentStep = i + 1;
  bar.dataset.frSteps = total;
  const last = i === total - 1;
  $('etape-suivante').hidden = last;
  if (!last) $('etape-suivante-titre').textContent = steps[i + 1].title;
}

const srOnly = (text) => Object.assign(document.createElement('span'), { className: 'fr-sr-only', textContent: text });

/** Ce que l'usager dit, affiché pendant et après l'écoute. */
function showTranscription(text) {
  // L'écran « Avant de commencer » a sa propre zone (« on commence »).
  const [zone, span] = $('avant').hidden ? ['transcription', 'transcription-texte'] : ['transcription-avant', 'transcription-avant-texte'];
  $(span).textContent = text || '';
  $(zone).hidden = !text;
}

function setAnswer(qid, value) {
  const q = question(qid);
  if (value === undefined) return;
  if (value === null || (Array.isArray(value) && value.length === 0 && q.type !== 'table' && q.type !== 'multi')) {
    delete S.answers[qid];
  } else {
    S.answers[qid] = value;
  }
  writeValue($('form-b'), q, S.answers[qid] ?? null);
  refreshVisibility();
  save();
}


// Nom des lettres, pour épeler un sigle de la même façon quelle que soit la voix.
const LETTER_NAMES = {
  A: 'a', B: 'bé', C: 'cé', D: 'dé', E: 'e', F: 'effe', G: 'gé', H: 'ache', I: 'i', J: 'ji', K: 'ka', L: 'elle', M: 'emme',
  N: 'enne', O: 'o', P: 'pé', Q: 'cu', R: 'erre', S: 'esse', T: 'té', U: 'u', V: 'vé', W: 'double vé', X: 'ixe', Y: 'i grec', Z: 'zède',
};
const spell = (acronym) => [...acronym].map((c) => LETTER_NAMES[c] || c).join(' ');
const plain = (t) => t.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[’']/g, ' ');

/**
 * Sigles lus en toutes lettres :
 * - « Revenu de solidarité active (RSA) » → « Revenu de solidarité active, erre esse a » ;
 * - sigle seul connu du glossaire : « en ESAT » → « en établissement et service d'aide par le travail, e esse a té »
 *   (seulement épelé si sa forme développée vient d'être dite).
 */
function speakAcronyms(text) {
  const glossary = S.schema?.acronyms || {};
  return text
    .replace(/\s*\(([A-Z]{2,6})\)/g, (_, a) => `, ${spell(a)}`)
    .replace(/\b[A-Z]{2,6}\b/g, (a, offset, whole) => {
      const full = glossary[a];
      if (!full) return a;
      const before = plain(whole.slice(Math.max(0, offset - full.length - 20), offset));
      return before.includes(plain(full)) ? spell(a) : `${full}, ${spell(a)}`;
    });
}

/** Marques d'écriture inclusive (« retraité(e) », « un(e) », « aidant·e ») : la synthèse vocale les lirait. */
const dropInclusive = (text) => text
  .replace(/(?<=\p{L})\((?:e|es|s|ne|le|se|ère|euse|rice|trice)\)/gu, '')
  .replace(/(?<=\p{L})[·•](?:e|es|ne|le|se|ère|euse|rice|trice)(?:[·•]s)?(?!\p{L})/gu, '');

/**
 * Contenu entre parenthèses lu, avec de courtes pauses : « Aides techniques (barre d'appui,
 * déambulateur…) » → « Aides techniques, barre d'appui, déambulateur… ». La forme développée
 * d'un sigle, déjà lue juste avant, n'est pas relue.
 */
function readParentheses(text) {
  return text
    .replace(/\s*\(([^()]*)\)/g, (m, inside, offset, whole) => {
      const content = inside.trim().replace(/\s*\/\s*/g, ' ou ');
      if (!content) return '';
      // Forme développée d'un sigle déjà lue en toutes lettres juste avant : pas de doublon.
      const expansion = Object.values(S.schema?.acronyms || {}).some((full) => plain(full) === plain(content));
      const before = plain(whole.slice(Math.max(0, offset - content.length - 60), offset));
      return expansion && before.includes(plain(content)) ? '' : `, ${content}, `;
    })
    .replace(/,\s*([,;.?!:…\u241E])/g, '$1')
    .replace(/,\s*$/, '')
    .replace(/\s{2,}/g, ' ');
}

// Ordinaux abrégés lus en toutes lettres : « 1re » → « première », « 2e » → « deuxième ».
const ORDINALS = ['', 'premier', 'deuxième', 'troisième', 'quatrième', 'cinquième', 'sixième', 'septième', 'huitième', 'neuvième', 'dixième'];
const readOrdinals = (text) => text
  .replace(/\b1(re|ère)\b/g, 'première')
  .replace(/\b1er\b/g, 'premier')
  .replace(/\b([2-9]|10)(e|ème)\b/g, (m, n) => ORDINALS[Number(n)]);

/** Texte tel qu'il doit être prononcé. */
const speechText = (text) => readParentheses(speakAcronyms(dropInclusive(readOrdinals(text))));

function questionText(q, simple) {
  return simple && q.simple ? q.simple : q.label;
}

const endSentence = (s) => (/[.!?…]$/.test(s) ? s : `${s}.`);
const lowerFirst = (s) => (/^[A-Z]{2}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));

/** Les réponses possibles d'une question à choix, telles qu'elles sont lues. */
function optionsSpeech(q) {
  const opts = q.options.map((o) => o.label);
  // OPTION_BREAK : la voix marque d'un « tic » le passage d'une réponse à l'autre.
  let text = `Les réponses possibles sont : ${OPTION_BREAK} ${opts.join(` ;${OPTION_BREAK} `)}.${OPTION_BREAK}`;
  if (q.type === 'multi') text += ' Vous pouvez donner plusieurs réponses.';
  if (q.allowNone) text += ' Vous pouvez aussi dire : cela ne me concerne pas.';
  return text;
}

/**
 * Question « à réponse libre » (openAnswer : besoins, souhaits) : trop de réponses pour les lire
 * toutes. L'assistant pose la question simple, l'usager répond avec ses mots, l'IA coche les cases ;
 * puis « J'ai noté : … Y a-t-il autre chose ? ». La liste complète n'est lue que sur demande.
 */
function openQuestionSpeech(q) {
  return `${q.simple || q.label} Répondez avec vos mots. Pour entendre toutes les réponses possibles, dites : « lis-moi les réponses ».`;
}

/**
 * Libellé court d'une réponse, pour le résumé oral : sans les exemples entre parenthèses ni le « Pour »
 * répété en tête (« J'ai noté : l'hygiène corporelle ; faire les courses »).
 */
const shortLabel = (q, id) => (q.options.find((o) => o.id === id)?.label || id)
  .replace(/\s*\([^)]*\)/g, '').replace(/^Pour /, '');

function questionSpeech(q, simple) {
  let text = questionText(q, simple);
  // La version simplifiée reformule déjà l'ensemble : on n'y ajoute pas les précisions écrites.
  const plain = !(simple && q.simple);
  if (plain && q.hint) text += ` ${endSentence(q.hint)}`;
  if (q.type === 'table' && plain) {
    const cols = q.columns.map((c) => lowerFirst(c.label));
    text += ` Pour chacun, précisez : ${cols.join(' ; ')}.`;
  } else if (q.type === 'single' || q.type === 'multi') {
    text += ` ${optionsSpeech(q)}`;
  } else if (q.type === 'yesno') {
    text += ' Répondez par oui ou par non.';
  } else if (q.type === 'date') {
    text += ' Dites la date, par exemple : 15 mars 2024.';
  }
  if (q.optional) text += ' Cette question est facultative : vous pouvez dire « passer ».';
  return text;
}

// ---------- Affichage ----------

/** Texte affiché ou mémorisé : sans les marqueurs réservés à la voix. */
const displayText = (text) => text.split(OPTION_BREAK).join('').replace(/\s{2,}/g, ' ').trim();

/**
 * Message de l'usager ou de l'assistant : ajouté à la transcription (mémoire). Message de l'assistant,
 * voix coupée : il est annoncé au lecteur d'écran.
 */
function logMessage(who, text) {
  text = displayText(text);
  memory.addSegment({ role: who === 'usager' ? 'usager' : 'assistant', qid: S.currentId, text });
  save();
  if (who === 'assistant') {
    if (!prefs.speak) announcePolite(text);
  }
}

/** Réponse enregistrée : bandeau sur la question suivante et mise en évidence dans le formulaire. */
function noteSaved(qid, extra = []) {
  S.lastSaved = { qid, extra };
}

function renderSaved(currentId) {
  const saved = S.lastSaved;
  const box = $('derniere-reponse');
  const q = saved && saved.qid !== currentId && question(saved.qid);
  if (!q || !isAnswered(q, S.answers[q.id])) { box.hidden = true; return; }
  const extras = saved.extra.map((id) => S.answers[id]).filter(Boolean);
  const value = [formatValue(q, S.answers[q.id]), ...extras].join(' — ');
  $('derniere-reponse-texte').replaceChildren(
    Object.assign(document.createElement('strong'), { textContent: 'Réponse enregistrée' }),
    ` — ${q.label} : ${value}`,
  );
  box.hidden = false;
}

function announcePolite(text) {
  const zone = $('annonce-assistant');
  zone.textContent = '';
  setTimeout(() => { zone.textContent = text; }, 50);
}

function announce(text) {
  const zone = $('annonce');
  zone.textContent = '';
  setTimeout(() => { zone.textContent = text; }, 50);
}

/**
 * Lecteur de la voix, toujours au même endroit (l'écran ne bouge pas) : un seul bouton dont
 * le libellé suit la lecture. Masqué si la lecture à voix haute est désactivée.
 */
const VOICE_STATES = {
  speaking: ['Lecture en cours…', 'Mettre en pause', 'fr-icon-pause-circle-line'],
  paused: ['Lecture en pause', 'Reprendre', 'fr-icon-play-circle-line'],
  idle: ['Lecture terminée', 'Réécouter la question', 'fr-icon-refresh-line'],
};

function renderPause() {
  const [text, label, icon] = VOICE_STATES[speaker.state];
  // Même lecteur sur l'écran « Avant de commencer », où l'on réécoute la présentation.
  for (const [zone, state, id, idle] of [['zone-voix', 'etat-voix', 'btn-pause', label],
    ['zone-voix-avant', 'etat-voix-avant', 'btn-pause-avant', 'Réécouter la présentation']]) {
    const btn = $(id);
    // Écran des questions : seuls l'état et la pause se masquent ; les réglages restent à côté.
    $(zone).hidden = !(prefs.speak && canSpeak);
    if (id === 'btn-pause') btn.hidden = $(zone).hidden;
    $(state).textContent = text;
    btn.textContent = speaker.state === 'idle' ? idle : label;
    btn.classList.remove(...Object.values(VOICE_STATES).map((v) => v[2]));
    btn.classList.add(icon);
  }
}

function voiceAction() {
  if (speaker.state === 'speaking') speaker.pause();
  else if (speaker.state === 'paused') speaker.resume();
  else if (S.currentId) {
    listener.stop();
    ask(S.currentId);
  }
}

function renderMicState(state) {
  // Bouton « Parler » de l'écran « Avant de commencer » : même libellé et même icône pendant l'écoute.
  const intro = $('btn-parler-avant');
  intro.textContent = state === 'listening' ? 'J’ai fini de parler' : 'Parler';
  intro.classList.toggle('fr-icon-mic-line', state !== 'listening');
  intro.classList.toggle('fr-icon-check-line', state === 'listening');
  if (state === 'listening') hideMicErrors();
  const btn = $('btn-mic');
  const status = $('etat-micro');
  // Pendant l'écoute : bouton secondaire, icône et texte différents (pas la couleur seule).
  btn.classList.toggle('fr-btn--secondary', state === 'listening');
  if (state === 'listening') {
    // Le bouton termine l'écoute en gardant ce qui a été dit.
    btn.textContent = 'J’ai fini de parler';
    btn.classList.replace('fr-icon-mic-line', 'fr-icon-check-line');
    status.textContent = prefs.handsfree
      ? 'Écoute en cours…'
      : 'Écoute en cours… Appuyez sur « J’ai fini de parler » quand vous avez terminé.';
  } else {
    btn.textContent = 'Parler';
    btn.classList.replace('fr-icon-check-line', 'fr-icon-mic-line');
    // Pendant la lecture, le message ne parle que du micro : la voix a sa propre zone.
    if (state === 'speaking') status.textContent = canListen ? 'Appuyez sur « Parler » pour répondre.' : '';
    else if (state === 'thinking') status.textContent = 'L’assistant réfléchit…';
    else if (state === 'nothing') status.textContent = 'Je n’ai rien entendu. Appuyez sur « Parler » pour réessayer.';
    else status.textContent = '';
  }
  renderPause();
}


/**
 * Affiche la question en cours : son bloc du formulaire (seul visible), sa position dans l'étape,
 * l'indicateur d'étapes, le menu et les retours (réponse enregistrée, étape terminée).
 * `focus` : l'usager vient de naviguer (bouton, menu) ; le focus va sur le titre de la question.
 */
function renderCard(q, simple = false, currentOption = null, { focus = false } = {}) {
  const top = topQuestion(q);
  const i = stepIndexOf(q);
  const inStep = stepQuestions(i);
  const pos = inStep.findIndex((x) => x.id === top.id) + 1;
  const total = stepTotal(i);
  if (!$('espace').hidden) document.title = `${S.schema.steps[i].title}, question ${pos} sur ${total} - ${SITE}`;
  $('question-numero').textContent = `Question ${pos} sur ${total}`
    + (currentOption != null ? ` · proposition ${currentOption + 1} sur ${q.options.length}` : '');
  const vis = computeVisibility(S.schema, S.answers);
  showQuestion($('form-b'), q.id, vis);
  // Champ de précision : on reste sur sa question, le focus va dans le champ à remplir. Question de
  // suivi : même carte, le focus va sur son titre.
  const title = top === q || isFollowUp(q.id) ? $(`titre-${q.id}`) : $(`field-${q.id}`);
  renderStepper(i);
  renderSaved(q.id);
  const pre = S.prefilled[q.id];
  $('prerempli').hidden = !(pre && !pre.confirmed && isAnswered(q, S.answers[q.id]));
  const end = S.stepEnd?.qid === q.id;
  $('fin-etape').hidden = !end;
  if (end) {
    // Étape complète : succès (vert). Questions sans réponse : avertissement (orange). Le type est
    // aussi donné en texte aux lecteurs d'écran (DSFR : « succès », « attention »).
    const ok = S.stepEnd.complete;
    $('fin-etape').classList.toggle('fr-alert--success', ok);
    $('fin-etape').classList.toggle('fr-alert--warning', !ok);
    $('fin-etape-texte').replaceChildren(srOnly(ok ? 'Succès : ' : 'Attention : '), S.stepEnd.text);
  }
  const order = S.schema.questions;
  const hasNext = S.review
    ? Boolean(pendingInCard(q)) || unanswered().some((x) => x.id !== q.id && topQuestion(x).id !== top.id)
    // Une question de suivi ou un champ de précision encore vide compte aussi : on ne propose
    // « Terminer » que s'il ne reste vraiment rien à remplir.
    : order.slice(order.indexOf(q) + 1).some((x) => vis[x.id] && (!parentOf(x.id) || !isAnswered(x, S.answers[x.id])));
  $('btn-suivant').textContent = hasNext ? 'Question suivante' : 'Terminer';
  // Pas de question précédente sur la toute première question visible.
  const firstVisible = order.find((x) => vis[x.id] && !parentOf(x.id));
  $('li-precedent').hidden = top.id === firstVisible?.id;
  // Boutons d'étape : libellé court ; la destination est donnée aux lecteurs d'écran (et affichée par
  // l'indicateur d'étapes pour l'étape suivante). Pas d'étape précédente à la première.
  const steps = S.schema.steps;
  $('btn-etape-prec').hidden = i === 0;
  if (i > 0) $('btn-etape-prec-dest').textContent = ` : ${steps[i - 1].title}`;
  // Dernière étape : à la place d'« Étape suivante », le même bouton mène à « Imprimer ou enregistrer »
  // (page à part, hors de l'indicateur d'étapes).
  const last = i === steps.length - 1;
  $('btn-etape-suiv-libelle').textContent = last ? FIN : 'Étape suivante';
  $('btn-etape-suiv-dest').textContent = last ? '' : ` : ${steps[i + 1].title}`;
  if (focus) title.focus();
  // Question de suivi posée dans la même carte (à la voix ou au clavier) : la page la montre.
  else if (isFollowUp(q.id) && !S.keepTop) $(`q-${q.id}`).scrollIntoView({ block: 'nearest' });
}

// ---------- Déroulé de la conversation ----------

async function say(text) {
  // Retour à l'accueil pendant une lecture : la suite du parcours ne doit pas parler.
  if (!text || !$('accueil').hidden) return;
  if (prefs.speak && canSpeak) renderMicState('speaking');
  await speaker.speak(speechText(text));
  if (!listener.active) renderMicState('idle');
}

async function ask(qid, { intro = '', focus = false } = {}) {
  const q = question(qid);
  S.confirming = null;
  S.resolving = null;
  // Contradiction avec une réponse déjà donnée : vérifiée avant la question suivante.
  const vis = computeVisibility(S.schema, S.answers);
  S.conflicts = S.conflicts.filter((c) => vis[c.qid] && isAnswered(question(c.qid), S.answers[c.qid]));
  const conflict = S.conflicts.find((c) => c.qid !== qid);
  if (conflict) {
    S.conflicts = S.conflicts.filter((c) => c !== conflict);
    return askConflict(conflict, qid, { intro });
  }
  // Déjà dit plus tôt dans la conversation : réponse pré-remplie, l'usager la confirme d'un mot.
  const prefill = !isAnswered(q, S.answers[qid]) && prefillFromMemory(q);
  if (prefill) return askPrefilled(q, prefill, { intro, focus });
  if (q.oneByOne) {
    const st = stateOf(qid);
    // On arrive d'une autre question : on repart de la première proposition.
    if (S.currentId !== qid || st.step == null) st.step = 0;
    S.currentId = qid;
    const start = st.step === 0
      ? `${questionText(q)} Je vais vous lire ${q.options.length} propositions, une par une. Répondez oui ou non à chacune.`
      : '';
    return askOption(q, st.step, { intro: [intro, start].filter(Boolean).join(' ') });
  }
  if (qid !== S.currentId) { showTranscription(''); S.more = null; }
  if (S.notes?.qid !== qid) S.notes = { qid, count: 0 };
  S.currentId = qid;
  renderMemoryNotes();
  save();
  renderCard(q, false, null, { focus });
  // Question de suivi : on reste sur la même question (même numéro, même carte), on le dit.
  if (isFollowUp(qid) && !intro) intro = 'Encore une question sur ce point.';
  const speech = q.openAnswer ? openQuestionSpeech(q) : questionSpeech(q);
  let text = intro ? `${intro} ${speech}` : speech;
  const current = isAnswered(q, S.answers[qid])
    ? `Votre réponse actuelle est : ${formatValue(q, S.answers[qid])}. Dites « suivante » pour la garder.` : '';
  if (current) text += ` ${current}`;
  // Question à réponse libre déjà remplie : ce qui sera dit maintenant s'ajoute à la réponse.
  if (q.openAnswer && current) S.more = qid;
  logMessage('assistant', text);
  await say(text);
  if (S.currentId === qid) maybeListen();
}

// ---------- Réponses pré-remplies depuis la mémoire (« le dire une fois ») ----------

/** Valeur qu'on peut tirer des faits en mémoire pour `q` (le plus récent l'emporte), ou null. */
function prefillFromMemory(q) {
  if (q.type === 'table') return null;
  const facts = memory.activeFactsFor(q.id);
  if (!facts.length) return null;
  const last = facts.at(-1);
  let value;
  switch (q.type) {
    case 'single': value = last.selected?.[0]; break;
    case 'multi': {
      const ids = new Set(facts.flatMap((f) => f.selected || []));
      value = ids.size ? q.options.map((o) => o.id).filter((id) => ids.has(id))
        : (q.allowNone && facts.some((f) => f.none_apply) ? [NONE] : undefined);
      break;
    }
    case 'yesno': value = last.yes_no || undefined; break;
    case 'date': value = last.date && !dateError(q, last.date) ? last.date : undefined; break;
    case 'number': value = last.number ?? undefined; break;
    default: value = last.text || undefined;
  }
  // Seuls les faits qui ont servi à la valeur seront confirmés ou refusés.
  const used = q.type === 'multi' ? facts : [last];
  return value === undefined || !isAnswered(q, value) ? null : { value, facts: used };
}

/**
 * Question déjà renseignée par la conversation : la réponse est cochée, l'assistant rappelle ce que
 * l'usager a dit et demande une simple confirmation. « Non » : la question est posée en entier.
 */
async function askPrefilled(q, { value, facts }, { intro = '', focus = false } = {}) {
  if (q.id !== S.currentId) { showTranscription(''); S.more = null; }
  if (S.notes?.qid !== q.id) S.notes = { qid: q.id, count: 0 };
  if (q.oneByOne) stateOf(q.id).step = null;
  S.currentId = q.id;
  S.prefilled[q.id] = { facts: facts.map((f) => f.id), confirmed: false };
  S.confirming = q.id;
  setAnswer(q.id, value);
  // Question à réponse libre : ce que l'usager ajoute s'ajoute à la réponse pré-remplie.
  if (q.openAnswer) S.more = q.id;
  renderMemoryNotes();
  save();
  renderCard(q, false, null, { focus });
  if (isFollowUp(q.id) && !intro) intro = 'Encore une question sur ce point.';
  const said = [...new Set(facts.map((f) => f.quote).filter(Boolean))];
  const quotes = said.map((t) => `« ${t} »`).join(' et ');
  // Ce qui a été dit est aussi affiché (« Vous avez dit : … »), pas seulement lu à voix haute.
  if (said.length) showTranscription(said.join(' … '));
  const text = [intro, endSentence(questionText(q)),
    quotes ? `Vous m’avez déjà dit : ${quotes}.` : 'Vous me l’avez déjà dit.',
    `J’ai donc noté : ${formatValue(q, value)}. Est-ce bien cela ? Répondez oui ou non.`].filter(Boolean).join(' ');
  logMessage('assistant', text);
  await say(text);
  if (S.currentId === q.id) maybeListen();
}

/** « Oui » : la réponse pré-remplie est gardée et les faits qui l'ont donnée sont confirmés. */
async function confirmPrefill(q, ack = 'Merci, c’est confirmé.') {
  settlePrefill(q.id, true);
  noteSaved(q.id);
  logMessage('assistant', ack);
  await say(ack);
  return nextAfterRecap(q, ack);
}

/** « Non » : la réponse pré-remplie est retirée et la question est posée en entier. */
function rejectPrefill(q) {
  settlePrefill(q.id, false);
  setAnswer(q.id, null);
  return ask(q.id, { intro: 'D’accord, je retire cette réponse.' });
}

/** Fin de la confirmation : faits confirmés ou refusés, la question n'est plus « à vérifier ». */
function settlePrefill(qid, confirmed) {
  const p = S.prefilled[qid];
  if (S.confirming === qid) S.confirming = null;
  if (!p) return;
  for (const id of p.facts) memory.setStatus(id, confirmed ? 'confirmed' : 'rejected');
  if (confirmed) p.confirmed = true;
  else delete S.prefilled[qid];
  save();
}

function maybeListen() {
  if (S.mode !== 'voice' || !canListen || S.finished || S.busy || $('espace').hidden) return;
  if (prefs.handsfree) startListening();
  else $('etat-micro').textContent = 'Appuyez sur « Parler » pour répondre.';
}

/**
 * Micro en erreur : alerte DSFR « erreur » (role="alert"), avec la solution. Elle reste affichée
 * jusqu'à la prochaine écoute réussie : elle ne disparaît pas sans action de l'usager.
 * `where` : 'question' (écran des questions) ou 'avant' (écran « Avant de commencer »).
 */
function showMicError(where, blocked) {
  const [box, span] = where === 'avant' ? ['erreur-micro-avant', 'erreur-micro-avant-texte'] : ['erreur-micro', 'erreur-micro-texte'];
  const cause = blocked ? 'le micro est bloqué par votre navigateur.' : 'le micro ne fonctionne pas pour le moment.';
  const solution = where === 'avant'
    ? `Appuyez sur « ${startLabel()} » : vous pourrez répondre en cochant une réponse ou en écrivant.`
    : 'Répondez directement dans la question, en cochant une réponse ou en écrivant.';
  const retry = blocked
    ? ' Pour utiliser le micro, autorisez-le dans les réglages de votre navigateur, puis appuyez sur « Parler ».'
    : '';
  $(box).hidden = false;
  // Texte écrit après l'affichage, pour que les lecteurs d'écran annoncent l'alerte.
  $(span).textContent = '';
  setTimeout(() => { $(span).textContent = `Erreur : ${cause} ${solution}${retry}`; }, 50);
}

function hideMicErrors() {
  for (const id of ['erreur-micro', 'erreur-micro-avant']) $(id).hidden = true;
}

async function startListening() {
  speaker.stop();
  const turn = startTurn(S.currentId);
  let text;
  try {
    text = await listener.listen();
  } catch (err) {
    const blocked = err.message === 'not-allowed' || err.message === 'service-not-allowed';
    $('etat-micro').textContent = '';
    showMicError('question', blocked);
    if (blocked) S.mode = 'keyboard';
    return;
  }
  finally {
    endTurn(turn);
    // Panneau de débogage : silence attendu entre le dernier mot et la fin de l'écoute.
    if (turn.lastSegmentAt) logCall('fin de réponse', turn.lastSegmentAt, null, turn.quick ? 'oui / non : fin rapide' : 'silence habituel');
  }
  if (text === null) return; // écoute annulée
  if (!text) { renderMicState('nothing'); return; }
  await handleUtterance(text, turn);
}

// ---------- Remplissage pendant que l'usager parle ----------
// Pendant l'écoute, le texte entendu (même provisoire) part à /api/extract au plus toutes les
// EXTRACT_EVERY_MS, dès qu'il contient au moins EXTRACT_MIN_WORDS mots nouveaux : la question en cours
// se coche à l'écran et les informations pour d'autres questions vont dans la mémoire. Un seul appel
// à la fois ; ce qui est dit entre-temps part avec l'appel suivant. Ce qui reste à la fin de la
// réponse part avec /api/interpret : une réponse courte ne coûte aucun appel de plus.

const EXTRACT_EVERY_MS = 2000;
const EXTRACT_MIN_WORDS = 4;
let turnSeq = 0;

function startTurn(qid) {
  S.turn = {
    id: ++turnSeq, qid, segments: [], text: '', extractedText: '', timer: null, inFlight: false, ended: false, live: null,
  };
  return S.turn;
}

function endTurn(turn) {
  turn.ended = true;
  clearTimeout(turn.timer);
  turn.timer = null;
}

/** Questions remplies en direct : pas les tableaux ni les propositions lues une par une. */
const liveExtraction = (q) => Boolean(q) && !q.oneByOne && q.type !== 'table' && llmAvailable();

const wordCount = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);

/**
 * Partie de `text` pas encore envoyée à l'IA. Le navigateur peut corriger des mots déjà affichés :
 * on repart alors du dernier mot commun avec ce qui a été envoyé.
 */
function unsent(turn, text) {
  const sent = turn.extractedText;
  let i = 0;
  while (i < sent.length && i < text.length && sent[i] === text[i]) i++;
  if (i < sent.length) i = text.lastIndexOf(' ', i) + 1; // mot modifié : repris en entier
  return text.slice(i).trim();
}

/** Texte entendu (provisoire) : extraction programmée, au plus une fois toutes les EXTRACT_EVERY_MS. */
function scheduleExtract(text) {
  const turn = S.turn;
  if (!turn || turn.ended) return;
  turn.text = text;
  if (turn.timer || turn.inFlight) return; // déjà prévue : elle prendra le texte le plus récent
  // EXTRACT_EVERY_MS entre deux envois : tout de suite si l'envoi précédent est déjà assez ancien.
  const wait = turn.sentAt ? Math.max(0, EXTRACT_EVERY_MS - (performance.now() - turn.sentAt)) : EXTRACT_EVERY_MS;
  turn.timer = setTimeout(() => { turn.timer = null; extractPending(turn); }, wait);
}

async function extractPending(turn) {
  if (turn !== S.turn || turn.ended || turn.inFlight) return;
  const q = question(turn.qid);
  if (!liveExtraction(q) || S.pendingNav || S.resolving) return;
  const text = turn.text;
  const segment = unsent(turn, text);
  if (wordCount(segment) < EXTRACT_MIN_WORDS) return;
  // Commande (« question suivante », « revenir à… ») : rien à extraire.
  if (detectCommand(segment) || detectStepCommand(segment) || detectNavigation(segment)) return;
  const before = turn.extractedText;
  turn.extractedText = text;
  turn.inFlight = true;
  const t0 = performance.now();
  turn.sentAt = t0;
  try {
    const res = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question_id: q.id,
        segment,
        turn_text: text,
        memoire: memory.compact(),
        concerne: S.answers.concerne ?? null,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = await res.json();
    logCall('extract', t0, r, segment);
    // Les faits sont gardés même si la réponse s'est terminée entre-temps.
    rememberFacts(r.facts);
    // La valeur provisoire, elle, n'est affichée que tant que l'usager parle encore.
    if (!turn.ended && S.turn === turn && S.currentId === q.id) showLive(q, r.current, turn);
  } catch (err) {
    logCall('extract', t0, null, segment, err);
    // Échec : ce texte partira avec /api/interpret à la fin de la réponse.
    if (!turn.ended) turn.extractedText = before;
  } finally {
    turn.inFlight = false;
    // L'usager a continué de parler pendant l'appel : extraction suivante.
    if (!turn.ended && turn.text !== turn.extractedText) scheduleExtract(turn.text);
  }
}

/**
 * Réponse provisoire de la question en cours, affichée dans le formulaire sans être enregistrée :
 * /api/interpret, à la fin de la réponse, décide de la valeur gardée. Pas d'annonce au lecteur
 * d'écran pendant l'écoute : le micro l'entendrait ; la réponse est confirmée à la fin.
 */
function showLive(q, r, turn) {
  let value = valueFromResult(q, r);
  if (value === undefined || (q.type === 'date' && dateError(q, value))) return;
  // Question à réponse libre déjà remplie : ce qui est dit s'ajoute (comme à la fin de la réponse).
  if (q.openAnswer && S.more === q.id && Array.isArray(value)) {
    const before = (Array.isArray(S.answers[q.id]) ? S.answers[q.id] : []).filter((id) => id !== NONE);
    value = q.options.map((o) => o.id).filter((id) => before.includes(id) || value.includes(id));
  }
  writeValue($('form-b'), q, value);
  turn.live = value;
}

/** Fin de la réponse : le formulaire affiche de nouveau les réponses enregistrées. */
function clearLive(turn, q) {
  if (turn?.live == null) return;
  turn.live = null;
  writeValue($('form-b'), q, S.answers[q.id] ?? null);
}

/** Faits renvoyés par le serveur (déjà vérifiés) : ajoutés à la mémoire, puis enregistrés. */
function rememberFacts(facts) {
  const added = memory.addFacts(facts);
  if (!added.length) return;
  for (const f of added) checkConflict(f);
  if (S.notes?.qid === S.currentId) S.notes.count += added.filter((f) => f.qid !== S.currentId).length;
  renderMemoryNotes();
  save();
}

/**
 * Nouvelle information sur une question déjà répondue. Si elle contredit la réponse :
 * - réponse pré-remplie pas encore confirmée : remplacée tout de suite (c'est encore une proposition) ;
 * - réponse donnée ou confirmée par l'usager : jamais changée sans lui ; l'assistant lui demandera,
 *   avant la question suivante (voir ask), s'il faut la changer.
 * Les réponses écrites (texte libre) ne sont pas comparées : une autre formulation n'est pas une contradiction.
 */
function checkConflict(fact) {
  const q = fact.qid && question(fact.qid);
  if (!q || fact.qid === S.currentId || ['text', 'longtext', 'table'].includes(q.type)) return;
  const current = S.answers[q.id];
  if (!isAnswered(q, current)) return;
  const value = valueOfFact(q, fact);
  if (value === undefined || agrees(q, current, value)) return;
  const pre = S.prefilled[q.id];
  if (pre && !pre.confirmed) {
    for (const old of memory.activeFactsFor(q.id)) if (old.id !== fact.id) memory.setStatus(old.id, 'superseded');
    const next = prefillFromMemory(q);
    if (next) { setAnswer(q.id, next.value); pre.facts = next.facts.map((f) => f.id); }
    return;
  }
  S.conflicts = S.conflicts.filter((c) => c.qid !== q.id).concat({ qid: q.id, factId: fact.id });
}

/** Valeur d'un seul fait pour la question `q` (même lecture que le pré-remplissage). */
function valueOfFact(q, fact) {
  switch (q.type) {
    case 'single': return fact.selected?.[0];
    case 'multi': return fact.selected?.length ? fact.selected : (fact.none_apply ? [NONE] : undefined);
    case 'yesno': return fact.yes_no || undefined;
    case 'date': return fact.date || undefined;
    case 'number': return fact.number ?? undefined;
    default: return undefined;
  }
}

/** La réponse donnée et l'information nouvelle disent-elles la même chose ? (choix multiple : incluse) */
function agrees(q, current, value) {
  if (q.type === 'multi') {
    const have = Array.isArray(current) ? current : [];
    return value.every((id) => have.includes(id)) && !(have.includes(NONE) && !value.includes(NONE));
  }
  return JSON.stringify(current) === JSON.stringify(value);
}

/**
 * Avant de poser une question : s'il y a une contradiction en attente, l'assistant la signale d'abord
 * (sur la question concernée, avec sa réponse affichée) et demande s'il faut changer la réponse.
 */
async function askConflict(c, next, { intro = '' } = {}) {
  const q = question(c.qid);
  const fact = memory.facts.find((f) => f.id === c.factId);
  S.resolving = { ...c, next };
  S.confirming = null;
  if (q.id !== S.currentId) { S.more = null; }
  S.currentId = q.id;
  save();
  renderCard(q);
  if (fact?.quote) showTranscription(fact.quote);
  const text = [intro, `Une vérification sur la question « ${q.short} ».`,
    `Vous aviez répondu : ${formatValue(q, S.answers[q.id])}.`,
    fact?.quote ? `Mais vous venez de dire : « ${fact.quote} ».` : '',
    'Voulez-vous changer cette réponse ? Répondez oui ou non.'].filter(Boolean).join(' ');
  logMessage('assistant', text);
  await say(text);
  if (S.currentId === q.id && S.resolving) maybeListen();
}

/**
 * Réponse à la vérification. Oui : l'ancienne réponse est retirée et la question est reposée,
 * pré-remplie avec la nouvelle information (l'usager la confirme ou la corrige), puis on reprend
 * où on en était. Non : l'information nouvelle est écartée.
 */
function resolveConflict(change) {
  const { qid, factId, next } = S.resolving;
  S.resolving = null;
  if (!change) {
    memory.setStatus(factId, 'rejected');
    save();
    return ask(next, { intro: 'D’accord, je garde votre réponse.' });
  }
  for (const old of memory.activeFactsFor(qid)) if (old.id !== factId) memory.setStatus(old.id, 'superseded');
  delete S.prefilled[qid];
  setAnswer(qid, null);
  if (!S.returnTo && next !== qid) S.returnTo = next;
  save();
  return ask(qid, { intro: 'D’accord.' });
}

/** Sous la question : combien d'informations ont été notées pour d'autres questions pendant celle-ci. */
function renderMemoryNotes() {
  const n = S.notes?.qid === S.currentId ? S.notes.count : 0;
  $('memoire-notes').hidden = !n;
  $('memoire-notes').textContent = n === 1
    ? 'J’ai noté une information pour une autre question.'
    : `J’ai noté ${n} informations pour d’autres questions.`;
}

/**
 * Fin de réponse plus rapide quand on attend un oui ou un non (question oui / non, confirmation d'une
 * réponse pré-remplie, vérification d'une contradiction) et que l'usager l'a clairement dit en peu de
 * mots : 1,5 seconde de silence au lieu de 4. Détection locale, sans appel à l'IA.
 */
const QUICK_END_MS = 1500;
function quickEnd(turn) {
  const q = question(turn.qid);
  const expectsYesNo = S.confirming === q.id || S.resolving?.qid === q.id || (q.type === 'yesno' && !q.oneByOne);
  const said = turn.segments.join(' ');
  if (!expectsYesNo || said.trim().split(/\s+/).length > 4) return;
  const yn = interpretLocally({ id: q.id, type: 'yesno', label: q.label }, said, stateOf(q.id)).yes_no;
  if (yn !== 'oui' && yn !== 'non') return;
  turn.quick = true;
  listener.shorten(QUICK_END_MS);
}

// Appels à l'IA (pour le panneau de débogage de la mémoire) : les 50 derniers, pas enregistrés.
const calls = [];
function logCall(kind, t0, r, text, err) {
  calls.unshift({
    kind, at: new Date().toISOString(), ms: Math.round(performance.now() - t0), text,
    kept: r?.facts?.length ?? 0, rejected: r?.rejected || [], error: err ? String(err.message || err) : null,
  });
  calls.length = Math.min(calls.length, 50);
  onCallLogged?.();
}
let onCallLogged = null;

async function callInterpret(q, text, pending = '') {
  const st = stateOf(q.id);
  const res = await fetch('/api/interpret', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question_id: q.id,
      option_id: q.oneByOne ? q.options[stateOf(q.id).step ?? 0].id : undefined,
      utterance: text,
      history: st.history.slice(0, -1),
      draft: st.draft,
      current_value: S.answers[q.id] ?? null,
      concerne: S.answers.concerne ?? null,
      memoire: memory.compact(),
      pending,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// L'IA est utilisée si elle est configurée sur le serveur, sauf juste après une erreur :
// on passe alors en mode simplifié (mots-clés) pendant 20 secondes, puis on la réessaie.
const LLM_RETRY_MS = 20000;
const llmAvailable = () => S.llmOk && Date.now() >= S.llmRetryAt;

/** Bandeau « mode simplifié », visible tant que l'IA ne répond pas. */
function setDegraded(on) {
  const wasOn = !$('alerte-simplifie').hidden;
  $('alerte-simplifie').hidden = !on;
  if (on && !wasOn) {
    const msg = 'L’assistant fonctionne en mode simplifié : il comprend moins bien les phrases. Choisissez de préférence parmi les réponses proposées.';
    logMessage('assistant', msg);
    announce(msg);
  }
}

function llmFailed() {
  S.llmRetryAt = Date.now() + LLM_RETRY_MS;
  setDegraded(true);
}

async function handleUtterance(text, turn = null) {
  if (S.busy || !S.currentId) return;
  S.keepTop = false; // l'usager a répondu : le formulaire peut suivre la question en cours
  const q = question(S.currentId);
  const st = stateOf(q.id);
  showTranscription(text);
  logMessage('usager', text);
  st.history.push({ role: 'usager', text });
  // Vérification d'une contradiction : oui (changer) ou non (garder).
  if (S.resolving?.qid === q.id && !S.pendingNav && !detectStepCommand(text) && !detectNavigation(text)) {
    clearLive(turn, q);
    const yn = interpretLocally({ id: q.id, type: 'yesno', label: q.label }, text, st).yes_no;
    if (yn === 'oui' || yn === 'non') return resolveConflict(yn === 'oui');
    const again = 'Je n’ai pas compris. Voulez-vous changer cette réponse ? Répondez oui ou non.';
    logMessage('assistant', again);
    await say(again);
    return maybeListen();
  }

  // Réponse pré-remplie à confirmer : « oui » la garde, « non » seul pose la question en entier.
  // Vérifié avant les commandes : sur une question à réponse libre, « non » veut aussi dire « c'est
  // tout ». Une phrase plus longue (« non, je vis en couple ») est une correction : l'IA l'interprète,
  // avec la réponse pré-remplie comme réponse actuelle.
  if (S.confirming === q.id && !S.pendingNav && !detectStepCommand(text) && !detectNavigation(text)) {
    const yn = interpretLocally({ id: q.id, type: 'yesno', label: q.label }, text, st).yes_no;
    const words = text.trim().split(/\s+/).length;
    if (yn === 'oui' && words <= 6) {
      clearLive(turn, q);
      return confirmPrefill(q);
    }
    if ((yn === 'non' && words <= 3) || q.oneByOne) {
      clearLive(turn, q);
      return rejectPrefill(q);
    }
    if (q.openAnswer && detectDone(text)) {
      clearLive(turn, q);
      return confirmPrefill(q);
    }
  }
  // Commande traitée sans l'IA : la réponse provisoire affichée pendant l'écoute est retirée tout de
  // suite. Sinon, elle reste affichée jusqu'à la réponse de l'IA (pas de clignotement).
  const local = S.pendingNav || detectStepCommand(text) || detectNavigation(text)
    || (q.openAnswer && (detectListRequest(text) || (S.more === q.id && detectDone(text))));
  if (local) clearLive(turn, q);

  // Retour à une question précise : « revenir à la question 5 », « … à la question sur le logement ».
  if (S.pendingNav) {
    S.pendingNav = false;
    const number = parseNumber(text);
    if (number && text.split(/\s+/).length <= 4) return goToQuestion({ number }, text);
  }
  // « Étape suivante / précédente » : avant la recherche d'une question, car « revenir à l'étape
  // précédente » ressemble à « revenir à la question sur… ».
  const step = detectStepCommand(text);
  if (step) return goStep(step === 'next' ? 1 : -1);
  const nav = detectNavigation(text);
  if (nav) return goToQuestion(nav, text);

  // Question à réponse libre : « lis-moi les réponses » lit la liste ; « c'est tout » passe à la suite.
  if (q.openAnswer && detectListRequest(text)) {
    const list = optionsSpeech(q);
    logMessage('assistant', list);
    await say(list);
    return maybeListen();
  }
  if (q.openAnswer && S.more === q.id && detectDone(text)) {
    S.more = null;
    st.history = [];
    save();
    return goNext();
  }

  // Question « une proposition à la fois » : sans IA, on interprète un oui / non sur la proposition lue.
  const lq = q.oneByOne ? { id: q.id, type: 'yesno', label: q.options[st.step ?? 0].label } : q;
  let r;
  const cmd = detectCommand(text);
  if (cmd) {
    r = interpretLocally(lq, text, st);
  } else if (llmAvailable()) {
    S.busy = true;
    renderMicState('thinking');
    // Morceaux pas encore passés par /api/extract : leurs informations sont extraites maintenant.
    const pending = turn ? unsent(turn, text) : '';
    const t0 = performance.now();
    try {
      r = await callInterpret(q, text, pending);
      logCall('interpret', t0, r, text);
      rememberFacts(r.facts);
      setDegraded(false);
    } catch (err) {
      logCall('interpret', t0, null, text, err);
      llmFailed();
      r = interpretLocally(lq, text, st);
    } finally {
      S.busy = false;
      renderMicState('idle');
    }
  } else {
    r = interpretLocally(lq, text, st);
  }
  clearLive(turn, q);
  // Correction d'une réponse pré-remplie : la nouvelle valeur confirme les faits si elle est la même,
  // sinon ils sont refusés (l'usager a corrigé).
  if (S.confirming === q.id) {
    const value = valueFromResult(q, r);
    const same = JSON.stringify(value) === JSON.stringify(S.answers[q.id]);
    if (value !== undefined) settlePrefill(q.id, same);
    // Corrigée : la réponse pré-remplie ne s'ajoute pas à la nouvelle (question à réponse libre).
    if (value !== undefined && !same) { setAnswer(q.id, null); S.more = null; }
  }
  await (q.oneByOne ? applyOptionResult(q, r) : applyResult(q, r));
}

function valueFromResult(q, r) {
  switch (q.type) {
    case 'single': return r.selected[0];
    case 'multi': return r.none_apply ? [NONE] : (r.selected.length ? r.selected : undefined);
    case 'yesno': return r.yes_no || undefined;
    case 'date': return r.date || undefined;
    case 'number': return r.number ?? undefined;
    case 'table': return r.none_apply ? [] : (r.rows.length ? r.rows : undefined);
    default: return r.text || undefined;
  }
}

async function applyResult(q, r) {
  const st = stateOf(q.id);
  const reply = async (message) => {
    if (!message) return;
    st.history.push({ role: 'assistant', text: displayText(message) });
    logMessage('assistant', message);
    await say(message);
  };

  switch (r.intent) {
    case 'repeat': return ask(q.id);
    case 'back': return goPrev();
    case 'next_step': return goStep(1);
    case 'prev_step': return goStep(-1);
    case 'list': {
      const list = q.options ? optionsSpeech(q) : questionSpeech(q);
      logMessage('assistant', list);
      await say(list);
      return maybeListen();
    }
    case 'next': {
      // « C'est tout, passons à la suite » : ce qui est dit dans la même phrase est enregistré, puis
      // question suivante. Question à réponse libre : s'ajoute aux réponses déjà données.
      let value = valueFromResult(q, r);
      if (q.openAnswer && Array.isArray(value)) {
        const before = (Array.isArray(S.answers[q.id]) ? S.answers[q.id] : []).filter((id) => id !== NONE);
        value = value[0] === NONE ? (before.length || S.more === q.id ? undefined : value)
          : q.options.map((o) => o.id).filter((id) => before.includes(id) || value.includes(id));
      }
      if (value !== undefined && !(q.type === 'date' && dateError(q, value))) setAnswer(q.id, value);
      const precisions = fillPrecisions(q, r);
      if (value !== undefined || precisions.length) noteSaved(q.id, precisions);
      S.more = null;
      st.history = [];
      st.draft = '';
      save();
      await reply(r.message);
      return nextAfterRecap(q, r.message, precisions);
    }
    case 'goto': return goToQuestion({ target: r.navigation || '' }, lastUserText(q));
    case 'finish': return finish();
    case 'skip':
      await reply(r.message);
      return nextAfterRecap(q, r.message);
    case 'pause':
      await reply(r.message || 'D’accord, on fait une pause. Vos réponses sont gardées. Appuyez sur « Parler » pour reprendre.');
      return;
    case 'help': {
      // La reformulation est lue ; l'intitulé affiché reste celui du Cerfa (version simple dans l'infobulle).
      await reply(r.message || `Je reformule. ${questionSpeech(q, true)}`);
      save();
      return maybeListen();
    }
    default: {
      // Date impossible pour cette question (par exemple dans le futur) : on ne l'enregistre
      // pas et on continue le dialogue jusqu'à obtenir une date correcte.
      const invalid = r.date && dateError(q, r.date);
      if (invalid) {
        save();
        await reply(`Vous avez dit le ${r.date}. ${invalid} Pouvez-vous redire la date ?`);
        return maybeListen();
      }
      // Question à réponse libre : les réponses s'ajoutent à celles déjà données, puis « autre chose ? ».
      if (q.openAnswer && r.complete && !r.awaiting_validation) {
        if (r.none_apply) {
          // « Rien » au premier passage : « Cela ne me concerne pas » ; après « autre chose ? » : c'est tout.
          if (S.more !== q.id) { setAnswer(q.id, [NONE]); noteSaved(q.id); }
          S.more = null;
          st.history = [];
          save();
          if (S.answers[q.id]?.[0] === NONE) await reply(r.message || 'C’est noté.');
          return nextAfterRecap(q, r.message);
        }
        if (r.selected?.length) {
          const before = (Array.isArray(S.answers[q.id]) ? S.answers[q.id] : []).filter((id) => id !== NONE);
          const merged = q.options.map((o) => o.id).filter((id) => before.includes(id) || r.selected.includes(id));
          setAnswer(q.id, merged);
          const precisions = fillPrecisions(q, r);
          noteSaved(q.id, precisions);
          S.more = q.id;
          st.history = [];
          save();
          await reply(`J’ai noté : ${merged.map((id) => shortLabel(q, id)).join(' ; ')}. Y a-t-il autre chose ? Si c’est tout, dites : « c’est tout ».`);
          return maybeListen();
        }
      }
      const value = valueFromResult(q, r);
      if (value !== undefined) setAnswer(q.id, value);
      const precisions = fillPrecisions(q, r);
      if (value !== undefined || precisions.length) noteSaved(q.id, precisions);
      if (r.awaiting_validation) {
        st.draft = r.text || st.draft;
        save();
        await reply(r.message);
        return maybeListen();
      }
      if (r.complete) {
        await reply(r.message);
        st.history = [];
        st.draft = '';
        save();
        return nextAfterRecap(q, r.message, precisions);
      }
      save();
      await reply(r.message || 'Pouvez-vous préciser ?');
      return maybeListen();
    }
  }
}

// ---------- Questions « une proposition à la fois » (oneByOne) ----------
// Beaucoup de choix : l'assistant lit les propositions une par une et l'usager répond
// oui ou non à chacune. Dans le formulaire, la question reste une liste de cases à cocher.

const isOther = (o) => o.id === 'autre' || o.id === 'autres';
const chosenOptions = (q) => (Array.isArray(S.answers[q.id]) ? S.answers[q.id] : []).filter((id) => id !== NONE);

async function askOption(q, i, { intro = '', ack = '' } = {}) {
  const st = stateOf(q.id);
  st.step = i;
  st.history = [];
  save();
  renderCard(q, false, i);
  const o = q.options[i];
  let text = isOther(o)
    ? `Pour finir : avez-vous une autre attente ?`
    : `${i + 1} sur ${q.options.length} : ${o.label} ?`;
  if (chosenOptions(q).includes(o.id)) text += ' Vous aviez répondu oui.';
  text = [ack, intro, text].filter(Boolean).join(' ');
  logMessage('assistant', text);
  await say(text);
  if (S.currentId === q.id && st.step === i) maybeListen();
}

async function applyOptionResult(q, r) {
  const st = stateOf(q.id);
  const i = st.step ?? 0;
  const o = q.options[i];
  const reply = async (message) => {
    st.history.push({ role: 'assistant', text: displayText(message) });
    logMessage('assistant', message);
    await say(message);
  };

  switch (r.intent) {
    case 'repeat': case 'list': return askOption(q, i);
    case 'next_step': return goStep(1);
    case 'prev_step': return goStep(-1);
    case 'next': {
      // « Passons à la suite » pendant les propositions : on garde les réponses données et on passe.
      st.step = null;
      st.history = [];
      save();
      return goNext();
    }
    case 'back': return i > 0 ? askOption(q, i - 1, { intro: 'On revient à la proposition précédente.' }) : goPrev();
    case 'goto': return goToQuestion({ target: r.navigation || '' }, lastUserText(q));
    case 'finish': return finish();
    case 'skip': return nextOption(q, i, r.message || 'D’accord, on passe.');
    case 'pause':
      await reply(r.message || 'D’accord, on fait une pause. Vos réponses sont gardées. Appuyez sur « Parler » pour reprendre.');
      return;
    case 'help': {
      const again = 'Est-ce que cela vous aiderait ? Répondez oui ou non.';
      await reply(r.message ? (/\?$/.test(r.message) ? r.message : `${r.message} ${again}`) : `${o.label}. ${again}`);
      return maybeListen();
    }
  }
  if (r.yes_no !== 'oui' && r.yes_no !== 'non') {
    await reply(r.message || 'Répondez par oui ou par non. Si vous ne savez pas, dites « passer ».');
    return maybeListen();
  }

  const chosen = new Set(chosenOptions(q));
  if (r.yes_no === 'oui') chosen.add(o.id);
  else chosen.delete(o.id);
  setAnswer(q.id, q.options.map((x) => x.id).filter((id) => chosen.has(id)));

  // « Oui, … » avec une description pour l'option « Autre » : elle remplit le champ de précision.
  const filled = [];
  const f = r.yes_no === 'oui' && isOther(o) && r.text && precisionQuestion(q, o.id);
  if (f) {
    setAnswer(f.id, r.text);
    filled.push(f.id);
  }
  return nextOption(q, i, r.yes_no === 'oui' ? 'Oui, noté.' : 'Non, noté.', filled);
}

async function nextOption(q, i, ack, filled = []) {
  if (i + 1 < q.options.length) return askOption(q, i + 1, { ack });

  // Dernière proposition : récapitulatif des souhaits, puis question suivante.
  const st = stateOf(q.id);
  st.step = null;
  st.history = [];
  const chosen = chosenOptions(q);
  if (!chosen.length && q.allowNone) setAnswer(q.id, [NONE]);
  // Pour « Autre », on cite la précision si elle est déjà connue.
  const labels = chosen.map((id) => {
    const o = q.options.find((x) => x.id === id);
    const precision = isOther(o) && S.answers[precisionQuestion(q, id)?.id];
    return precision || o.label;
  });
  const recap = labels.length ? `C’est noté. Vos souhaits : ${labels.join(' ; ')}.` : 'C’est noté : aucun de ces souhaits.';
  logMessage('assistant', recap);
  await say(recap);
  save();
  return nextAfterRecap(q, recap, filled);
}

// ---------- Retour à une question précise ----------

const lastUserText = (q) => [...stateOf(q.id).history].reverse().find((h) => h.role === 'usager')?.text || '';

async function callNavigate(utterance, candidates) {
  const res = await fetch('/api/navigate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ utterance, questions: candidates.map(({ numero, id, reponse }) => ({ numero, id, reponse })) }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Va à la question demandée : `{ number }` (numéro affiché à l'écran) ou `{ target }` (mots de la
 * question ou de la réponse, retrouvés par l'IA, ou par mots-clés sans IA). Une fois cette
 * question traitée, goNext() ramène l'usager où il en était.
 */
async function goToQuestion(nav, utterance) {
  const visible = visibleQuestions();
  const tell = async (message) => {
    logMessage('assistant', message);
    await say(message);
  };
  let number = nav.number ?? null;
  if (!number && /^\D{0,20}\d+\D{0,5}$/.test(nav.target || '')) number = parseNumber(nav.target);

  let targetId = null;
  if (number) {
    if (!visible[number - 1]) {
      await tell(`Il n’y a pas de question ${number}. Les questions vont de 1 à ${visible.length}.`);
      return maybeListen();
    }
    targetId = visible[number - 1].id;
  } else {
    const candidates = visible.map((q, i) => ({
      numero: i + 1, id: q.id, question: q.label,
      reponse: isAnswered(q, S.answers[q.id]) ? formatValue(q, S.answers[q.id]) : '',
    }));
    let found = null;
    if (llmAvailable()) {
      S.busy = true;
      renderMicState('thinking');
      try {
        found = await callNavigate(utterance, candidates);
      } catch {
        found = null; // recherche par mots-clés ci-dessous
      } finally {
        S.busy = false;
        renderMicState('idle');
      }
    }
    if (!found) {
      const texts = candidates.map((c) => {
        const q = question(c.id);
        return { id: c.id, text: [q.label, q.simple, ...(q.options || []).map((o) => o.label)].join(' '), answer: c.reponse };
      });
      const ids = findQuestions(texts, nav.target || utterance);
      found = ids.length === 1 ? { id: ids[0], candidats: [] } : { id: null, candidats: ids.slice(0, 3) };
    }
    if (found.id) {
      targetId = found.id;
    } else if (found.candidats.length) {
      const list = found.candidats.map((id) => {
        const i = visible.findIndex((q) => q.id === id);
        return `la question ${i + 1} : ${visible[i].label}`;
      });
      S.pendingNav = true;
      await tell(`Plusieurs questions peuvent correspondre : ${list.join(' ; ')}. Dites le numéro de celle que vous voulez revoir.`);
      return maybeListen();
    } else {
      await tell('Je n’ai pas trouvé cette question. Dites son numéro, affiché à l’écran, ou un mot de la question.');
      return maybeListen();
    }
  }

  if (targetId === S.currentId) return ask(targetId, { intro: 'Nous sommes déjà sur cette question.' });
  if (!S.returnTo) S.returnTo = S.currentId;
  return ask(targetId, { intro: `On revient à la question : ${question(targetId).short}.` });
}

/** Silence entre le récapitulatif d'une réponse et la question suivante. */
const PAUSE_AVANT_QUESTION_MS = 1000;

async function nextAfterRecap(q, recap, alreadyAnswered = []) {
  if (recap) {
    await new Promise((resolve) => setTimeout(resolve, PAUSE_AVANT_QUESTION_MS));
    // L'usager a pu changer de question pendant la pause (bouton, question précédente…).
    if (S.currentId !== q.id) return;
  }
  return goNext(alreadyAnswered);
}

/** Question de précision (texte) qui s'affiche quand l'option `optionId` de `q` est choisie. */
function precisionQuestion(q, optionId) {
  return S.schema.questions.find((f) => {
    const w = f.when;
    return w && w.q === q.id && (f.type === 'text' || f.type === 'longtext')
      && (w.includes === optionId || w.eq === optionId || w.in?.includes(optionId));
  });
}

/**
 * Précisions données dès la première réponse (« un déambulateur », ou une réponse hors liste
 * pour « Autre ») : elles remplissent directement les champs de précision des options cochées.
 * Renvoie ces questions de précision, qui n'ont plus besoin d'être posées.
 */
function fillPrecisions(q, r) {
  const filled = [];
  for (const { option, text } of r.precisions || []) {
    const f = r.selected?.includes(option) && precisionQuestion(q, option);
    if (!f || !text) continue;
    setAnswer(f.id, text);
    filled.push(f.id);
  }
  return filled;
}

/**
 * Question de suivi ou précision encore vide (même facultative), dans la même carte que `q` et après
 * elle ; `skip` : questions déjà répondues dans le même échange.
 */
function pendingInCard(q, skip = []) {
  const order = S.schema.questions;
  const vis = computeVisibility(S.schema, S.answers);
  const card = rootOf(q.id);
  return order.slice(order.indexOf(q) + 1).find((x) => vis[x.id] && parentOf(x.id) && rootOf(x.id) === card
    && !skip.includes(x.id) && !isAnswered(x, S.answers[x.id]));
}

/** Question suivante visible ; `skip` : questions déjà répondues dans le même échange. */
function goNext(skip = [], { focus = false } = {}) {
  const order = S.schema.questions;
  if (S.review) {
    // D'abord, comme dans le parcours normal, les questions de suivi et précisions encore vides de la
    // même carte, même facultatives (la date de fin après la date de début des indemnités).
    const sub = pendingInCard(question(S.currentId), skip);
    if (sub) return ask(sub.id, { focus });
    // Puis les questions restantes : la prochaine sans réponse après celle-ci, sinon la première ; sinon la fin.
    const here = order.indexOf(question(S.currentId));
    const left = unanswered().filter((q) => q.id !== S.currentId && !skip.includes(q.id));
    const target = left.find((q) => order.indexOf(q) > here) || left[0];
    return target ? ask(target.id, { focus }) : finish();
  }
  const vis = computeVisibility(S.schema, S.answers);
  const start = order.findIndex((q) => q.id === S.currentId);
  const next = order.slice(start + 1).find((q) => vis[q.id] && !skip.includes(q.id)
    && !(parentOf(q.id) && isAnswered(q, S.answers[q.id])));
  // Après un retour à une question antérieure, on reprend où l'usager en était, en posant
  // d'abord les nouvelles questions de précision que sa correction a fait apparaître.
  if (S.returnTo) {
    const resume = order.findIndex((q) => q.id === S.returnTo);
    const newQuestion = next && order.indexOf(next) < resume && !isAnswered(next, S.answers[next.id]);
    if (!newQuestion) {
      const target = S.returnTo;
      S.returnTo = null;
      save();
      if (vis[target] && target !== S.currentId) return ask(target, { focus, intro: 'Nous reprenons où vous en étiez.' });
    }
  }
  if (next) {
    // Changement d'étape : on le dit et on l'affiche, pour que l'usager sache où il en est.
    const from = stepIndexOf(question(S.currentId));
    const to = stepIndexOf(next);
    if (to > from) {
      const text = stepEndText(from, vis);
      S.stepEnd = { qid: next.id, ...text };
      return ask(next.id, { focus, intro: `${text.text} Passons à l’étape « ${S.schema.steps[to].title} ».` });
    }
    return ask(next.id, { focus });
  }
  return finish();
}

/**
 * Fin d'étape, en phrases faciles à dire à voix haute. L'information importante est ce qui manque :
 * les questions sans réponse (nommées s'il y en a peu), pas le nombre de réponses enregistrées.
 */
function stepEndText(i, vis) {
  const title = `« ${S.schema.steps[i].title} »`;
  const left = stepQuestions(i, vis).filter((q) => !q.optional && !complete(q, vis));
  if (!left.length) return { complete: true, text: `Vous avez terminé l’étape ${title}.` };
  const count = left.length === 1 ? 'une question' : `${left.length} questions`;
  const names = left.map((q) => `« ${q.short} »`);
  const list = left.length > 3 ? '' : ` : ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} et ${names.at(-1)}`}`;
  return {
    complete: false,
    text: `Il reste ${count} sans réponse dans l’étape ${title}${list}. Vous pourrez y répondre à la fin du questionnaire.`,
  };
}

/**
 * Changer d'étape (boutons « Étape précédente / suivante », ou à la voix) : première question de
 * l'étape visée, ou l'écran de fin après la dernière étape. En avançant, l'étape quittée est
 * résumée comme à la fin normale d'une étape (bandeau vert, ou orange s'il reste des questions).
 */
function goStep(delta, { focus = false } = {}) {
  listener.stop();
  speaker.stop();
  const vis = computeVisibility(S.schema, S.answers);
  const from = stepIndexOf(topQuestion(question(S.currentId)));
  const to = from + delta;
  if (to < 0) return ask(S.currentId, { focus, intro: 'C’est la première étape.' });
  S.returnTo = null;
  S.stepEnd = null;
  if (to >= S.schema.steps.length) return finish();
  const first = stepQuestions(to, vis)[0];
  if (delta < 0) return ask(first.id, { focus, intro: `On revient à l’étape « ${S.schema.steps[to].title} ».` });
  const text = stepEndText(from, vis);
  S.stepEnd = { qid: first.id, ...text };
  return ask(first.id, { focus, intro: `${text.text} Passons à l’étape « ${S.schema.steps[to].title} ».` });
}

function goPrev({ focus = false } = {}) {
  const order = S.schema.questions;
  const vis = computeVisibility(S.schema, S.answers);
  const start = order.findIndex((q) => q.id === topQuestion(question(S.currentId)).id);
  const prev = order.slice(0, start).reverse().find((q) => vis[q.id] && !parentOf(q.id));
  S.stepEnd = null;
  if (prev) return ask(prev.id, { focus, intro: 'On revient à la question précédente.' });
  return ask(S.currentId, { focus, intro: 'C’est la première question.' });
}

// ---------- Début et fin ----------

/** Efface toutes les réponses (session et formulaire affiché) pour repartir de la première question. */
function resetAnswers() {
  Object.assign(S, { answers: {}, perQ: {}, currentId: null, finished: false, review: false, prefilled: {}, confirming: null, conflicts: [], resolving: null });
  memory.clear();
  safe(() => localStorage.removeItem(STORE_KEY));
  for (const q of S.schema.questions) writeValue($('form-b'), q, null);
  refreshVisibility();
}

/**
 * Affiche un écran : 'accueil', 'avant' (présentation), 'espace' (questions) ou 'recap' (fin), dans
 * une colonne centrée (grille DSFR).
 */
function showScreen(name, title, tab = title) {
  S.keepTop = true;
  // Chaque écran est une étape de l'historique : le bouton « Précédent » du navigateur
  // ramène à l'écran d'avant au lieu de quitter le site.
  if (!S.fromHistory && history.state?.screen !== name) history.pushState({ screen: name, prev: history.state?.screen }, '');
  for (const id of ['accueil', 'avant', 'espace', 'recap']) $(id).hidden = id !== name;
  // Écran des questions : « Réglages de la voix » est sur la ligne de lecture, pas à côté du titre.
  $('reglages-titre').hidden = name === 'espace';
  renderBreadcrumb(name);
  // Une seule colonne centrée sur tous les écrans ; « Avant de commencer » un peu plus étroite,
  // pour des lignes de texte plus courtes.
  const col = $('colonne-principale');
  col.classList.toggle('fr-col-lg-8', name !== 'avant');
  col.classList.toggle('fr-col-lg-7', name === 'avant');
  setPageTitle(title, tab);
  focusTop($('titre-page'));
}

/**
 * Fil d'Ariane (DSFR) selon la hiérarchie du parcours, pas l'historique : l'introduction
 * « Avant de commencer », puis « Répondre aux questions », puis « Imprimer ou enregistrer » (la fin du
 * questionnaire). Chaque nom est celui du titre de la page. La page en cours n'est pas un lien
 * (aria-current="page").
 */
function renderBreadcrumb(name) {
  $('fil-ariane').hidden = name === 'accueil';
  // Avec le fil d'Ariane, sa propre marge suffit au-dessus du contenu ; sans (accueil), le contenu
  // garde son espace en haut.
  $('contenu').classList.toggle('fr-py-4w', name === 'accueil');
  $('contenu').classList.toggle('fr-pb-4w', name !== 'accueil');
  if (name === 'accueil') return;
  // Nom de la page, comme son titre : l'étape en cours est donnée par l'indicateur d'étapes.
  const here = name === 'avant' ? 'Avant de commencer' : name === 'recap' ? FIN : 'Répondre aux questions';
  const link = (label, href, target) => {
    // Page en cours : pas de href (ce n'est pas un lien), aria-current="page" (exemple DSFR).
    const a = Object.assign(document.createElement('a'), { className: 'fr-breadcrumb__link', textContent: label });
    if (target) {
      a.href = href;
      a.dataset.vers = target;
    } else a.setAttribute('aria-current', 'page');
    const li = document.createElement('li');
    li.append(a);
    return li;
  };
  $('fil-ariane-liste').replaceChildren(
    link('Accueil', '/', 'accueil'),
    ...(name === 'avant' ? [] : [link('Avant de commencer', '#avant', 'avant')]),
    ...(name === 'recap' ? [link('Répondre aux questions', '#questions', 'espace')] : []),
    link(here),
  );
}

/**
 * Lien du fil d'Ariane. Si c'est l'écran d'avant dans l'historique, on y revient comme avec le
 * bouton « Précédent » du navigateur, pour que les deux mènent au même endroit.
 */
function followBreadcrumb(target) {
  speaker.stop();
  listener.stop();
  if (history.state?.prev === target) return history.back();
  if (target === 'accueil') return goHome();
  if (target === 'espace') return beginQuestions(); // depuis la fin : retour aux questions
  return showIntro();
}

/** Accueil : nombre de questions et, si le parcours est commencé, choix de reprendre ou recommencer. */
function renderHome(started) {
  // Nombre de questions : même calcul que « Question 2 sur N », un maximum qui ne peut que baisser.
  $('nb-questions').textContent = S.schema.steps.reduce((n, _, i) => n + stepTotal(i), 0);
  $('reprise').hidden = !started;
  $('reprise-continuer').checked = true;
  if (started) {
    const n = S.schema.questions.filter((q) => isAnswered(q, S.answers[q.id])).length;
    $('reprise-continuer-aide').textContent = n > 1 ? `Vos ${n} réponses sont gardées.`
      : n === 1 ? 'Votre réponse est gardée.' : 'Vous reprendrez à la question où vous étiez.';
  }
}

/** Après l'effacement des réponses : retour à l'accueil, écran de fin remis dans son état normal. */
function leaveAfterErase() {
  clearTimeout(S.redirect);
  $('efface-ok').hidden = true;
  $('recap-contenu').hidden = false;
  goHome();
}

/** Retour à l'accueil : la voix et le micro s'arrêtent, les réponses sont gardées. */
function goHome() {
  clearTimeout(S.redirect);
  speaker.stop();
  listener.stop();
  save();
  renderHome(Object.keys(S.answers).length > 0 || Boolean(S.currentId));
  showScreen('accueil', 'Formulaire MDPH - Partie B', 'Accueil');
}

function start(mode) {
  if (!$('reprise').hidden && $('reprise-recommencer').checked) resetAnswers();
  $('reprise').hidden = true;
  S.mode = mode;
  S.finished = false;
  const resuming = Boolean(S.currentId && question(S.currentId));
  if (!resuming) return showIntro();
  showScreen('espace', 'Répondre aux questions');
  $('li-mic').hidden = !canListen;
  renderCard(question(S.currentId));
  ask(S.currentId, { intro: 'Nous reprenons où vous en étiez.' });
}

/**
 * Écran « Avant de commencer » : la présentation est affichée et lue à voix haute. On passe aux
 * questions seulement quand l'usager le demande (bouton, ou « on commence » au micro) :
 * pas de changement d'écran imprévu (RGAA 13).
 */
function showIntro() {
  renderIntroMode();
  setIntroStatus('');
  showTranscription('');
  showScreen('avant', 'Avant de commencer');
  // Retour en cours de parcours (fil d'Ariane) : la présentation n'est pas relue d'office
  // (« Réécouter la présentation » reste possible).
  if (!started()) readIntro();
}

/** Parcours commencé : une réponse, une question déjà posée, ou la fin atteinte. */
const started = () => Object.keys(S.answers).length > 0 || Boolean(S.currentId) || S.finished;

/** Libellé du bouton principal : « Commencer » la première fois, « Reprendre » ensuite. */
const startLabel = () => (started() ? 'Reprendre les questions' : 'Commencer les questions');

/** Consigne et boutons selon le mode : écoute automatique, micro à la demande, ou réponse écrite. */
function renderIntroMode() {
  $('btn-commencer').textContent = startLabel();
  document.querySelectorAll('.libelle-commencer').forEach((el) => { el.textContent = startLabel(); });
  // Présentation et bouton « Parler » : selon le navigateur, pour que l'écran ne saute pas si le
  // micro est bloqué en cours de route. Consigne : selon le mode (micro bloqué → réponse écrite).
  $('avant-intro').hidden = !canListen;
  $('avant-intro-clavier').hidden = canListen;
  $('avant-voix').hidden = !canListen;
  $('li-parler-avant').hidden = !canListen;
  const voice = S.mode === 'voice' && canListen;
  $('avant-bip').hidden = !voice;
  $('consigne-auto').hidden = !(voice && prefs.handsfree);
  $('consigne-micro').hidden = !(voice && !prefs.handsfree);
  $('consigne-clavier').hidden = voice;
}

const setIntroStatus = (text) => { $('etat-micro-avant').textContent = text; };

/** Texte lu : celui des éléments affichés de l'écran, dans l'ordre (l'écrit et l'oral sont identiques). */
const introText = () => [...$('avant').querySelectorAll('[data-lu]')]
  .filter((el) => !el.closest('[hidden]'))
  .map((el) => el.textContent.trim().replace(/[^.!?»]$/, '$&.'))
  .join(' ');

async function readIntro() {
  listener.stop();
  setIntroStatus('');
  await say(introText());
  if ($('avant').hidden || speaker.state !== 'idle') return;
  if (S.mode === 'voice' && canListen && prefs.handsfree) listenForBegin();
}

/**
 * Écoute « on commence ». En écoute automatique, une seconde tentative suit un silence ou une
 * phrase incomprise ; avec le bouton « Parler », l'usager réessaie lui-même.
 */
async function listenForBegin(tries = 0) {
  speaker.stop();
  showTranscription('');
  setIntroStatus(prefs.handsfree
    ? 'Écoute en cours…'
    : 'Écoute en cours… Appuyez sur « J’ai fini de parler » quand vous avez terminé.');
  let text;
  try {
    text = await listener.listen();
  } catch (err) {
    const blocked = err.message === 'not-allowed' || err.message === 'service-not-allowed';
    setIntroStatus('');
    showMicError('avant', blocked);
    if (blocked) { S.mode = 'keyboard'; renderIntroMode(); }
    return;
  }
  if (text === null || $('avant').hidden) return; // écoute annulée, ou l'usager a déjà continué
  setIntroStatus('');
  if (text && detectBegin(text)) return beginQuestions();
  if (text && detectCommand(text) === 'repeat') return readIntro();
  const heard = text ? 'Je n’ai pas compris.' : 'Je n’ai rien entendu.';
  if (!prefs.handsfree || tries >= 1) {
    setIntroStatus(`${heard} Appuyez sur « Parler » pour réessayer, ou sur « ${startLabel()} ».`);
    return;
  }
  const retry = `${heard} Dites « on commence », ou appuyez sur « ${startLabel()} ».`;
  // Lu à voix haute, ou affiché (et annoncé) si la lecture est désactivée : jamais les deux.
  setIntroStatus(prefs.speak && canSpeak ? '' : retry);
  await say(retry);
  if (!$('avant').hidden) listenForBegin(tries + 1);
}

/** Première question, après la présentation. */
function beginQuestions() {
  listener.stop();
  speaker.stop();
  showScreen('espace', 'Répondre aux questions');
  $('li-mic').hidden = !canListen;
  // Retour à la présentation en cours de parcours : on reprend à la question où l'usager en était.
  S.finished = false;
  const resuming = Boolean(S.currentId && question(S.currentId));
  const target = resuming ? S.currentId : S.schema.questions[0].id;
  S.currentId = target;
  renderCard(question(target));
  ask(target, resuming ? { intro: 'Nous reprenons où vous en étiez.' } : {});
}

/** Questions visibles restées sans réponse (sans compter les questions facultatives). */
const unanswered = () => visibleQuestions().filter((q) => !q.optional && !isAnswered(q, S.answers[q.id]));

function finish() {
  listener.stop();
  S.finished = true;
  S.currentId = null;
  S.returnTo = null;
  showQuestion($('form-b'), null);
  save();
  // Écran de fin dans son état normal (sans le message d'effacement d'une visite précédente).
  clearTimeout(S.redirect);
  $('efface-ok').hidden = true;
  $('recap-contenu').hidden = false;
  renderRecap();
  const missing = unanswered().length;
  // Même nom que dans le fil d'Ariane et l'indicateur d'étapes.
  showScreen('recap', FIN);
  say(missing
    ? `Il reste ${missing === 1 ? 'une question' : `${missing} questions`} sans réponse. Vous pouvez imprimer ou enregistrer le formulaire tel quel, ou y répondre maintenant.`
    : 'Merci, la partie B est remplie. Vous pouvez maintenant imprimer ou enregistrer le formulaire.');
}

/** Écran final : questions restées sans réponse. */
function renderRecap() {
  const missing = unanswered().length;
  $('recap-manquantes').hidden = !missing;
  $('recap-complet').hidden = Boolean(missing);
  $('recap-manquantes-titre').textContent = missing === 1
    ? 'Il reste une question sans réponse' : `Il reste ${missing} questions sans réponse`;
  renderTranscriptLink();
  // Réponses pré-remplies depuis la mémoire, jamais confirmées (l'usager est passé à la suite).
  const vis = computeVisibility(S.schema, S.answers);
  const toCheck = Object.entries(S.prefilled)
    .filter(([id, p]) => !p.confirmed && vis[id] && isAnswered(question(id), S.answers[id]))
    .map(([id]) => question(id));
  $('recap-prerempli').hidden = !toCheck.length;
  $('recap-prerempli-titre').textContent = toCheck.length === 1
    ? 'Une réponse pré-remplie n’a pas été confirmée' : `${toCheck.length} réponses pré-remplies n’ont pas été confirmées`;
  $('recap-prerempli-liste').replaceChildren(...toCheck.map((q) => Object.assign(document.createElement('li'), {
    textContent: `${q.short} : ${formatValue(q, S.answers[q.id])}`,
  })));
}

/**
 * Lien de téléchargement de la transcription de tout l'échange (fichier texte créé dans le
 * navigateur : rien n'est envoyé au serveur). Masqué s'il n'y a encore rien à transcrire.
 */
function renderTranscriptLink() {
  const link = $('lien-transcription');
  const empty = !memory.transcript.length;
  link.closest('p').hidden = empty;
  if (link.href.startsWith('blob:')) URL.revokeObjectURL(link.href);
  if (empty) { link.removeAttribute('href'); return; }
  const blob = new Blob([memory.toTxt(S.schema)], { type: 'text/plain;charset=utf-8' });
  link.href = URL.createObjectURL(blob);
  const kb = Math.max(1, Math.round(blob.size / 1024));
  $('lien-transcription-detail').textContent = `TXT – ${kb.toLocaleString('fr-FR')} ko`;
}

/**
 * Cerfa 15692*01 partie B rempli (PDF), généré par le serveur à partir des réponses visibles.
 * `download` : enregistre le fichier ; sinon l'ouvre dans un nouvel onglet pour l'imprimer.
 * Formulaire HTML classique : le navigateur affiche ou télécharge le PDF lui-même.
 */
function openCerfaPdf(download) {
  const vis = computeVisibility(S.schema, S.answers);
  const answers = Object.fromEntries(Object.entries(S.answers).filter(([id]) => vis[id]));
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/api/cerfa-partie-b.pdf';
  form.target = download ? '_self' : '_blank';
  for (const [name, value] of [['answers', JSON.stringify(answers)], ['mode', download ? 'download' : 'view']]) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(form);
  form.submit();
  form.remove();
  announce(download
    ? 'Le formulaire Cerfa rempli est en cours d’enregistrement.'
    : 'Le formulaire Cerfa rempli s’ouvre dans un nouvel onglet. Vous pourrez l’imprimer depuis cet onglet.');
}

// ---------- Événements ----------

// Titre de chaque écran (h1 visible) et de l'onglet, au format DSFR « Titre - Nom du site ».
const SITE = 'Formulaire MDPH - Partie B';
function setPageTitle(h1, tab = h1) {
  $('titre-page').textContent = h1;
  document.title = `${tab} - ${SITE}`;
}

/**
 * Changement d'écran : la page remonte en haut et le focus va sur le premier élément du
 * nouvel écran (sans défilement supplémentaire), pour le clavier et les lecteurs d'écran.
 */
function focusTop(el) {
  window.scrollTo(0, 0);
  el.focus({ preventScroll: true });
}

function bind() {
  for (const [id, key] of [['pref-speak', 'speak'], ['pref-handsfree', 'handsfree']]) {
    $(id).addEventListener('change', (e) => {
      prefs[key] = e.target.checked;
      if (key === 'speak' && !prefs.speak) speaker.stop();
      applyPrefs();
      if (!$('avant').hidden) renderIntroMode(); // la consigne dépend de l'écoute automatique
    });
  }
  $('pref-rate').addEventListener('change', (e) => { prefs.rate = Number(e.target.value); applyPrefs(); });

  // Échap ferme la fenêtre ouverte où que soit le focus : le DSFR l'ignore quand il est sur
  // un champ (liste de vitesse, interrupteurs, boutons radio), ce qui piège l'usager au clavier.
  // Fermée par l'API (conceal), la fenêtre ne rend pas le focus : on le remet sur le bouton
  // qui l'a ouverte, avec l'API du DSFR (modalButton.focus).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.isComposing) return;
    const modal = document.querySelector('.fr-modal.fr-modal--opened');
    if (!modal || !window.dsfr) return;
    e.preventDefault();
    // Plusieurs boutons peuvent ouvrir la même fenêtre (« Réglages de la voix ») : celui qui est visible.
    const opener = [...document.querySelectorAll(`[aria-controls="${modal.id}"][data-fr-opened="true"]`)]
      .find((btn) => btn.offsetParent) || document.querySelector(`[aria-controls="${modal.id}"][data-fr-opened="true"]`);
    window.dsfr(modal).modal.conceal();
    if (opener) window.dsfr(opener).modalButton.focus();
  }, true);

  // Le clic de départ autorise aussi la lecture audio de la voix naturelle (Safari).
  // Un seul bouton : à l'oral quand le navigateur sait écouter (l'usager peut toujours écrire).
  speaker.onState = renderPause;
  $('btn-pause').addEventListener('click', voiceAction);
  $('btn-pause-avant').addEventListener('click', () => {
    if (speaker.state === 'speaking') speaker.pause();
    else if (speaker.state === 'paused') speaker.resume();
    else readIntro();
  });
  $('btn-commencer').addEventListener('click', () => { speaker.unlock(); beginQuestions(); });
  $('btn-parler-avant').addEventListener('click', () => {
    speaker.unlock();
    if (listener.active) listener.finish();
    else { S.mode = 'voice'; renderIntroMode(); listenForBegin(); }
  });
  $('fil-ariane-liste').addEventListener('click', (e) => {
    const link = e.target.closest('a[data-vers]');
    if (!link) return;
    e.preventDefault();
    followBreadcrumb(link.dataset.vers);
  });
  // Boutons « Précédent » et « Suivant » du navigateur.
  window.addEventListener('popstate', (e) => {
    const name = e.state?.screen || 'accueil';
    S.fromHistory = true;
    try {
      if (name === 'accueil') goHome();
      else if (name === 'recap') finish();
      else if (name === 'avant') { speaker.stop(); listener.stop(); showIntro(); }
      // Retour aux questions : à la question où l'usager en était (la première après la fin).
      else { speaker.stop(); listener.stop(); beginQuestions(); }
    } finally {
      S.fromHistory = false;
    }
  });
  $('btn-start').addEventListener('click', () => { speaker.unlock(); start(canListen ? 'voice' : 'keyboard'); });

  $('btn-mic').addEventListener('click', () => {
    speaker.unlock();
    if (listener.active) { listener.finish(); return; }
    S.mode = 'voice';
    startListening();
  });

  // Question suivante (clic) : le focus suit, sur le titre de la nouvelle question.
  $('btn-suivant').addEventListener('click', () => {
    listener.stop();
    speaker.stop();
    goNext([], { focus: true });
  });
  // Boutons d'étape : le focus suit, sur le titre de la nouvelle question.
  for (const [id, delta] of [['btn-etape-prec', -1], ['btn-etape-suiv', 1]]) {
    $(id).addEventListener('click', () => goStep(delta, { focus: true }));
  }
  $('btn-precedent').addEventListener('click', () => {
    listener.stop();
    speaker.stop();
    goPrev({ focus: true });
  });
  // Modifier ses réponses : retour à la première question ; on avance ensuite par question ou par étape.
  $('btn-modifier').addEventListener('click', () => {
    speaker.stop();
    beginQuestions();
  });
  $('btn-reprendre').addEventListener('click', () => {
    const first = unanswered()[0];
    if (!first) return;
    speaker.unlock();
    S.finished = false;
    S.review = true; // les questions sans réponse sont signalées, « Question suivante » y mène
    showScreen('espace', 'Répondre aux questions');
    ask(first.id, { intro: 'Reprenons avec les questions restantes.' });
  });
  $('btn-imprimer').addEventListener('click', () => openCerfaPdf(false));
  $('btn-telecharger').addEventListener('click', () => openCerfaPdf(true));
  // Effacement confirmé dans la fenêtre : réponses effacées, message de confirmation, puis retour à
  // l'accueil après 10 secondes. L'usager peut y aller tout de suite ou rester (RGAA 13.1 : il garde
  // le contrôle de la limite de temps).
  $('btn-effacer-oui').addEventListener('click', () => {
    window.dsfr($('modal-effacer')).modal.conceal();
    speaker.stop();
    resetAnswers();
    S.review = false;
    $('recap-contenu').hidden = true;
    $('efface-texte').textContent = 'Vous allez revenir à l’accueil dans 10 secondes.';
    $('btn-rester').closest('li').hidden = false;
    $('efface-ok').hidden = false;
    // Le titre de la page dit ce qui s'est passé ; l'alerte (annoncée) prévient du retour à l'accueil.
    setPageTitle('Vos réponses ont été effacées');
    $('titre-page').focus();
    S.redirect = setTimeout(leaveAfterErase, 10000);
  });
  $('btn-accueil-maintenant').addEventListener('click', leaveAfterErase);
  $('btn-rester').addEventListener('click', () => {
    clearTimeout(S.redirect);
    $('efface-texte').textContent = 'Vous restez sur cette page.';
    $('btn-rester').closest('li').hidden = true;
    $('btn-accueil-maintenant').focus();
  });
}

async function init() {
  S.schema = await loadSchema();
  setGlossary(S.schema.acronyms);
  renderForm($('form-b'), S.schema, {
    // Réponse donnée directement dans la question (case, champ) : enregistrée tout de suite.
    onChange: (qid, value) => {
      const q = question(qid);
      // Date incomplète ou impossible (« 31/02 ») : pas enregistrée. La question reste sans réponse,
      // l'erreur reste affichée dans la question (comme à l'oral, où l'assistant redemande la date).
      const valid = !dateError(q, value);
      if (valid && (isAnswered(q, value) || (Array.isArray(value) && q.type === 'table'))) S.answers[qid] = value;
      else delete S.answers[qid];
      // Réponse pré-remplie modifiée à la main : c'est l'usager qui l'a donnée.
      if (S.prefilled[qid]) settlePrefill(qid, isAnswered(q, value));
      if (qid === S.currentId) $('prerempli').hidden = true;
      refreshVisibility();
      save();
    },
  });
  const resumed = restore();
  for (const q of S.schema.questions) writeValue($('form-b'), q, S.answers[q.id] ?? null);
  refreshVisibility();
  renderHome(resumed);
  history.replaceState({ screen: 'accueil' }, '');
  if (!canListen) $('alerte-micro').hidden = false;
  loadPrefs();
  bind();

  fetch('/api/status').then((r) => r.json()).then((s) => {
    if (!s.llm) {
      S.llmOk = false; // IA non configurée sur le serveur : mode simplifié pour toute la session
      setDegraded(true);
    }
    S.ttsVoices = s.tts || []; // sans voix naturelle sur le serveur : voix du navigateur
    applyPrefs();
    // Développement (MEMOIRE_DEBUG=1) : panneau qui montre la mémoire évoluer. Chargé seulement dans ce cas.
    if (s.debug_memoire) {
      import('./debug-memory.js').then((m) => m.mountDebugPanel({
        memory, calls, schema: S.schema, column: $('colonne-principale'), onCall: (fn) => { onCallLogged = fn; },
      }));
    }
  }).catch(llmFailed);
}

init().catch((err) => {
  console.error(err);
  const p = document.createElement('p');
  p.className = 'fr-alert fr-alert--error';
  p.textContent = 'Le service n’a pas pu démarrer. Rechargez la page ou réessayez plus tard.';
  $('contenu').prepend(p);
});
