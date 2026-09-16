// Question selection with score-scaled difficulty and no repeats until the
// bank is exhausted. Options are shuffled per presentation, so the bank can
// store the correct answer first without that ever showing on screen.

import bank from './questions.json';
import puzzleBank from './puzzles.json';
import { mulberry32 } from '../core/MathUtils.js';

const TIERS = {
  easy: { weights: { 1: 0.8, 2: 0.2, 3: 0.0 } },
  mixed: { weights: { 1: 0.3, 2: 0.5, 3: 0.2 } },
  hard: { weights: { 1: 0.05, 2: 0.4, 3: 0.55 } },
};

export function tierForScore(score) {
  if (score < 500) return 'easy';
  if (score <= 2000) return 'mixed';
  return 'hard';
}

export class QuestionSystem {
  constructor(seed = Date.now()) {
    this.rand = mulberry32(seed >>> 0);
    this.byDiff = { 1: [], 2: [], 3: [] };
    for (const q of bank) this.byDiff[q.diff].push(q);
    this.queues = { 1: [], 2: [], 3: [] };
    this.asked = new Set();
    this.missed = []; // {q, chosen} for the review screen
    this.totalAsked = 0;
    this.totalCorrect = 0;
    for (const d of [1, 2, 3]) this._refill(d);
    this.puzzleQueue = [];
    this._refillPuzzles();
  }

  _refillPuzzles() {
    const arr = puzzleBank.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = (this.rand() * (i + 1)) | 0;
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    this.puzzleQueue = arr;
  }

  /** Next arrange-in-order puzzle, biased to the score tier; items pre-shuffled. */
  nextPuzzle(score) {
    if (this.puzzleQueue.length === 0) this._refillPuzzles();
    const tier = tierForScore(score);
    // Prefer a puzzle whose difficulty suits the tier, else take the top.
    const want = tier === 'easy' ? 1 : tier === 'mixed' ? 2 : 3;
    let idx = this.puzzleQueue.findIndex((p) => p.diff === want);
    if (idx < 0) idx = this.puzzleQueue.length - 1;
    const p = this.puzzleQueue.splice(idx, 1)[0];
    let shuffled;
    do {
      shuffled = p.items.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = (this.rand() * (i + 1)) | 0;
        const t = shuffled[i];
        shuffled[i] = shuffled[j];
        shuffled[j] = t;
      }
    } while (shuffled.every((v, i) => v === p.items[i]));
    this.totalAsked++;
    return { kind: 'puzzle', id: p.id, diff: p.diff, title: p.title, prompt: p.prompt, items: p.items, shuffled, why: p.why, raw: p };
  }

  /** Record a puzzle outcome; misses feed the review screen. */
  answerPuzzle(p, correct, answer) {
    if (correct) this.totalCorrect++;
    else this.missed.push({ q: { q: `${p.title}: ${p.prompt}`, o: [p.items.join(' → ')], a: 0, why: p.why }, chosen: answer.join(' → ') });
    return correct;
  }

  _refill(diff) {
    const arr = this.byDiff[diff].slice();
    // Fisher–Yates with the seeded PRNG.
    for (let i = arr.length - 1; i > 0; i--) {
      const j = (this.rand() * (i + 1)) | 0;
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    this.queues[diff] = arr;
  }

  _pickDiff(score) {
    const w = TIERS[tierForScore(score)].weights;
    const r = this.rand();
    let acc = 0;
    for (const d of [1, 2, 3]) {
      acc += w[d];
      if (r < acc) return d;
    }
    return 2;
  }

  /** Draw the next question for the given score. Returns a presentation object. */
  next(score) {
    let diff = this._pickDiff(score);
    // If a tier's queue is empty, everything in it has been asked this cycle —
    // reshuffle it (bank exhausted for that tier) as the brief specifies.
    if (this.queues[diff].length === 0) this._refill(diff);
    const q = this.queues[diff].pop();

    // Shuffle options, remembering where the correct one landed.
    const order = [0, 1, 2, 3];
    for (let i = 3; i > 0; i--) {
      const j = (this.rand() * (i + 1)) | 0;
      const t = order[i];
      order[i] = order[j];
      order[j] = t;
    }
    const options = order.map((i) => q.o[i]);
    const correctIndex = order.indexOf(q.a);
    this.totalAsked++;
    return { id: q.id, cat: q.cat, diff: q.diff, text: q.q, options, correctIndex, explanation: q.why, raw: q };
  }

  /** Record the outcome; missed questions feed the review screen. */
  answer(presentation, chosenIndex) {
    const correct = chosenIndex === presentation.correctIndex;
    if (correct) this.totalCorrect++;
    else this.missed.push({ q: presentation.raw, chosen: presentation.options[chosenIndex] });
    return correct;
  }

  get accuracy() {
    return this.totalAsked === 0 ? 0 : this.totalCorrect / this.totalAsked;
  }

  get bankSize() {
    return bank.length;
  }
}
