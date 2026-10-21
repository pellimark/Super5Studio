const BALL_COUNT = 5;
const PRIOR_STRENGTH = 5;
const RECENT_WINDOW = 60;

export const DIVERSITY_SETTINGS = {
  closest: { label: "Closest", maxShared: 4 },
  balanced: { label: "Balanced", maxShared: 3 },
  varied: { label: "More varied", maxShared: 2 }
};

// These are pattern scores, not estimates of lottery win probabilities.
export function buildPositionModel(draws, max) {
  if (!Number.isInteger(max) || max < BALL_COUNT || !draws.length) {
    throw new RangeError("A valid number range and at least one draw are required.");
  }
  const history = draws.map((draw) => {
    const numbers = draw.numbers.slice().sort((a, b) => a - b);
    if (numbers.length !== BALL_COUNT || new Set(numbers).size !== BALL_COUNT ||
        numbers.some((number) => !Number.isInteger(number) || number < 1 || number > max)) {
      throw new RangeError("Each draw must contain five distinct numbers within this era's range.");
    }
    return numbers;
  });
  return Array.from({ length: BALL_COUNT }, (_, position) => {
    const series = history.map((numbers) => numbers[position]);
    const latest = series.at(-1);
    const low = position + 1;
    const high = max - (BALL_COUNT - position - 1);
    const recent = series.slice(-RECENT_WINDOW);
    const frequencies = new Array(max + 1).fill(0);
    const transitions = new Array(max + 1).fill(0);
    recent.forEach((number) => { frequencies[number] += 1; });
    let transitionCount = 0;
    for (let index = 0; index < series.length - 1; index += 1) {
      if (series[index] === latest) {
        transitions[series[index + 1]] += 1;
        transitionCount += 1;
      }
    }
    const scores = new Array(max + 1).fill(0);
    for (let number = low; number <= high; number += 1) {
      const prior = (frequencies[number] + 1) / (recent.length + high - low + 1);
      scores[number] = (transitions[number] + PRIOR_STRENGTH * prior) / (transitionCount + PRIOR_STRENGTH);
    }
    return { latest, recent: series.slice(-5), transitionCount, scores };
  });
}

function compareNumbers(a, b) {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function predictOutcomes(model, max, count = 5, diversity = "balanced") {
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    throw new RangeError("Choose between 1 and 10 outcomes.");
  }
  if (!Object.hasOwn(DIVERSITY_SETTINGS, diversity)) {
    throw new RangeError("Choose Closest, Balanced, or More varied.");
  }
  const { maxShared } = DIVERSITY_SETTINGS[diversity];
  const logScores = model.map((position) => position.scores.map(Math.log));
  // Independent positional maxima give an upper bound for every completion.
  // Add them in position order, just like the real score, to preserve exact ties.
  const upperScores = logScores.map((scores, index) => {
    const upper = new Array(max + 2).fill(-Infinity);
    for (let number = max - (BALL_COUNT - index - 1); number >= index + 1; number -= 1) {
      upper[number] = Math.max(scores[number], upper[number + 1]);
    }
    return upper;
  });
  const lines = [];
  while (lines.length < count) {
    // Count shared numbers anywhere in a line, even if their positions differ.
    const memberships = Array.from({ length: max + 1 }, (_, number) =>
      lines.flatMap((line, index) => line.includes(number) ? [index] : []));
    const shared = new Array(lines.length).fill(0);
    const numbers = [];
    let best = null;

    function search(nextNumber, score) {
      const position = numbers.length;
      if (position === BALL_COUNT) {
        if (!best || score > best.score || (score === best.score && compareNumbers(numbers, best.numbers) < 0)) {
          best = { numbers: numbers.slice(), score };
        }
        return;
      }
      const candidates = [];
      for (let number = nextNumber; number <= max - (BALL_COUNT - position - 1); number += 1) {
        if (memberships[number].some((index) => shared[index] === maxShared)) continue;
        const nextScore = score + logScores[position][number];
        let bound = nextScore;
        for (let later = position + 1; later < BALL_COUNT; later += 1) {
          bound += upperScores[later][number + later - position];
        }
        candidates.push({ number, score: nextScore, bound });
      }
      candidates.sort((a, b) => b.bound - a.bound || a.number - b.number);
      for (const candidate of candidates) {
        if (best && candidate.bound < best.score) break;
        numbers.push(candidate.number);
        // A tied bound cannot beat an already smaller lexicographic prefix.
        if (!best || candidate.bound !== best.score || compareNumbers(numbers, best.numbers) <= 0) {
          memberships[candidate.number].forEach((index) => { shared[index] += 1; });
          search(candidate.number + 1, candidate.score);
          memberships[candidate.number].forEach((index) => { shared[index] -= 1; });
        }
        numbers.pop();
      }
    }

    // The first pass is unconstrained: every setting keeps the same top anchor.
    // Later passes find the best line compatible with ALL earlier selections.
    // Never relax the cap just to fill the requested count.
    search(1, 0);
    if (!best) break;
    lines.push(best.numbers);
  }
  return lines;
}
