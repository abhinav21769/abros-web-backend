// Fuzzy name matching for the billing bot. Names typed in a chat message are
// rarely exact ("rosmount", "rishi gautam ambala"), so each one is scored
// against the real records and the caller is told whether the match is clear,
// ambiguous (ask the user) or absent. Nothing here guesses silently.

const MIN_SCORE = 0.55;
const CLEAR_MARGIN = 0.1;
const MAX_CANDIDATES = 5;
const HINT_BONUS = 0.25;

const normalize = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const isNumeric = (token) => /^\d+$/.test(token);

const bigrams = (word) => {
  const grams = new Map();
  for (let i = 0; i < word.length - 1; i += 1) {
    const gram = word.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) || 0) + 1);
  }
  return grams;
};

// Sørensen–Dice similarity on character bigrams: forgiving of typos.
const dice = (a, b) => {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const first = bigrams(a);
  const second = bigrams(b);
  let shared = 0;
  first.forEach((count, gram) => {
    shared += Math.min(count, second.get(gram) || 0);
  });
  return (2 * shared) / (a.length - 1 + (b.length - 1));
};

const scoreToken = (queryToken, candidateToken) => {
  if (queryToken === candidateToken) return 1;
  // Strengths and pack sizes must match exactly: "20" is never close to "10".
  if (isNumeric(queryToken) || isNumeric(candidateToken)) return 0;
  if (queryToken.length >= 3 && candidateToken.startsWith(queryToken)) {
    return 0.85;
  }
  const similarity = dice(queryToken, candidateToken);
  return similarity >= 0.7 ? similarity * 0.8 : 0;
};

/**
 * 1 means the normalized names are identical. Otherwise every word in the query
 * has to be found in the candidate; extra words on the candidate cost a little,
 * so "Rosmont" prefers "Rosmont" over "Rosmont Forte Plus".
 */
const scoreName = (query, candidate) => {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;

  const queryTokens = q.split(" ");
  const candidateTokens = c.split(" ");

  let total = 0;
  for (const queryToken of queryTokens) {
    let best = 0;
    for (const candidateToken of candidateTokens) {
      best = Math.max(best, scoreToken(queryToken, candidateToken));
    }
    total += best;
  }

  const coverage = total / queryTokens.length;
  const extraWords = Math.max(0, candidateTokens.length - queryTokens.length);
  return coverage * (1 - Math.min(extraWords, 3) * 0.03);
};

/**
 * @param {string} query            what the user typed
 * @param {object[]} items          records to search
 * @param {(item) => string} getName
 * @param {{ hint?: string, getHint?: (item) => string }} [options]
 *        hint is a location/area mentioned alongside the name; it only breaks
 *        ties between otherwise equal names.
 * @returns {{ status: "match"|"ambiguous"|"none", match?: object,
 *             fuzzy?: boolean, candidates: object[] }}
 */
const resolveEntity = (query, items, getName, options = {}) => {
  const hint = normalize(options.hint);

  const ranked = items
    .map((item) => {
      const base = scoreName(query, getName(item));
      let score = base;
      if (hint && base >= MIN_SCORE && options.getHint) {
        if (normalize(options.getHint(item)).includes(hint)) {
          score += HINT_BONUS;
        }
      }
      return { item, base, score, exact: base === 1 };
    })
    .filter((entry) => entry.base >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) return { status: "none", candidates: [] };

  const exactMatches = ranked.filter((entry) => entry.exact);
  if (exactMatches.length === 1) {
    return {
      status: "match",
      match: exactMatches[0].item,
      fuzzy: false,
      candidates: [exactMatches[0].item],
    };
  }

  const [top, second] = ranked;
  if (!second || top.score - second.score >= CLEAR_MARGIN) {
    return {
      status: "match",
      match: top.item,
      fuzzy: top.score < 0.9,
      candidates: [top.item],
    };
  }

  return {
    status: "ambiguous",
    candidates: ranked
      .filter((entry) => top.score - entry.score < 0.15)
      .slice(0, MAX_CANDIDATES)
      .map((entry) => entry.item),
  };
};

module.exports = {
  normalize,
  resolveEntity,
  scoreName,
};
