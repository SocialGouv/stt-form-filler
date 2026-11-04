// Synthèse vocale et reconnaissance vocale.
// Voix : Piper (voix neuronale open source, sur notre serveur) si disponible,
// sinon la synthèse du navigateur (Web Speech API). Écoute : Web Speech API.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
export const canListen = Boolean(Recognition);
export const canSpeak = 'speechSynthesis' in window || typeof Audio !== 'undefined';
const canBrowserSpeak = 'speechSynthesis' in window;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Dire « j'ai fini de parler » termine l'écoute ; ces mots ne font pas partie de la réponse.
const END_PHRASE = /[\s,.]*\b(j[’']?\s?ai (fini|terminé)( de parler)?)[\s.!]*$/i;

/** Découpe en phrases (au moins ~60 caractères par morceau) pour commencer à parler plus vite. */
function splitSentences(text) {
  const parts = text.match(/[^.!?…;]+[.!?…;]*\s*/g) || [text];
  const chunks = [];
  for (const part of parts) {
    const last = chunks.length - 1;
    if (last >= 0 && (chunks[last].length < 60 || part.trim().length < 12)) chunks[last] += part;
    else chunks.push(part);
  }
  return chunks.map((c) => c.trim()).filter(Boolean);
}

// ---------- Bips de début et de fin d'écoute ----------
// Générés par le navigateur (Web Audio) : pas de fichier son.
let audioCtx = null;

/** À appeler pendant un clic de l'usager : le navigateur n'autorise le son qu'après une action. */
export function initBeeps() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume?.();
  } catch { /* pas de son possible : l'état reste affiché à l'écran */ }
}

/** Bip court et doux : montant quand le micro s'ouvre, descendant quand il se ferme. */
export function beep(kind) {
  if (!audioCtx) return;
  try {
    audioCtx.resume?.();
    const [from, to] = kind === 'start' ? [660, 990] : [880, 520];
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.linearRampToValueAtTime(to, t + 0.12);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.2);
  } catch { /* son indisponible */ }
}

/**
 * « Tic » bref et doux, à hauteur fixe (différent des bips d'écoute) : joué entre deux
 * réponses possibles lues à voix haute. Se résout après le son.
 */
export function tick() {
  if (!audioCtx) return wait(150);
  try {
    audioCtx.resume?.();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1500, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.08);
  } catch { /* son indisponible */ }
  return wait(220);
}

/** Séparateur à placer entre les réponses possibles : la voix joue un « tic » à cet endroit. */
export const OPTION_BREAK = '\u241E';

/** WAV silencieux très court : le jouer pendant un clic autorise la lecture audio ensuite (Safari). */
function silentWav() {
  const buf = new ArrayBuffer(46);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 38, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, 2, true); v.setInt16(44, 0, true);
  return new Blob([buf], { type: 'audio/wav' });
}

export class Speaker {
  constructor() {
    this.enabled = true;
    this.rate = 0.9;
    this.engine = 'browser'; // 'piper' ou 'browser'
    this.piperVoice = 'femme';
    this.onFallback = null; // appelé si la voix Piper ne répond pas
    this.session = 0;
    this.state = 'idle'; // 'speaking', 'paused' ou 'idle'
    this.onState = null; // appelé à chaque changement d'état
    this.resumers = []; // lectures en attente de la fin de la pause
    this.audio = typeof Audio !== 'undefined' ? new Audio() : null;
    this.voice = null;
    if (!canBrowserSpeak) return;
    // Voix du navigateur : on préfère les voix « naturelles » ou « premium » quand elles existent.
    const score = (v) => (/natural|neural|premium|enhanced|amélioré|online/i.test(v.name) ? 4 : 0)
      + (/google/i.test(v.name) ? 3 : 0) + (v.lang === 'fr-FR' ? 2 : 0);
    const pick = () => {
      const voices = speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith('fr'));
      this.voice = voices.sort((a, b) => score(b) - score(a))[0] || null;
    };
    pick();
    speechSynthesis.addEventListener?.('voiceschanged', pick);
  }

  /** À appeler pendant un clic de l'usager : débloque la lecture audio pour la suite. */
  unlock() {
    initBeeps();
    if (!this.audio || this.unlocked) return;
    this.unlocked = true;
    this.audio.src = URL.createObjectURL(silentWav());
    this.audio.play().catch(() => {});
  }

  /**
   * Lit le texte ; la promesse se résout à la fin de la lecture (ou tout de suite si désactivé).
   * Un « tic » est joué à chaque OPTION_BREAK (passage d'une réponse possible à la suivante).
   */
  async speak(text) {
    if (!this.enabled || !text) return;
    this.stop();
    const session = ++this.session;
    this.setState('speaking');
    const parts = text.split(OPTION_BREAK).map((t) => t.trim()).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      await this.whenResumed();
      if (session !== this.session) return;
      await this.speakPart(parts[i], session);
      if (session !== this.session) return;
      if (i + 1 < parts.length) await tick();
      if (session !== this.session) return;
    }
    this.setState('idle');
  }

  setState(state) {
    if (state === this.state) return;
    this.state = state;
    this.onState?.(state);
  }

  /**
   * Met la lecture en pause : la promesse de speak() reste en attente, la suite du parcours aussi.
   * Voix naturelle : le son reprend où il s'était arrêté. Voix du navigateur (pause peu fiable) :
   * la phrase en cours est arrêtée et relue depuis son début à la reprise.
   */
  pause() {
    if (this.state !== 'speaking') return;
    this.setState('paused');
    if (this.audio && this.finishPlayback) this.audio.pause();
    if (canBrowserSpeak) speechSynthesis.cancel();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.setState('speaking');
    if (this.audio && this.finishPlayback) this.audio.play().catch(() => this.finishPlayback?.());
    this.resumers.splice(0).forEach((resolve) => resolve());
  }

  whenResumed() {
    return this.state === 'paused' ? new Promise((resolve) => this.resumers.push(resolve)) : Promise.resolve();
  }

  async speakPart(text, session) {
    if (this.engine === 'piper' && this.audio) {
      try {
        await this.speakPiper(text, session);
        return;
      } catch (err) {
        if (session !== this.session) return; // lecture interrompue volontairement
        console.warn('Voix Piper indisponible, voix du navigateur utilisée.', err);
        this.engine = 'browser';
        this.onFallback?.();
      }
    }
    if (session === this.session) await this.speakBrowser(text, session);
  }

  async speakPiper(text, session) {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const load = (chunk) => {
      const p = fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: chunk, voice: this.piperVoice, rate: this.rate }),
        signal,
      }).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      });
      p.catch(() => {}); // une lecture interrompue ne doit pas laisser d'erreur non traitée
      return p;
    };
    const chunks = splitSentences(text);
    // Voix lente : un silence un peu plus long entre les phrases.
    const gap = this.rate < 0.8 ? 450 : 150;
    let next = load(chunks[0]);
    for (let i = 0; i < chunks.length; i++) {
      const blob = await next;
      if (session !== this.session) return;
      if (i + 1 < chunks.length) next = load(chunks[i + 1]); // préparée pendant la lecture
      await this.whenResumed();
      if (session !== this.session) return;
      await this.play(blob, session);
      if (session !== this.session) return;
      if (i + 1 < chunks.length) await wait(gap);
    }
  }

  play(blob, session) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const done = () => {
        this.audio.onended = this.audio.onerror = null;
        this.finishPlayback = null;
        URL.revokeObjectURL(url);
        resolve();
      };
      this.finishPlayback = done;
      this.audio.onended = done;
      this.audio.onerror = done;
      this.audio.src = url;
      this.audio.play().catch((err) => {
        done();
        if (session === this.session) reject(err);
      });
    });
  }

  async speakBrowser(text, session) {
    // Une pause arrête la phrase : on la relit depuis son début à la reprise.
    for (;;) {
      await this.whenResumed();
      if (session !== this.session) return;
      await this.utter(text);
      if (session !== this.session || this.state !== 'paused') return;
    }
  }

  utter(text) {
    if (!canBrowserSpeak) return Promise.resolve();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'fr-FR';
      u.rate = this.rate;
      if (this.voice) u.voice = this.voice;
      // Certains navigateurs n'émettent pas toujours « end » : garde-fou sur la durée.
      const guard = setTimeout(resolve, 2000 + text.length * 120 / this.rate);
      const done = () => { clearTimeout(guard); resolve(); };
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    });
  }

  stop() {
    this.session++;
    this.setState('idle');
    this.resumers.splice(0).forEach((resolve) => resolve());
    this.abort?.abort();
    if (this.audio) this.audio.pause();
    this.finishPlayback?.();
    if (canBrowserSpeak) speechSynthesis.cancel();
  }
}

/**
 * Écoute une réponse. Le navigateur s'arrête de lui-même à chaque courte pause : on enchaîne
 * alors une nouvelle écoute (avec un objet neuf, ce qui marche dans tous les navigateurs) et
 * on cumule le texte, jusqu'à `silenceMs` de silence une fois que l'usager a parlé (ou
 * `initialMs` s'il ne dit rien). Cela lui laisse le temps de réfléchir.
 * `continuous` : ne s'arrête pas seule (l'usager appuie sur « J'ai fini de parler »).
 * `onInterim(texte)` affiche la transcription en direct.
 * `onSegment(texte)` : un morceau de phrase est définitif (le navigateur ne le changera plus).
 * `onResume()` : l'usager reprend la parole après un morceau définitif (sa réponse continue).
 */
export class Listener {
  constructor({ onInterim, onState, onSegment = () => {}, onResume = () => {} }) {
    this.onInterim = onInterim;
    this.onState = onState;
    this.onSegment = onSegment;
    this.onResume = onResume;
    this.continuous = false;
    this.silenceMs = 4000;
    this.initialMs = 12000;
    this.turnSilenceMs = null; // silence plus court pour cette écoute seulement (voir shorten)
    this.ctl = null; // écoute en cours
  }

  get active() { return this.ctl !== null; }

  listen() {
    if (!canListen) return Promise.reject(new Error('unsupported'));
    this.stop();
    this.turnSilenceMs = null;
    return new Promise((resolve, reject) => {
      const ctl = { rec: null, done: false, finishing: false, cancelled: false };
      this.ctl = ctl;
      let saved = ''; // texte des écoutes précédentes
      let current = ''; // texte de l'écoute en cours (final + provisoire)
      let heard = false;
      let lastActivity = Date.now();
      let timer = null;
      let open = false; // le micro a effectivement démarré
      let resumeDue = false; // un morceau est définitif : la prochaine parole est une reprise
      const text = () => `${saved} ${current}`.replace(/\s+/g, ' ').trim();
      const segment = (t) => {
        t = t.replace(END_PHRASE, '').replace(/\s+/g, ' ').trim();
        if (!t) return;
        resumeDue = true;
        this.onSegment(t);
      };
      const limit = () => (heard ? (this.turnSilenceMs ?? this.silenceMs) : this.initialMs);

      ctl.end = (value, error) => {
        if (ctl.done) return;
        ctl.done = true;
        clearTimeout(timer);
        if (this.ctl === ctl) this.ctl = null;
        // Bip de fin, sauf si l'écoute est annulée (l'assistant reprend alors la parole).
        if (open && !ctl.cancelled) beep('end');
        this.onState('idle');
        if (error) reject(error);
        else resolve(typeof value === 'string' ? value.replace(END_PHRASE, '').trim() : value);
      };
      ctl.text = text;
      const arm = () => {
        clearTimeout(timer);
        if (!this.continuous) timer = setTimeout(() => this.finish(ctl), Math.max(0, limit() - (Date.now() - lastActivity)));
      };
      ctl.arm = arm;

      const session = () => {
        const rec = new Recognition();
        rec.lang = 'fr-FR';
        rec.interimResults = true;
        rec.continuous = this.continuous;
        rec.maxAlternatives = 1;
        ctl.rec = rec;
        let failure = null;
        let emitted = 0; // résultats de cette écoute déjà signalés comme définitifs
        rec.onstart = () => {
          // Bip de début à la première ouverture du micro seulement (pas aux relances).
          if (!open) beep('start');
          open = true;
          this.onState('listening');
        };
        rec.onresult = (e) => {
          rec.lastResults = e.results;
          current = '';
          for (let i = 0; i < e.results.length; i++) current += e.results[i][0].transcript;
          // Nouvelle parole après un morceau définitif : la réponse continue.
          let fresh = '';
          for (let i = emitted; i < e.results.length; i++) fresh += e.results[i][0].transcript;
          if (resumeDue && fresh.trim()) {
            resumeDue = false;
            this.onResume();
          }
          while (emitted < e.results.length && e.results[emitted].isFinal) {
            segment(e.results[emitted][0].transcript);
            emitted += 1;
          }
          if (current.trim()) heard = true;
          lastActivity = Date.now();
          this.onInterim(text());
          if (END_PHRASE.test(text())) this.finish(ctl);
          else arm();
        };
        rec.onerror = (e) => { failure = e.error; };
        rec.onend = () => {
          if (ctl.done || ctl.rec !== rec) return;
          // Fin de cette écoute : ce qui n'a pas été signalé comme définitif l'est maintenant.
          if (!ctl.cancelled && rec.lastResults) {
            let rest = '';
            for (let i = emitted; i < rec.lastResults.length; i++) rest += rec.lastResults[i][0].transcript;
            emitted = rec.lastResults.length;
            segment(rest);
          }
          saved = text();
          current = '';
          if (ctl.cancelled) return ctl.end(null);
          if (failure && failure !== 'no-speech' && failure !== 'aborted') return ctl.end(undefined, new Error(failure));
          if (ctl.finishing) return ctl.end(saved);
          // Courte pause détectée par le navigateur : on continue d'écouter.
          if (this.continuous || Date.now() - lastActivity < limit()) {
            try {
              session();
              return;
            } catch { /* on termine ci-dessous */ }
          }
          ctl.end(saved);
        };
        rec.start();
      };

      arm();
      try {
        session();
      } catch (err) {
        ctl.end(undefined, err);
      }
    });
  }

  /**
   * Réponse courte et claire (« oui », « non ») : l'écoute se termine après `ms` de silence au lieu
   * du silence habituel, pour cette écoute seulement. Sans effet en mode « J'ai fini de parler ».
   */
  shorten(ms) {
    if (!this.ctl || this.continuous) return;
    this.turnSilenceMs = Math.min(ms, this.silenceMs);
    this.ctl.arm();
  }

  /** Termine l'écoute et garde ce qui a été dit. */
  finish(ctl = this.ctl) {
    if (!ctl || ctl.done) return;
    ctl.finishing = true;
    try { ctl.rec?.stop(); } catch { /* déjà arrêtée */ }
    // Garde-fou : si le navigateur ne signale pas la fin, on termine quand même.
    setTimeout(() => ctl.end(ctl.text()), 1500);
  }

  /** Annule l'écoute (la promesse de listen() se résout à null). */
  stop() {
    const ctl = this.ctl;
    if (!ctl) return;
    ctl.cancelled = true;
    try {
      ctl.rec.onresult = null;
      ctl.rec.abort();
    } catch { /* déjà arrêtée */ }
    ctl.end(null);
  }
}
