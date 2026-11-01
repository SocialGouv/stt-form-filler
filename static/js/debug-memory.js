// Panneau de débogage de la mémoire (développement seulement : MEMOIRE_DEBUG=1 sur le serveur).
// Montre la mémoire évoluer pendant la conversation : faits (avec leur citation et leur statut),
// transcription et appels à l'IA. Absent de la page sans le drapeau. Composants DSFR tels quels :
// grille (avec gouttières), accordéons, badges, lien de téléchargement.

const STATUS = {
  proposed: ['Proposé', 'fr-badge--info'],
  confirmed: ['Confirmé', 'fr-badge--success'],
  rejected: ['Refusé', 'fr-badge--error'],
  superseded: ['Remplacé', ''],
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.flat().filter((c) => c != null));
  return node;
}

const time = (iso) => new Date(iso).toLocaleTimeString('fr-FR');

function accordion(id, title, open = false) {
  const body = el('div', { id, class: 'fr-collapse' });
  const btn = el('button', {
    type: 'button', class: 'fr-accordion__btn', 'aria-expanded': String(open), 'aria-controls': id,
  });
  const section = el('section', { class: 'fr-accordion' }, el('h3', { class: 'fr-accordion__title' }, btn), body);
  return { section, body, setTitle: (t) => { btn.textContent = t; } };
}

/**
 * Ajoute le panneau à côté de la colonne principale et le tient à jour.
 * `calls` : journal des appels à l'IA (main.js) ; `onCall(fn)` : abonnement à ses ajouts.
 */
export function mountDebugPanel({ memory, calls, schema, onCall, column }) {
  const short = (qid) => (qid ? schema.questions.find((q) => q.id === qid)?.short || qid : 'aucune (pour plus tard)');
  const facts = accordion('debug-faits', 'Faits', true);
  const transcript = accordion('debug-transcription', 'Transcription');
  const log = accordion('debug-appels', 'Journal');
  const download = el('a', { class: 'fr-link fr-link--download', id: 'debug-telecharger', download: 'memoire-mdph.json' },
    'Télécharger la mémoire ', el('span', { class: 'fr-link__detail', text: 'JSON' }));

  // Colonne à part, encadrée (fond gris) : elle se distingue des questions. Les gouttières de la grille
  // DSFR, ajoutées à la ligne seulement avec le panneau, l'écartent de la colonne des questions.
  const panel = el('aside', {
    id: 'debug-memoire', class: 'fr-col-12 fr-col-lg-4 fr-mt-3w fr-mt-md-0', 'aria-labelledby': 'debug-memoire-titre',
  },
  el('div', { class: 'fr-background-alt--grey fr-p-2w' },
    el('h2', { class: 'fr-h5 fr-mb-1w', id: 'debug-memoire-titre', text: 'Mémoire (débogage)' }),
    el('p', { class: 'fr-text--sm fr-mb-2w', text: 'Visible en développement seulement. Données fictives uniquement. Journal : appels à l’IA et fins de réponse.' }),
    el('div', { class: 'fr-accordions-group' }, facts.section, transcript.section, log.section),
    el('p', { class: 'fr-mt-2w fr-mb-0' }, download)));
  column.parentElement.classList.add('fr-grid-row--gutters');
  column.after(panel);

  function renderFacts() {
    const list = [...memory.facts].reverse();
    facts.setTitle(`Faits (${memory.active().length} valables, ${memory.facts.length} au total)`);
    if (!list.length) {
      facts.body.replaceChildren(el('p', { class: 'fr-text--sm', text: 'Aucun fait pour l’instant.' }));
      return;
    }
    // Liste plutôt que tableau : la colonne est étroite, chaque fait s'y lit de haut en bas.
    const items = list.map((f, i) => {
      const [label, variant] = STATUS[f.status] || [f.status, ''];
      return el('li', { class: i ? 'fr-mt-2w' : null },
        el('p', { class: `fr-badge fr-badge--sm ${variant} fr-mb-1v`.trim(), text: label }),
        el('p', { class: 'fr-text--sm fr-text--bold fr-mb-0', text: f.fact || '—' }),
        el('p', { class: 'fr-text--xs fr-mb-0', text: `Question : ${short(f.qid)}` }),
        el('p', { class: 'fr-text--xs fr-mb-0', text: `« ${f.quote || ''} » · ${f.id} · ${time(f.t)}${f.supersededBy ? ` · remplacé par ${f.supersededBy}` : ''}` }));
    });
    facts.body.replaceChildren(el('ul', { class: 'fr-raw-list', 'aria-label': 'Faits en mémoire, du plus récent au plus ancien' }, items));
  }

  function renderTranscript() {
    const last = memory.transcript.slice(-30).reverse();
    transcript.setTitle(`Transcription (${memory.transcript.length})`);
    transcript.body.replaceChildren(last.length
      ? el('ul', { class: 'fr-text--sm' }, last.map((s) => el('li', {},
        el('span', { class: 'fr-text--bold', text: `${time(s.t)} ${s.role === 'usager' ? 'Usager' : 'Assistant'} : ` }), s.text)))
      : el('p', { class: 'fr-text--sm', text: 'Rien pour l’instant.' }));
  }

  function renderCalls() {
    log.setTitle(`Journal (${calls.length})`);
    log.body.replaceChildren(calls.length
      ? el('ul', { class: 'fr-text--sm' }, calls.map((c) => (c.kind === 'fin de réponse'
        ? el('li', {}, el('span', { class: 'fr-text--bold', text: `${time(c.at)} fin de réponse – ${c.ms} ms de silence` }), ` – ${c.text}`)
        : el('li', {},
        el('span', { class: 'fr-text--bold', text: `${time(c.at)} ${c.kind} – ${c.ms} ms` }),
        c.error ? ` – erreur : ${c.error}` : ` – ${c.kept} fait(s) gardé(s), ${c.rejected.length} refusé(s)`,
        c.rejected.length ? ` (${c.rejected.map((r) => `${r.reason}${r.qid ? ` [${r.qid}]` : ''} : ${r.fact ? `${r.fact} ` : ''}« ${r.quote} »`).join(' ; ')})` : '',
        el('br'), el('span', { class: 'fr-text--xs', text: `« ${c.text} »` })))))
      : el('p', { class: 'fr-text--sm', text: 'Aucun appel pour l’instant.' }));
  }

  function renderDownload() {
    if (download.href.startsWith('blob:')) URL.revokeObjectURL(download.href);
    const blob = new Blob([JSON.stringify(memory, null, 2)], { type: 'application/json' });
    download.href = URL.createObjectURL(blob);
    download.querySelector('.fr-link__detail').textContent = `JSON – ${Math.max(1, Math.round(blob.size / 1024))} ko`;
  }

  const renderMemory = () => { renderFacts(); renderTranscript(); renderDownload(); };
  memory.onChange(renderMemory);
  onCall(renderCalls);
  renderMemory();
  renderCalls();
  return panel;
}
