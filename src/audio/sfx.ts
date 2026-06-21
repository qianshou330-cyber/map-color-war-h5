import type { GameState } from "../types";

export type SfxName = "click" | "attack" | "capture" | "victory" | "error";

type SfxSnapshot = {
  round: number;
  attackIds: Set<string>;
  controllers: string;
  roundEndReason: GameState["roundEndReason"];
};

let audioContext: AudioContext | null = null;
let unlocked = false;
let lastSnapshot: SfxSnapshot | null = null;
let lastPlayedAt = new Map<SfxName, number>();

const MASTER_GAIN = 0.18;
const MIN_INTERVAL_MS: Record<SfxName, number> = {
  click: 45,
  attack: 700,
  capture: 500,
  victory: 1200,
  error: 220
};

export function unlockSfx(): void {
  const context = getAudioContext();
  if (!context) {
    return;
  }

  if (context.state === "suspended") {
    void context.resume();
  }

  unlocked = true;
}

export function playSfx(name: SfxName): void {
  if (!unlocked) {
    return;
  }

  const context = getAudioContext();
  if (!context) {
    return;
  }

  const nowMs = performance.now();
  const lastTime = lastPlayedAt.get(name) ?? 0;
  if (nowMs - lastTime < MIN_INTERVAL_MS[name]) {
    return;
  }
  lastPlayedAt.set(name, nowMs);

  switch (name) {
    case "click":
      playToneSequence(context, [
        { frequency: 520, duration: 0.045, gain: 0.34 },
        { frequency: 720, duration: 0.035, gain: 0.24 }
      ]);
      break;
    case "attack":
      playNoiseHit(context, 0.13, 0.18, 650);
      playToneSequence(context, [
        { frequency: 220, duration: 0.08, gain: 0.26 },
        { frequency: 150, duration: 0.08, gain: 0.18 }
      ]);
      break;
    case "capture":
      playToneSequence(context, [
        { frequency: 392, duration: 0.075, gain: 0.24 },
        { frequency: 523, duration: 0.075, gain: 0.24 },
        { frequency: 659, duration: 0.11, gain: 0.28 }
      ]);
      break;
    case "victory":
      playToneSequence(context, [
        { frequency: 392, duration: 0.12, gain: 0.26 },
        { frequency: 523, duration: 0.12, gain: 0.28 },
        { frequency: 784, duration: 0.18, gain: 0.3 }
      ]);
      break;
    case "error":
      playToneSequence(context, [
        { frequency: 190, duration: 0.07, gain: 0.22 },
        { frequency: 130, duration: 0.1, gain: 0.2 }
      ]);
      break;
  }
}

export function resetSfxStateTracker(): void {
  lastSnapshot = null;
}

export function syncStateSfx(state: GameState): void {
  const nextSnapshot = createSnapshot(state);

  if (!lastSnapshot || lastSnapshot.round !== nextSnapshot.round) {
    lastSnapshot = nextSnapshot;
    return;
  }

  const hasNewAttack = [...nextSnapshot.attackIds].some((attackId) => !lastSnapshot?.attackIds.has(attackId));
  const hasCapture = nextSnapshot.controllers !== lastSnapshot.controllers;
  const hasVictory = nextSnapshot.roundEndReason !== null && lastSnapshot.roundEndReason !== nextSnapshot.roundEndReason;

  if (hasNewAttack) {
    playSfx("attack");
  }
  if (hasCapture) {
    playSfx("capture");
  }
  if (hasVictory) {
    playSfx("victory");
  }

  lastSnapshot = nextSnapshot;
}

function getAudioContext(): AudioContext | null {
  if (audioContext) {
    return audioContext;
  }

  const AudioCtor = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioCtor) {
    return null;
  }

  audioContext = new AudioCtor();
  return audioContext;
}

function playToneSequence(
  context: AudioContext,
  tones: Array<{ frequency: number; duration: number; gain: number }>
): void {
  let startAt = context.currentTime;
  for (const tone of tones) {
    playTone(context, tone.frequency, startAt, tone.duration, tone.gain);
    startAt += tone.duration * 0.86;
  }
}

function playTone(
  context: AudioContext,
  frequency: number,
  startAt: number,
  duration: number,
  gainValue: number
): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = "square";
  oscillator.frequency.setValueAtTime(frequency, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(gainValue * MASTER_GAIN, startAt + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.02);
}

function playNoiseHit(context: AudioContext, duration: number, gainValue: number, filterFrequency: number): void {
  const sampleRate = context.sampleRate;
  const buffer = context.createBuffer(1, Math.max(1, Math.floor(sampleRate * duration)), sampleRate);
  const channel = buffer.getChannelData(0);

  for (let index = 0; index < channel.length; index += 1) {
    const decay = 1 - index / channel.length;
    channel[index] = (Math.random() * 2 - 1) * decay * decay;
  }

  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const gain = context.createGain();
  const startAt = context.currentTime;

  filter.type = "lowpass";
  filter.frequency.setValueAtTime(filterFrequency, startAt);
  gain.gain.setValueAtTime(gainValue * MASTER_GAIN, startAt);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

  source.buffer = buffer;
  source.connect(filter);
  filter.connect(gain);
  gain.connect(context.destination);
  source.start(startAt);
  source.stop(startAt + duration);
}

function createSnapshot(state: GameState): SfxSnapshot {
  return {
    round: state.round,
    attackIds: new Set(state.activeAttacks.map((attack) => attack.id)),
    controllers: state.countries.map((country) => country.controllerCountryId).join(","),
    roundEndReason: state.roundEndReason
  };
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
