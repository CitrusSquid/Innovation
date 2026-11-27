export interface RngResult<T> {
  value: T;
  nextState: number;
}

/** Deterministic Mulberry32 PRNG step */
export function nextRandom(state: number): RngResult<number> {
  let t = (state + 0x6d2b79f5) | 0;
  let r = Math.imul(t ^ (t >>> 15), 1 | t);
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
  const value = ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  return { value, nextState: t >>> 0 };
}

export function shuffleWithSeed<T>(items: readonly T[], rngState: number): RngResult<T[]> {
  const arr = [...items];
  let state = rngState >>> 0;
  for (let i = arr.length - 1; i > 0; i--) {
    const step = nextRandom(state);
    state = step.nextState;
    const j = Math.floor(step.value * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return { value: arr, nextState: state };
}

let randomSeedCounter = 0;

/** Generates a fresh non-zero 32-bit random seed for new matches */
export function generateRandomSeed(): number {
  randomSeedCounter = (randomSeedCounter + 1) >>> 0;
  const counterMix = Math.imul(randomSeedCounter, 0x9e3779b1) >>> 0;
  const timeMix = Date.now() >>> 0;
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    return (buf[0] ^ timeMix ^ counterMix) >>> 0 || 1;
  }
  const fallback = (Math.random() * 0x100000000) >>> 0;
  return (Math.imul(fallback, 0x85ebca6b) ^ timeMix ^ counterMix) >>> 0 || 1;
}

