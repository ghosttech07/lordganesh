// Player identity: a claimed, globally unique name bound to a random secret
// that lives on this device. The secret never leaves the device except inside
// claim/submit requests, and the server only ever stores its hash.
//
// With Supabase configured, uniqueness is global (unique index on the
// lower-cased name). With the local adapter, uniqueness can only be enforced
// among names claimed in this browser — stated plainly in the UI.

const KEY = 'endless-modak.identity.v1';
const LOCAL_REGISTRY = 'endless-modak.names.v1';

function randomSecret() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
}

export function isValidName(name) {
  const n = normalizeName(name);
  // Letters, numbers, symbols, emoji — anything printable. Only control
  // characters are refused. Names are always HTML-escaped when displayed.
  return n.length >= 2 && !/[\p{C}]/u.test(n);
}

export class Identity {
  constructor(leaderboard) {
    this.leaderboard = leaderboard;
    this.name = '';
    this.secret = '';
    this.claimed = false;
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (saved && saved.secret) {
        this.name = saved.name || '';
        this.secret = saved.secret;
        this.claimed = !!saved.claimed;
      }
    } catch {
      /* ignore */
    }
    if (!this.secret) {
      this.secret = randomSecret();
      this._save();
    }
  }

  _save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ name: this.name, secret: this.secret, claimed: this.claimed }));
    } catch {
      /* ignore */
    }
  }

  /**
   * Claim `name` for this device. Resolves { ok, name } or { ok:false, reason }
   * where reason ∈ 'invalid' | 'taken' | 'offline'.
   */
  async claim(name) {
    const n = normalizeName(name);
    if (!isValidName(n)) return { ok: false, reason: 'invalid' };
    if (this.claimed && this.name.toLowerCase() === n.toLowerCase()) return { ok: true, name: this.name };
    const res = await this.leaderboard.adapter.claimName(n, this.secret);
    if (res.ok) {
      this.name = res.name || n;
      this.claimed = true;
      this._save();
    }
    return res;
  }
}

/** Local-only registry so at least this browser can't reuse a name across profiles. */
export function localClaim(name, secret) {
  let reg = {};
  try {
    reg = JSON.parse(localStorage.getItem(LOCAL_REGISTRY) || '{}');
  } catch {
    reg = {};
  }
  const key = name.toLowerCase();
  if (reg[key] && reg[key] !== secret) return { ok: false, reason: 'taken' };
  reg[key] = secret;
  try {
    localStorage.setItem(LOCAL_REGISTRY, JSON.stringify(reg));
  } catch {
    /* ignore */
  }
  return { ok: true, name };
}
