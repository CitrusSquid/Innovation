import type { GameState } from './types';

const AUTO_SAVE_KEY = 'innovation_4e_autosave_v1';
const SLOTS_KEY = 'innovation_4e_saveslots_v1';

export interface SaveSlotRecord {
  id: string;
  label: string;
  savedAt: string;
  variant: GameState['variant'];
  controlMode: GameState['controlMode'];
  turnNumber: number;
  stateJson: string;
}

export function isLocalStorageAvailable(): boolean {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  try {
    const probeKey = '__innovation_4e_storage_probe__';
    window.localStorage.setItem(probeKey, '1');
    window.localStorage.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
}

export function serializeGameState(state: GameState): string {
  return JSON.stringify(state);
}

export function deserializeGameState(raw: string): GameState {
  const parsed = JSON.parse(raw) as Partial<GameState>;
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof parsed.version !== 'number' ||
    !Array.isArray(parsed.players) ||
    !parsed.decks ||
    !parsed.phase
  ) {
    throw new Error('Invalid Innovation save state JSON.');
  }
  return parsed as GameState;
}

export function saveAutoMatch(state: GameState): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(AUTO_SAVE_KEY, serializeGameState(state));
  } catch {
    // Ignore quota errors cleanly
  }
}

export function loadAutoMatch(): GameState | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(AUTO_SAVE_KEY);
    if (!raw) return null;
    return deserializeGameState(raw);
  } catch {
    return null;
  }
}

export function clearAutoMatch(): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.removeItem(AUTO_SAVE_KEY);
  } catch {
    // Ignore storage errors
  }
}

export function listSaveSlots(): SaveSlotRecord[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(SLOTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SaveSlotRecord[]) : [];
  } catch {
    return [];
  }
}

export function saveNamedSlot(state: GameState, label?: string): SaveSlotRecord {
  const slots = listSaveSlots();
  const record: SaveSlotRecord = {
    id: `slot_${Date.now()}`,
    label:
      label?.trim() ||
      `${state.variant} · Turn ${state.turnNumber} (${state.players.map((p) => p.name).join(' vs ')})`,
    savedAt: new Date().toISOString(),
    variant: state.variant,
    controlMode: state.controlMode,
    turnNumber: state.turnNumber,
    stateJson: serializeGameState(state),
  };
  const next = [record, ...slots].slice(0, 8);
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(SLOTS_KEY, JSON.stringify(next));
    } catch {
      // Ignore quota errors
    }
  }
  return record;
}

export function deleteSaveSlot(slotId: string): SaveSlotRecord[] {
  const next = listSaveSlots().filter((s) => s.id !== slotId);
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(SLOTS_KEY, JSON.stringify(next));
    } catch {
      // Ignore storage errors
    }
  }
  return next;
}
