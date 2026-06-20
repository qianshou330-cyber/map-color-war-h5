export type SeededRandom = {
  next: () => number;
  float: (min: number, max: number) => number;
  int: (min: number, max: number) => number;
  pick: <T>(items: T[]) => T;
  fork: (salt: string) => SeededRandom;
};

export function createSeededRandom(seed: string): SeededRandom {
  let state = hashSeed(seed || "map-color-war-h5");

  function next(): number {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next,
    float(min, max) {
      return min + next() * (max - min);
    },
    int(min, max) {
      return Math.floor(min + next() * (max - min + 1));
    },
    pick(items) {
      return items[Math.floor(next() * items.length)] ?? items[0];
    },
    fork(salt) {
      return createSeededRandom(`${seed}:${salt}`);
    }
  };
}

function hashSeed(seed: string): number {
  let hash = 1779033703 ^ seed.length;
  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
  return (hash ^= hash >>> 16) >>> 0;
}
