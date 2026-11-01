// Mémoire de la conversation : « le dire une fois ».
// - Transcription : journal de tout l'échange (usager et assistant), jamais réécrit. C'est la source
//   de vérité, et le fichier que l'usager peut télécharger à la fin.
// - Faits : petites informations tirées de la transcription, chacune liée à une question du
//   formulaire (ou à aucune), avec la citation exacte qui la justifie. Un fait corrigé n'est pas
//   effacé : il est marqué « remplacé » par le nouveau.
// Module sans DOM : l'état est sérialisé avec les réponses (main.js, save / restore).

/** Statuts d'un fait : proposé (tiré de la conversation), confirmé par l'usager, refusé, remplacé. */
export const ACTIVE = ['proposed', 'confirmed'];

const plain = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\W+/g, ' ').trim();

/** Clé d'un fait : même question et même valeur (ou même phrase pour un fait sans question). */
export function factKey(f) {
  if (!f.qid) return `-:${plain(f.fact)}`;
  const selected = [...(f.selected || [])].sort();
  // Question à choix : seules les options comptent (une date ou un détail en plus n'en fait pas un autre fait).
  if (selected.length) return `${f.qid}:${JSON.stringify(selected)}`;
  return `${f.qid}:${JSON.stringify([!!f.none_apply, f.yes_no ?? null, f.date ?? null, f.number ?? null, plain(f.text)])}`;
}

export class Memory {
  constructor(data) {
    this.listeners = new Set();
    this.load(data);
  }

  load(data) {
    this.transcript = Array.isArray(data?.transcript) ? data.transcript : [];
    this.facts = Array.isArray(data?.facts) ? data.facts : [];
    this.seq = Number(data?.seq) || 0;
    this.emit();
  }

  toJSON() {
    return { transcript: this.transcript, facts: this.facts, seq: this.seq };
  }

  clear() {
    this.load(null);
  }

  /** `fn(memory)` est appelée à chaque changement ; renvoie de quoi se désabonner. */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    this.listeners?.forEach((fn) => fn(this));
  }

  nextId(prefix) {
    this.seq += 1;
    return `${prefix}${this.seq}`;
  }

  /** Ajoute une phrase à la transcription : `role` 'usager' ou 'assistant', `qid` question en cours. */
  addSegment({ role, qid = null, text }) {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    const seg = { id: this.nextId('s'), t: new Date().toISOString(), role, qid, text };
    this.transcript.push(seg);
    this.emit();
    return seg;
  }

  /**
   * Ajoute des faits renvoyés par le serveur (déjà vérifiés : question connue, valeur valide,
   * citation présente dans la phrase). `replaces` : identifiant d'un fait que celui-ci corrige.
   */
  addFacts(facts, { segId = null } = {}) {
    const added = [];
    const known = new Set(this.active().map(factKey));
    for (const f of facts || []) {
      // Déjà en mémoire avec la même valeur (dit deux fois, ou extrait puis réinterprété) : ignoré.
      if (known.has(factKey(f))) continue;
      known.add(factKey(f));
      const fact = {
        ...f,
        id: this.nextId('f'),
        t: new Date().toISOString(),
        segId,
        status: 'proposed',
      };
      const old = f.replaces && this.facts.find((x) => x.id === f.replaces && ACTIVE.includes(x.status));
      if (old) {
        old.status = 'superseded';
        old.supersededBy = fact.id;
      }
      this.facts.push(fact);
      added.push(fact);
    }
    if (added.length) this.emit();
    return added;
  }

  setStatus(id, status) {
    const fact = this.facts.find((x) => x.id === id);
    if (!fact || fact.status === status) return;
    fact.status = status;
    this.emit();
  }

  /** Faits encore valables (proposés ou confirmés). */
  active() {
    return this.facts.filter((f) => ACTIVE.includes(f.status));
  }

  activeFactsFor(qid) {
    return this.active().filter((f) => f.qid === qid);
  }

  /** Forme courte envoyée au serveur : il sait ce qui a déjà été dit, sans tout l'historique. */
  compact() {
    return this.active().map((f) => ({ id: f.id, qid: f.qid ?? null, text: f.fact || '' }));
  }

  /**
   * Transcription en texte brut, regroupée par question (titre = intitulé de la question).
   * `schema` : le questionnaire (form-b.json), pour les intitulés.
   */
  toTxt(schema, now = new Date()) {
    const label = (qid) => schema?.questions?.find((q) => q.id === qid)?.label;
    const time = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const day = (iso) => new Date(iso).toLocaleDateString('fr-FR');
    const lines = [
      `${schema?.title || 'Formulaire MDPH'} : transcription de l'échange`,
      `Téléchargée le ${day(now.toISOString())} à ${time(now.toISOString())}.`,
    ];
    let currentQ;
    let currentDay;
    for (const seg of this.transcript) {
      if (day(seg.t) !== currentDay) {
        currentDay = day(seg.t);
        lines.push('', `--- ${currentDay} ---`);
      }
      if (seg.qid !== currentQ) {
        currentQ = seg.qid;
        lines.push('', `== ${label(seg.qid) || 'Échange général'} ==`);
      }
      lines.push(`[${time(seg.t)}] ${seg.role === 'usager' ? 'Vous' : 'Assistant'} : ${seg.text}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
