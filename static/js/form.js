// Rendu du formulaire (composants DSFR) à partir de form-b.json,
// lecture/écriture des valeurs et conditions d'affichage.

export const NONE = 'aucun';
const DATE_RE = /^(0?[1-9]|[12]\d|3[01])\/(0?[1-9]|1[0-2])\/(19|20)\d{2}$/;

export async function loadSchema() {
  const res = await fetch('/form-b.json');
  if (!res.ok) throw new Error('Impossible de charger le formulaire');
  return res.json();
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  return v == null || v === '' ? [] : [v];
}

function evalCond(c, answers) {
  if (!c) return true;
  if (c.anyOf) return c.anyOf.some((x) => evalCond(x, answers));
  const v = answers[c.q];
  const arr = asArray(v);
  if ('eq' in c) return v === c.eq;
  if ('ne' in c) return v !== c.ne;
  if ('includes' in c) return arr.includes(c.includes);
  if ('in' in c) return arr.some((x) => c.in.includes(x));
  if (c.nonEmpty) return arr.some((x) => x !== NONE);
  return true;
}

/** Visibilité de chaque question. Une question dont le « parent » est masqué est masquée. */
export function computeVisibility(schema, answers) {
  const visible = {};
  const effective = {};
  for (const q of schema.questions) {
    visible[q.id] = evalCond(q.when, effective);
    if (visible[q.id]) effective[q.id] = answers[q.id];
  }
  return visible;
}

/**
 * Nombre maximal de questions, parmi `qs`, qui peuvent encore s'afficher compte tenu des réponses
 * déjà données : sert de total (« Question 2 sur N »), qui ne doit jamais augmenter en cours de route.
 * Une question dont la condition ne dépend que de questions « décidées » (répondues, ou masquées pour
 * de bon) est comptée si elle est visible ; sinon elle est comptée comme possible. Les questions qui
 * dépendent de valeurs différentes d'une même question à choix unique encore sans réponse s'excluent :
 * seul le plus grand de ces groupes compte. Le total ne peut donc que baisser à mesure qu'on répond.
 */
export function maxVisible(schema, answers, qs) {
  const byId = Object.fromEntries(schema.questions.map((q) => [q.id, q]));
  const vis = computeVisibility(schema, answers);
  const refs = (c) => (!c ? [] : c.anyOf ? c.anyOf.flatMap(refs) : [c.q]);
  const memo = {};
  const decided = (id) => (memo[id] ??= refs(byId[id]?.when).every(decided)
    && (!vis[id] || isAnswered(byId[id], answers[id])));
  let count = 0;
  const groups = {}; // { question source : { valeur : nombre de questions } }
  for (const q of qs) {
    const c = q.when;
    if (refs(c).every(decided)) { count += vis[q.id] ? 1 : 0; continue; }
    const exclusive = c && !c.anyOf && ('eq' in c || 'in' in c) && ['single', 'yesno'].includes(byId[c.q]?.type);
    if (!exclusive) { count += 1; continue; }
    const g = (groups[c.q] ||= {});
    for (const value of 'eq' in c ? [c.eq] : c.in) g[value] = (g[value] || 0) + 1;
  }
  for (const g of Object.values(groups)) count += Math.max(...Object.values(g));
  return count;
}

export function isAnswered(q, v) {
  if (v == null || v === '') return false;
  // Tableau : une liste vide est une réponse (« Je n'ai pas de frais à déclarer » coché).
  if (q.type === 'table' && Array.isArray(v)) return v.length === 0 || v.some((r) => Object.values(r).some(Boolean));
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

export function formatValue(q, v) {
  if (!isAnswered(q, v)) return 'Pas de réponse';
  const label = (id) => {
    if (id === NONE) return 'Cela ne me concerne pas';
    return q.options?.find((o) => o.id === id)?.label ?? id;
  };
  switch (q.type) {
    case 'single': return label(v);
    case 'multi': return v.map(label).join(' ; ');
    case 'yesno': return v === 'oui' ? 'Oui' : 'Non';
    case 'number': return `${v}${q.unit ? ' ' + q.unit : ''}`;
    case 'table':
      return v.filter((r) => Object.values(r).some(Boolean))
        .map((r) => q.columns.map((c) => r[c.id] ? `${c.label} : ${r[c.id]}` : '').filter(Boolean).join(', '))
        .join(' | ') || 'Aucun';
    default: return String(v);
  }
}

// ---------- Rendu ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c) node.append(c);
  return node;
}

// Champ facultatif : mention « (optionnel) » dans l'intitulé (règle DSFR des formulaires).
const OPTIONAL = ' (optionnel)';

/**
 * Titre de la question (niveau 3, sous le titre de l'étape), focalisable pour y amener l'usager,
 * suivi d'une infobulle DSFR au clic avec la question reformulée plus simplement. Le texte de
 * l'infobulle est hors du titre, pour ne pas s'y ajouter.
 */
function titleFor(q) {
  const title = el('h3', { class: 'fr-h5 fr-mb-1w', id: `titre-${q.id}`, tabindex: '-1' },
    el('span', { id: `titre-texte-${q.id}`, text: q.label + (q.optional ? OPTIONAL : '') }));
  if (!q.simple) return [title];
  title.append(' ', el('button', {
    type: 'button', class: 'fr-btn--tooltip fr-btn', 'aria-describedby': `infobulle-${q.id}`,
  }, 'Explication simple de la question'));
  return [title, el('span', { class: 'fr-tooltip fr-placement', id: `infobulle-${q.id}`, role: 'tooltip', text: q.simple })];
}

/** Nom du groupe de réponses : la question et son aide (sans le bouton de l'infobulle). */
const nameOf = (q) => [`titre-texte-${q.id}`, q.hint && `aide-${q.id}`].filter(Boolean).join(' ');

function legendFor(q) {
  const legend = el('legend', { class: 'fr-fieldset__legend', id: `legend-${q.id}` }, titleFor(q));
  if (q.hint) legend.append(el('span', { class: 'fr-hint-text', id: `aide-${q.id}`, text: q.hint }));
  return legend;
}

function choiceGroup(q, kind, options) {
  const fs = el('fieldset', {
    class: 'fr-fieldset',
    id: `field-${q.id}`,
    'aria-labelledby': nameOf(q),
  }, legendFor(q));
  for (const o of options) {
    const id = `${q.id}__${o.id}`;
    fs.append(el('div', { class: 'fr-fieldset__element' },
      el('div', { class: kind === 'radio' ? 'fr-radio-group' : 'fr-checkbox-group' },
        el('input', { type: kind, id, name: q.id, value: o.id }),
        el('label', { class: 'fr-label', for: id, text: o.label }))));
  }
  return fs;
}

/**
 * Question à saisir : le titre de la question, puis le champ « Votre réponse ». Le nom du champ
 * reprend la question et l'aide (aria-labelledby), pour qu'il soit explicite hors contexte.
 */
function inputGroup(q, { textarea = false, hint } = {}) {
  const id = `field-${q.id}`;
  const label = el('label', { class: 'fr-label', for: id, id: `label-${q.id}` }, 'Votre réponse');
  const hintText = [hint || q.hint, 'Écrivez-la ici, ou appuyez sur « Parler » : ce que vous dites s’écrit dans ce champ.']
    .filter(Boolean).join(' ');
  label.append(el('span', { class: 'fr-hint-text', text: hintText }));
  const input = textarea
    ? el('textarea', { class: 'fr-input', id, name: q.id, rows: 6, 'aria-labelledby': `titre-texte-${q.id} label-${q.id}` })
    : el('input', { class: 'fr-input', id, name: q.id, type: 'text', autocomplete: 'off', 'aria-labelledby': `titre-texte-${q.id} label-${q.id}` });
  const err = el('p', { class: 'fr-error-text', id: `err-${q.id}`, hidden: true });
  if (q.type === 'number') input.setAttribute('inputmode', 'decimal');
  return el('div', { class: 'fr-mb-3w' }, titleFor(q), el('div', { class: 'fr-input-group', id: `group-${q.id}` }, label, input, err));
}

// Date : bloc DSFR « Date unique », trois champs Jour / Mois / Année avec un exemple chacun.
const DATE_PARTS = [
  { id: 'jour', label: 'Jour', hint: 'Exemple : 15', size: 2, cls: 'fr-fieldset__element--number' },
  { id: 'mois', label: 'Mois', hint: 'Exemple : 3', size: 2, cls: 'fr-fieldset__element--number' },
  { id: 'annee', label: 'Année', hint: 'Exemple : 2024', size: 4, cls: 'fr-fieldset__element--year fr-fieldset__element--inline-grow' },
];

function dateGroup(q) {
  const messages = `messages-${q.id}`;
  const fs = el('fieldset', {
    class: 'fr-fieldset', id: `field-${q.id}`, role: 'group', 'aria-labelledby': `${nameOf(q)} ${messages}`,
  }, legendFor(q));
  for (const part of DATE_PARTS) {
    const id = `${q.id}__${part.id}`;
    fs.append(el('div', { class: `fr-fieldset__element fr-fieldset__element--inline ${part.cls}` },
      el('div', { class: 'fr-input-group' },
        el('label', { class: 'fr-label', for: id, text: part.label }, el('span', { class: 'fr-hint-text', text: part.hint })),
        el('input', {
          class: 'fr-input', id, name: id, type: 'text', inputmode: 'numeric', maxlength: part.size, autocomplete: 'off', 'data-date': part.id,
        }))));
  }
  fs.append(el('div', { class: 'fr-messages-group', id: messages, 'aria-live': 'polite' }));
  return fs;
}

/** Libellé d'une colonne à l'écran (unité comprise). */
const columnLabel = (c) => (c.kind === 'money' ? `${c.label} (en €)` : c.label) + (c.optional ? OPTIONAL : '');

/** Champ d'une information : liste de choix, montant (nombre) ou texte libre, avec son libellé et son aide. */
function itemField(q, c, i) {
  const id = `${q.id}__${i}__${c.id}`;
  const attrs = { id, 'data-row': i, 'data-col': c.id };
  const label = el('label', { class: 'fr-label', for: id, text: columnLabel(c) },
    c.hint && el('span', { class: 'fr-hint-text', text: c.hint }));
  if (c.options) {
    return el('div', { class: 'fr-select-group' }, label, el('select', { class: 'fr-select', ...attrs },
      el('option', { value: '', text: 'Choisir' }),
      ...c.options.map((o) => el('option', { value: o, text: o }))));
  }
  const input = c.kind === 'money'
    ? el('input', { class: 'fr-input', type: 'number', min: '0', step: '1', inputmode: 'numeric', autocomplete: 'off', ...attrs })
    : el('input', { class: 'fr-input', type: 'text', autocomplete: 'off', ...attrs });
  return el('div', { class: 'fr-input-group' }, label, input);
}

/**
 * Question « tableau » (frais, établissements) : le titre et « Rien à déclarer », puis un bloc par
 * élément (« Frais 1 »…). Un seul bloc au départ ; « Ajouter un autre frais » en ouvre un de plus
 * (jusqu'au maximum du Cerfa) ; les éléments remplis (à l'oral par exemple) restent affichés.
 * Sur grand écran, les champs d'un bloc sont sur deux colonnes. « Rien à déclarer » masque les blocs.
 */
function tableGroup(q) {
  const fs = el('fieldset', { class: 'fr-fieldset', id: `field-${q.id}`, 'aria-labelledby': nameOf(q) }, legendFor(q));
  const none = `${q.id}__${NONE}`;
  fs.append(el('div', { class: 'fr-fieldset__element' },
    el('div', { class: 'fr-checkbox-group' },
      el('input', { type: 'checkbox', id: none, name: `${q.id}__none` }),
      el('label', { class: 'fr-label', for: none, text: q.noneLabel || 'Rien à déclarer' }))));
  const blocks = Array.from({ length: q.maxRows || 3 }, (_, i) => el('fieldset', {
    class: 'fr-fieldset fr-mb-1w bloc-element', 'aria-labelledby': `element-${q.id}-${i}`, 'data-element': i, hidden: i > 0,
  },
  el('legend', { class: 'fr-fieldset__legend', id: `element-${q.id}-${i}`, text: `${q.rowLabel || 'Élément'} ${i + 1}` }),
  el('div', { class: 'fr-fieldset__element' },
    el('div', { class: 'fr-grid-row fr-grid-row--gutters' },
      ...q.columns.map((c) => el('div', { class: c.wide ? 'fr-col-12' : 'fr-col-12 fr-col-md-6' }, itemField(q, c, i)))))));
  const add = el('button', {
    type: 'button', class: 'fr-btn fr-btn--secondary fr-btn--icon-left fr-icon-add-line', 'data-ajouter': q.id,
  }, q.addLabel || 'Ajouter');
  // Entre deux blocs, un séparateur DSFR : on voit où finit « Frais 1 » et où commence « Frais 2 ».
  const parts = blocks.flatMap((b, i) => (i ? [el('hr', { class: 'fr-hr fr-mt-1w', 'data-separateur': i, hidden: true }), b] : [b]));
  return el('div', {}, fs, ...parts,
    el('ul', { class: 'fr-btns-group fr-btns-group--inline-sm fr-btns-group--icon-left fr-mb-2w' }, el('li', {}, add)));
}

/**
 * Blocs affichés : au moins un, tous ceux qui sont remplis, et ceux ouverts par « Ajouter ».
 * « Rien à déclarer » coché : aucun bloc ni bouton « Ajouter » (rien à remplir, rien à afficher).
 */
function showElements(block, q, wanted = 1) {
  const none = block.querySelector(`input[name="${q.id}__none"]`).checked;
  const filled = [...block.querySelectorAll('[data-row]')].filter((c) => c.value).map((c) => +c.dataset.row);
  const shown = [...block.querySelectorAll('.bloc-element:not([hidden])')].length;
  const count = none ? 0 : Math.min(q.maxRows || 3, Math.max(wanted, shown, ...filled.map((r) => r + 1)));
  block.querySelectorAll('.bloc-element').forEach((b) => { b.hidden = +b.dataset.element >= count; });
  block.querySelectorAll('[data-separateur]').forEach((hr) => { hr.hidden = +hr.dataset.separateur >= count; });
  block.querySelector('[data-ajouter]').closest('ul').hidden = none || count >= (q.maxRows || 3);
  return count;
}

/** « Rien à déclarer » coché : les cellules sont vidées et les blocs masqués ; décoché, un bloc vide revient. */
function syncTableNone(block, q) {
  const none = block.querySelector(`input[name="${q.id}__none"]`).checked;
  if (none) block.querySelectorAll('[data-row]').forEach((cell) => { cell.value = ''; });
  showElements(block, q);
}

function renderQuestion(q) {
  switch (q.type) {
    case 'single': return choiceGroup(q, 'radio', q.options);
    case 'multi': return choiceGroup(q, 'checkbox',
      q.allowNone ? [...q.options, { id: NONE, label: 'Cela ne me concerne pas' }] : q.options);
    case 'yesno': {
      const fs = choiceGroup(q, 'radio', [{ id: 'oui', label: 'Oui' }, { id: 'non', label: 'Non' }]);
      fs.classList.add('fr-fieldset--inline');
      return fs;
    }
    case 'date': return dateGroup(q);
    case 'number': return inputGroup(q, { hint: q.unit ? `En ${q.unit}. Exemple : 20.` : undefined });
    case 'longtext': return inputGroup(q, { textarea: true });
    case 'table': return tableGroup(q);
    default: return inputGroup(q);
  }
}

// Champs de précision (« Autre : précisez », nom de l'établissement…) : questions texte qui
// dépendent d'une option d'une question à choix. Ils s'affichent dans cette question, sous l'option.
let PARENTS = {}; // { id du champ de précision : { parent, option } }

function findParents(schema) {
  const byId = Object.fromEntries(schema.questions.map((q) => [q.id, q]));
  const parents = {};
  for (const q of schema.questions) {
    const w = q.when || {};
    const p = byId[w.q];
    const option = w.includes ?? w.eq;
    if (p && option && (q.type === 'text' || q.type === 'longtext') && ['single', 'multi', 'yesno'].includes(p.type)) {
      parents[q.id] = { parent: p.id, option };
    }
  }
  return parents;
}

// Questions de suivi (« Propriétaire ou locataire », dates des indemnités…) : questions qui dépendent
// d'une réponse à une question à choix de la même étape. Elles s'affichent dans la carte de cette
// question, après ses réponses, et ne comptent pas dans le total « Question 2 sur N ».
let FOLLOWS = {}; // { id de la question de suivi : id de la question d'origine }

function findFollowUps(schema, parents) {
  const byId = Object.fromEntries(schema.questions.map((q) => [q.id, q]));
  const stepOf = (q) => schema.steps.findIndex((s) => s.sections.includes(q.section));
  const follows = {};
  for (const q of schema.questions) {
    const w = q.when;
    const p = w && !w.anyOf && byId[w.q];
    if (!p || parents[q.id] || stepOf(p) !== stepOf(q) || !['single', 'multi', 'yesno'].includes(p.type)) continue;
    follows[q.id] = p.id;
  }
  return follows;
}

/** Question dont `qid` est le champ de précision ou la question de suivi, ou null. */
export const parentOf = (qid) => PARENTS[qid]?.parent || FOLLOWS[qid] || null;

/** Question de suivi (affichée dans la carte d'une autre question), et non champ de précision. */
export const isFollowUp = (qid) => Boolean(FOLLOWS[qid]);

/** Question principale (la carte affichée) : en remontant les questions de suivi et de précision. */
export const rootOf = (qid) => {
  let id = qid;
  while (parentOf(id)) id = parentOf(id);
  return id;
};

/** Champ de précision, dans la question à choix : son libellé suffit (pas de titre à part). */
function precisionBlock(q) {
  const id = `field-${q.id}`;
  const label = el('label', { class: 'fr-label', for: id }, q.label,
    el('span', { class: 'fr-hint-text', text: 'Écrivez-la ici, ou dites-la après avoir appuyé sur « Parler ».' }));
  const input = q.type === 'longtext'
    ? el('textarea', { class: 'fr-input', id, name: q.id, rows: 4 })
    : el('input', { class: 'fr-input', id, name: q.id, type: 'text', autocomplete: 'off' });
  const err = el('p', { class: 'fr-error-text', id: `err-${q.id}`, hidden: true });
  return el('div', { class: 'fr-fieldset__element fr-pl-4w bloc-precision', id: `q-${q.id}`, 'data-qid': q.id, hidden: true },
    el('div', { class: 'fr-input-group', id: `group-${q.id}` }, label, input, err));
}

/**
 * Construit le formulaire : un bloc par question, tous masqués sauf la question en cours
 * (voir showQuestion). Les champs de précision sont placés dans leur question, sous l'option
 * qui les fait apparaître. `onChange(qid, value)` : l'usager a modifié un champ à la main.
 */
export function renderForm(root, schema, { onChange }) {
  root.replaceChildren();
  PARENTS = findParents(schema);
  FOLLOWS = findFollowUps(schema, PARENTS);
  const render = (q) => {
    const node = renderQuestion(q);
    // Infobulle hors de la légende (en gras) : son texte ne doit pas être mis en forme (DSFR).
    const tip = node.querySelector('legend .fr-tooltip');
    if (tip) tip.closest('fieldset').append(tip);
    return node;
  };
  for (const q of schema.questions) {
    if (PARENTS[q.id] || FOLLOWS[q.id]) continue;
    root.append(el('div', { class: 'bloc-question', id: `q-${q.id}`, 'data-qid': q.id, hidden: true }, render(q)));
  }
  // Questions de suivi : dans la carte de la question d'origine, après toutes ses réponses (et un
  // séparateur), avec un titre d'un niveau en dessous (h4).
  for (const q of schema.questions) {
    const parentId = FOLLOWS[q.id];
    if (!parentId) continue;
    const parent = root.querySelector(`#q-${CSS.escape(parentId)}`);
    let group = parent.querySelector(':scope > .bloc-suivis');
    if (!group) {
      group = el('div', { class: 'bloc-suivis fr-mb-3w', hidden: true }, el('hr', { class: 'fr-hr fr-mt-2w' }));
      parent.append(group);
    }
    const node = render(q);
    node.querySelectorAll(`#titre-${CSS.escape(q.id)}`).forEach((h3) => {
      const h4 = el('h4', { class: 'fr-h6 fr-mb-1w', id: h3.id, tabindex: '-1' });
      h4.append(...h3.childNodes);
      h3.replaceWith(h4);
    });
    group.append(el('div', { class: 'bloc-suivi', id: `q-${q.id}`, 'data-qid': q.id, hidden: true }, node));
  }
  for (const q of schema.questions) {
    const link = PARENTS[q.id];
    if (!link) continue;
    const parent = root.querySelector(`#q-${CSS.escape(link.parent)}`);
    const parentQ = schema.questions.find((x) => x.id === link.parent);
    const sub = precisionBlock(q);
    // Sous l'option concernée ; pour « Oui / Non » (en ligne), après les deux réponses.
    const option = parentQ.type !== 'yesno' && parent.querySelector(`input[value="${CSS.escape(link.option)}"]`)?.closest('.fr-fieldset__element');
    if (option) {
      // Après les éventuels autres champs de précision déjà placés sous cette option.
      let after = option;
      while (after.nextElementSibling?.classList.contains('bloc-precision')) after = after.nextElementSibling;
      after.after(sub);
    } else {
      parent.append(sub);
    }
  }

  root.addEventListener('change', (e) => {
    const block = e.target.closest('[data-qid]');
    if (!block) return;
    const q = schema.questions.find((x) => x.id === block.dataset.qid);
    if (q.type === 'multi') {
      // « Cela ne me concerne pas » est exclusif des autres cases.
      const boxes = [...block.querySelectorAll(`input[name="${q.id}"]`)];
      if (e.target.value === NONE && e.target.checked) boxes.forEach((b) => { if (b.value !== NONE) b.checked = false; });
      else if (e.target.checked) boxes.forEach((b) => { if (b.value === NONE) b.checked = false; });
    }
    if (q.type === 'table' && e.target.name === `${q.id}__none`) syncTableNone(block, q);
    const value = readValue(block, q);
    validate(block, q, value);
    onChange(q.id, value);
  });
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ajouter]');
    if (!btn) return;
    const q = schema.questions.find((x) => x.id === btn.dataset.ajouter);
    const block = btn.closest('[data-qid]');
    const count = showElements(block, q, block.querySelectorAll('.bloc-element:not([hidden])').length + 1);
    block.querySelector(`[data-row="${count - 1}"]`)?.focus();
  });
}

function readValue(block, q) {
  switch (q.type) {
    case 'single':
    case 'yesno':
      return block.querySelector(`input[name="${q.id}"]:checked`)?.value ?? null;
    case 'multi':
      return [...block.querySelectorAll(`input[name="${q.id}"]:checked`)].map((i) => i.value);
    case 'table': {
      if (block.querySelector(`input[name="${q.id}__none"]`).checked) return [];
      const rows = [];
      block.querySelectorAll('[data-row]').forEach((i) => {
        const r = +i.dataset.row;
        rows[r] = rows[r] || {};
        // Montant saisi avec des centimes : arrondi à l'euro, et affiché ainsi dans le champ.
        if (i.type === 'number' && i.value) i.value = String(Math.round(Number(i.value)));
        rows[r][i.dataset.col] = i.value.trim();
      });
      // Rien de rempli (et « Rien à déclarer » non coché) : pas de réponse.
      const filled = rows.filter((r) => Object.values(r).some(Boolean));
      return filled.length ? filled : null;
    }
    case 'date': {
      const [d, m, y] = DATE_PARTS.map((p) => block.querySelector(`[data-date="${p.id}"]`).value.trim());
      if (!d && !m && !y) return null;
      const pad2 = (v) => (/^\d$/.test(v) ? `0${v}` : v);
      return `${pad2(d)}/${pad2(m)}/${y}`;
    }
    case 'number': {
      const raw = block.querySelector('.fr-input').value.trim().replace(',', '.');
      if (!raw) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    default:
      return block.querySelector('.fr-input').value.trim() || null;
  }
}

const pad = (n) => String(n).padStart(2, '0');

/** Message d'erreur pour une date JJ/MM/AAAA, ou '' si elle est valable pour la question. */
export function dateError(q, value) {
  if (q.type !== 'date' || !value) return '';
  // Champs manquants nommés : « Indiquez le mois. », « Indiquez le jour et le mois. »
  const missing = ['le jour', 'le mois', 'l’année'].filter((_, i) => !value.split('/')[i]);
  if (missing.length) return `Indiquez ${missing.length > 1 ? `${missing.slice(0, -1).join(', ')} et ${missing.at(-1)}` : missing[0]}.`;
  if (!DATE_RE.test(value)) return 'Indiquez la date en chiffres. Exemple : 15 pour le jour, 3 pour le mois et 2024 pour l’année.';
  const [d, m, y] = value.split('/').map(Number);
  const date = new Date(y, m - 1, d);
  if (date.getMonth() !== m - 1) return 'Cette date n’existe pas. Vérifiez le jour et le mois.';
  if (q.beforeToday) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (date >= today) {
      return `La date doit être avant aujourd’hui, le ${pad(today.getDate())}/${pad(today.getMonth() + 1)}/${today.getFullYear()}.`;
    }
  }
  return '';
}

function validate(block, q, value) {
  if (q.type === 'date') {
    const fs = block.querySelector(`#field-${CSS.escape(q.id)}`);
    // Date en cours de saisie (année pas encore remplie) : pas encore d'erreur « incomplète ».
    const typing = value && !value.split('/')[2];
    const msg = typing ? '' : dateError(q, value);
    fs.classList.toggle('fr-fieldset--error', !!msg);
    block.querySelector(`#messages-${CSS.escape(q.id)}`).replaceChildren(
      ...(msg ? [el('p', { class: 'fr-message fr-message--error', text: msg })] : []));
    return;
  }
  if (q.type !== 'number') return;
  const group = block.querySelector('.fr-input-group');
  const input = group.querySelector('.fr-input');
  const err = group.querySelector('.fr-error-text');
  let msg = dateError(q, value);
  if (q.type === 'number' && value != null && typeof value !== 'number') msg = 'Indiquez un nombre. Exemple : 20.';
  group.classList.toggle('fr-input-group--error', !!msg);
  err.textContent = msg;
  err.hidden = !msg;
  if (msg) input.setAttribute('aria-describedby', err.id);
  else input.removeAttribute('aria-describedby');
}

export function writeValue(root, q, value) {
  const block = root.querySelector(`#q-${CSS.escape(q.id)}`);
  if (!block) return;
  switch (q.type) {
    case 'single':
    case 'yesno':
      block.querySelectorAll(`input[name="${q.id}"]`).forEach((i) => { i.checked = i.value === value; });
      break;
    case 'multi': {
      const arr = asArray(value);
      block.querySelectorAll(`input[name="${q.id}"]`).forEach((i) => { i.checked = arr.includes(i.value); });
      break;
    }
    case 'table': {
      const rows = asArray(value);
      block.querySelector(`input[name="${q.id}__none"]`).checked = Array.isArray(value) && value.length === 0;
      block.querySelectorAll('[data-row]').forEach((cell) => {
        const v = String(rows[+cell.dataset.row]?.[cell.dataset.col] ?? '');
        const col = q.columns.find((c) => c.id === cell.dataset.col);
        if (col.kind === 'money') {
          // Montant à l'euro près : « 45,50 € » dit à l'oral → 46.
          const n = v.replace(/[\s\u202f]/g, '').replace(',', '.').match(/\d+(?:\.\d+)?/)?.[0];
          cell.value = n ? String(Math.round(Number(n))) : '';
        } else if (col.options && v && !col.options.includes(v)) {
          // Réponse hors liste (dite à l'oral) : gardée telle quelle comme choix supplémentaire.
          if (![...cell.options].some((o) => o.value === v)) cell.append(el('option', { value: v, text: v }));
          cell.value = v;
        } else {
          cell.value = v;
        }
      });
      syncTableNone(block, q);
      break;
    }
    case 'date': {
      const parts = (value || '').split('/');
      DATE_PARTS.forEach((p, i) => { block.querySelector(`[data-date="${p.id}"]`).value = parts[i] ?? ''; });
      break;
    }
    default:
      block.querySelector('.fr-input').value = value ?? '';
  }
  validate(block, q, value);
}

/**
 * Affiche seulement la question `qid` (aucune si `qid` est vide) ; pour un champ de précision,
 * sa question à choix. Les champs de précision visibles (`visible`) apparaissent sous leur option.
 */
export function showQuestion(root, qid, visible = {}) {
  const top = qid && rootOf(qid);
  root.querySelectorAll('.bloc-question').forEach((b) => { b.hidden = b.dataset.qid !== top; });
  root.querySelectorAll('.bloc-precision, .bloc-suivi').forEach((b) => { b.hidden = !visible[b.dataset.qid]; });
  // Le séparateur des questions de suivi n'apparaît que s'il y en a au moins une d'affichée.
  root.querySelectorAll('.bloc-suivis').forEach((g) => { g.hidden = !g.querySelector('.bloc-suivi:not([hidden])'); });
}
