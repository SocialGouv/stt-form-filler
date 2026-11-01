# Mémoire conversationnelle et remplissage pendant que l'usager parle

## Context

Today the app waits for 4 s of silence (`SILENCE_MS`, [main.js:34](static/js/main.js)), then makes one `/api/interpret` call for the **current question only**. Each question keeps its own exchange in `S.perQ[qid].history`, which is cleared once the question is answered. Nothing is stored after the tab closes (`sessionStorage`), and no transcript of the whole conversation exists. The result:
- **Long monologue:** nothing appears on screen until the person stops talking.
- **Repetition:** anything said about other questions ("I live alone, I can't climb stairs") is lost, and has to be said again.
- **No resume:** closing the tab erases everything.
- **No transcript:** nothing to download at the end.

What we want:
- **Say it once.** Facts are extracted into a memory **while the person talks**, the current question fills live, and later questions arrive prefilled for a quick confirmation.
- **Resume.** Memory and transcript survive a lost connection or a closed tab.
- **Download.** The full transcript can be downloaded at the end.
- **Debug panel.** A feature-flagged panel shows the memory changing over time.

### Is the transcript enough as memory? (research summary)
No. Use a **hybrid**, which is what current systems converge on (Zep/Graphiti, Mem0, LangExtract, FormBharo 2026):
- **Transcript.** An append-only log. It is the source of truth and the file the user downloads.
- **Fact store.** Small atomic facts derived from the transcript. Each fact holds a field value plus a **quote from the transcript as evidence** (LangExtract-style: a fact whose quote is not in the segment is rejected, which catches hallucinated prefill). Old facts are **superseded, not deleted** (Graphiti-style), so corrections can be audited.
- **Why not re-read the raw transcript on every call?** It costs more on every call, gives no structured values to prefill with, and gives no status to track (proposed or confirmed).
- **Deterministic control.** The form logic stays rule-based; the LLM only interprets and extracts (FormBharo).
- **Streaming.** Industry practice is "speculate early, commit on final" (LiveKit preemptive generation, Deepgram Flux). Known pitfalls: interim text gets rewritten, and speculative results leak into memory. Rule: **only final speech segments produce facts.**

### Decisions taken (with you)
- **Persistence:** memory, transcript and answers in **localStorage** on the device, with an expiry. The server stays stateless, so no HDS impact.
- **Prefill:** **prefill, then quick confirmation** ("You already told me … Is that right?" → yes = next question).
- **Live updates:** the **current question** fills live; facts about other questions go into memory as "noted for later". Nothing is written into other questions' fields while the person is talking.
- **LLM cost: minimal.** Extraction runs only on a *final* segment, and only once the person **starts talking again** (so the turn is known to continue). The last segment is handled by the end-of-turn `interpret` call, which also returns facts. A short answer (one segment) therefore costs **no extra call**; a monologue of N segments costs N−1 extra calls.

### Defaults I chose (tell me if you want to change them)
- **Expiry:** 7 days after the last activity.
- **Debug panel flag:** `MEMOIRE_DEBUG=1` (env var or `.env`, set in `.env.example` for dev, off when unset), exposed via `/api/status`.
- **Transcript download:** generated in the browser (Blob, no server round-trip), as plain `.txt` grouped by question. The debug panel also offers the JSON.
- **Tables (`table` type) and `oneByOne` questions:** no live extraction in the first iteration. Their transcript is still recorded, and `interpret` can still return facts for them.

---

## Step 1 — Transcript log + persistent storage + download (no LLM change)
The foundation; useful on its own.
- [x] New module `static/js/memory.js` (pure ES module, no DOM): state `{version, savedAt, transcript[], facts[]}`. Functions: `addSegment({role, qid, text})`, `addFacts`, `supersede`, `activeFactsFor(qid)`, `toTxt(schema)`, `serialize/restore`.
- [x] Transcript: every user turn (final text) and every assistant message (`displayText`) is logged with `{id, t, role, qid}`. Hook points in [main.js](static/js/main.js): `handleUtterance`, the `reply`/`tell` helpers in `applyResult`/`applyOptionResult`/`goToQuestion`, `ask`, `askOption`, `nextOption`.
- [x] Switch `save()`/`restore()` from `sessionStorage` to `localStorage`. The stored object gets `savedAt` and memory. Expiry check on load; one-time migration of an existing `sessionStorage` entry.
- [x] `resetAnswers()` and "Effacer" also clear memory and transcript.
- [x] `guardTabClosing()`: closing the tab no longer erases anything, so remove the `beforeunload` alert. Update the texts that say otherwise (`index.html`, `donnees-personnelles.html`: how long data is kept on the device, how to erase it, the shared-computer warning).
- [x] Recap screen: DSFR download link "Télécharger la transcription de l'échange (TXT)" next to the PDF buttons.
- [x] Load the `dsfr-rgaa` skill before any UI change (rule for this whole plan).

## Step 2 — Server-side extraction (stateless)
- [x] `llm.py`: `EXTRACT_PROMPT` + `EXTRACT_SCHEMA`. It reuses the cached prefix `_system_text(form)` (full form schema + glossary) so the prompt cache keeps working. Input: `concerne`, `date_du_jour`, current question, `texte_du_tour` (the final segments of the turn so far), `nouveau_segment`, compact active facts `[{id, qid, text}]`. Output:
  - `current`: same fields as `RESPONSE_SCHEMA` for the current question (the cumulative value of the turn).
  - `facts[]`: `{qid|null, fact (short sentence), selected[], yes_no, date, number, text, quote, replaces}`.
- [x] `extract(form, question, ctx)` sanitizes each fact by **reusing `_sanitize(question, data)`** with the target question (types and option ids checked). It then drops: unknown `qid`, a quote not found in the segment (accent/punctuation-insensitive normalized comparison), a `replaces` id not among the facts sent, and facts about the current question (already in `current`).
- [x] Extend `RESPONSE_SCHEMA`/`interpret` with the same `facts[]` (the last segment of a turn goes through `interpret`) and a `memoire` field in the payload (active facts) so the answer takes into account what has already been said. Same sanitization.
- [x] `app.py`: `POST /api/extract` (same validation and limits as `/api/interpret`, `LLMUnavailable` → 503). `/api/status` returns `debug_memoire`.
- [x] Tests (new): `tests/test_extract.py` (pytest, `llm._complete` mocked). Cover quote rejection, unknown qid, invalid option, `replaces`, and current-question facts redirected into `current`. `requirements-dev.txt` with pytest.

## Step 3 — Speech segments and the live loop
- [x] [voice.js](static/js/voice.js) `Listener`: new callback `onSegment(text)` emitted once per segment that becomes final (in `onresult` via `isFinal`, track how many have been emitted per recognition session; and in `onend` for the text saved by the restart loop). Plus `onResume()` when an interim result arrives after a final segment.
- [x] `main.js`: the turn keeps `segments[]`. On `onResume`, if a final segment has not been extracted and no call is in flight, call `/api/extract` (**at most one in flight**; segments that arrive meanwhile are queued and grouped into the next call). Not in degraded mode, not for `oneByOne`/`table`, not when a local command was detected.
- [x] Applying `current`: provisional value written into the current question with `writeValue` (same path as `setAnswer`), without changing question or speaking. A single polite announcement ("Noté : …") so screen readers aren't flooded (RGAA). The end-of-turn `interpret` stays authoritative and overwrites the value.
- [x] Applying `facts`: `memory.addFacts` (status `proposed`; `replaces` → the old fact becomes `superseded`), then `save()`. A discreet "N informations notées pour la suite" status on the current card (DSFR).
- [x] Results that come back after the turn has ended are ignored (the turn/session id is checked, same pattern as `speaker.session`).

## Step 4 — Debug panel (feature flag)
- [x] When `/api/status.debug_memoire`, a column next to the questions (DSFR grid, `fr-col-lg-4`), visible only when the flag is on: a facts table (`fr-table`: fact, question, value, quote, status as an `fr-badge`, time), the transcript (latest segments), a log of extract/interpret calls (duration, number of facts kept and rejected, rejection reason).
- [x] Button "Télécharger la mémoire (JSON)".
- [x] Re-rendered on every memory change (`memory.onChange`). Off by default; `MEMOIRE_DEBUG=1` added to `.env.example` (dev) and documented in the README ("leave unset in production").

## Step 5 — Prefill + quick confirmation
- [x] `ask(qid)`: if the question has no answer and `activeFactsFor(qid)` gives a value, `setAnswer` with that value, mark `S.confirming = qid`, then say: "Vous m'avez dit : « quote ». J'ai donc noté : {formatValue}. Est-ce bien cela ?" The full question and its options are not read (the "lis-moi les réponses" command still works).
- [x] Answer: a local oui/non (`local-nlu.js`) → yes: fact `confirmed`, `noteSaved`, `goNext()`; otherwise a normal `interpret` with `current_value` = prefill (the person corrects it), and the fact becomes `rejected` or `superseded`.
- [x] Precision fields of options (`fillPrecisions`) and follow-up questions: prefilled the same way if a fact targets them.
- [x] Visual marker on the prefilled question ("Pré-rempli d'après ce que vous avez dit", DSFR, text not color alone), and in the recap screen.
- [x] Degraded mode: prefill still works from facts already in memory; no new extraction.

## Step 6 — Corrections and conflicts
- [x] A fact that contradicts **an already-answered question**: never overwritten silently. At the end of the current turn: "Vous aviez répondu X à « {short} ». Je le remplace par Y ?" Yes → `setAnswer` + the old fact `superseded`; no → the new fact `rejected`.
- [x] Correcting a prefilled but not yet confirmed fact: automatic replacement (`replaces`).
- [x] `goToQuestion` and `review` are unchanged; the recap shows questions answered from memory.

## Step 7 — (Optional, measured) Shorter turn end
- [x] When `extract`/`current` reports a closed and complete answer (yes/no, date, single choice) and the person stops, lower the silence from 4 s to ~1.5 s for that turn only. Long text (`longtext`) and multiple choice keep 4 s.
- [x] Measure before and after (time from last word to response) in the debug panel's call log. Keep it only if there are no premature cut-offs.

## Step 8 — Documentation and finishing
- [x] `CLAUDE.md` (architecture: memory, `/api/extract`, flag, tests), `README.md` (localStorage storage + expiry, transcript, `MEMOIRE_DEBUG`, production note), `donnees-personnelles.html`.
- [x] Final check that the no-AI mode still works: transcript, download and prefill from existing facts.

---

## Implementation notes (differences from the plan)
- **Step 7:** with "minimal calls", a short answer makes no `extract` call, so there is no "complete" signal from the model. The faster turn end therefore uses local yes/no detection: a yes/no question, a prefill confirmation or a conflict check, with a clear "oui"/"non" in 4 words or fewer. Measured with a simulated mic: 1.7 s instead of 4.2 s. **Still to check with real voices:** no cut-offs.
- **Corrections:** a correction spoken while a prefill awaits confirmation replaces the prefilled answer instead of adding to it (open-answer questions).
- **Pending conflicts at the end of the form:** they are only asked before a next question; there is none on the final screen.
- **Live display:** no screen-reader announcement of the provisional value while listening, because the microphone would pick it up. The answer is confirmed out loud at the end of the turn.

## Iteration 2 (after first user tests)
- [x] Deduction: "je vis chez mes parents" fills "Où vivez-vous ?" (hébergé) and "Chez qui ?" (parents). The prompt allows near-certain deductions, and the server deduces a question's condition from `when`. The questions in one card are confirmed together.
- [x] Live updates about every 2 s while talking (minimum 4 new words, one call at a time), instead of waiting for final segments. Quotes are checked against the whole turn, since a sentence can be cut between two sends.
- [x] Voice commands in the model's intents: `next`, `next_step`/`prev_step`, `list`, `finish` (plus the existing ones), including when combined with an answer.
- [x] Debug panel: framed column, grid gutters, list instead of table (no overflow).

## Critical files
- `static/js/memory.js` (new), [main.js](static/js/main.js), [voice.js](static/js/voice.js), `static/index.html`, `static/donnees-personnelles.html`
- [llm.py](llm.py) (`EXTRACT_*`, `extract`, `facts` in `RESPONSE_SCHEMA`, reuse of `_sanitize`/`_system_text`/`_complete`), [app.py](app.py) (`/api/extract`, `/api/status`)
- `tests/test_extract.py`, `requirements-dev.txt` (new), `.env.example`, `README.md`, `CLAUDE.md`

## Reused
`_sanitize`, `_system_text` (cached prefix), `_complete` (both LLM providers) in `llm.py`; `valueFromResult`, `setAnswer`, `writeValue`, `formatValue`, `fillPrecisions`, `precisionQuestion`, `noteSaved`, `announcePolite` in `main.js`; yes/no detection in `local-nlu.js`.

## Verification
- `pytest tests/` (extraction sanitization, quote rejection, replacements).
- Browser (preview `app.py`, with `MEMOIRE_DEBUG=1`), with fictitious data:
  1. On "Avec qui vivez-vous", say a long monologue: "je vis seule… j'ai l'AAH depuis mars 2021… je ne peux pas monter les escaliers". Check in the panel that facts appear **while the person is talking** (after each pause), with quotes, and that the current question ticks before the end of the turn.
  2. Reach the resources question: it is prefilled with the AAH, a quick confirmation, yes → next.
  3. Correction ("finalement je vis en couple") → conflict question → replacement, old fact `superseded`.
  4. Close the tab, reopen: answers, memory, transcript restored; past the expiry → empty.
  5. Recap → download the `.txt` and check it is complete (user + assistant, by question).
  6. Server without an LLM key: degraded mode, transcript still logged, prefill from existing facts.
  7. Without `MEMOIRE_DEBUG`: panel absent from the DOM.
- Count calls per turn in the panel: a short answer = 1 call (interpret), N segments = N calls.
