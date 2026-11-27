import { SPECIAL_ACHIEVEMENTS } from './constants';
import type {
  ActionLogEntry,
  PendingPrompt,
  PublicPlayerView,
  SpecialAchievementDef,
  SpecialAchievementId,
} from './types';

export interface SpecialAchievementDisplayRow {
  def: SpecialAchievementDef;
  available: boolean;
  ownerName: string | null;
}

/**
 * Sorts Special Achievements so available ones come first in canonical order
 * and obtained/junked ones are grouped at the bottom of the list.
 */
export function getSortedSpecialAchievements(
  availableIds: ReadonlyArray<SpecialAchievementId>,
  players: ReadonlyArray<Pick<PublicPlayerView, 'name' | 'achievementBacks'>>
): SpecialAchievementDisplayRow[] {
  const availableSet = new Set(availableIds);
  const ownerBySpecial = new Map<SpecialAchievementId, string>();
  for (const p of players) {
    for (const a of p.achievementBacks) {
      if (a.kind === 'special' && a.specialId) {
        ownerBySpecial.set(a.specialId, p.name);
      }
    }
  }

  const all = Object.values(SPECIAL_ACHIEVEMENTS).map<SpecialAchievementDisplayRow>((def) => ({
    def,
    available: availableSet.has(def.id),
    ownerName: ownerBySpecial.get(def.id) ?? null,
  }));

  const availableRows = all.filter((r) => r.available);
  const unavailableRows = all.filter((r) => !r.available);
  return [...availableRows, ...unavailableRows];
}

export interface ZeroSelectionLabels {
  idleLabel: string;
  confirmLabel: string;
}

/**
 * Computes consistent two-step confirmation labels ('Choose None' vs 'Skip')
 * for optional selection prompts based on card wording and selection multiplicity.
 */
export function getZeroSelectionSkipLabels(
  prompt: Extract<PendingPrompt, { kind: 'choose_cards' | 'choose_color' }>
): ZeroSelectionLabels {
  const subtitle = (prompt.subtitle ?? '').toLowerCase();
  if (prompt.kind === 'choose_cards') {
    const isMultiOptional =
      prompt.max > 1 || /\b(up to|any number)\b/i.test(subtitle);
    if (isMultiOptional) {
      return {
        idleLabel: 'Choose None',
        confirmLabel: 'Confirm Choose None',
      };
    }
    return {
      idleLabel: 'Skip',
      confirmLabel: 'Confirm Skip',
    };
  }

  // choose_color optional prompts (e.g. "You may splay your red or green cards left")
  return {
    idleLabel: 'Skip',
    confirmLabel: 'Confirm Skip',
  };
}

export interface GroupedLogItem {
  entry: ActionLogEntry;
  subEntries: ActionLogEntry[];
}

export interface PlayerLogGroup {
  actorId: string;
  actorName: string;
  entries: GroupedLogItem[];
}

export interface TurnLogGroup {
  turn: number;
  players: PlayerLogGroup[];
}

export function groupLogEntries(
  log: ReadonlyArray<ActionLogEntry>,
  newestFirst = true
): TurnLogGroup[] {
  const byParent = new Map<string, ActionLogEntry[]>();
  const topLevelEntries: ActionLogEntry[] = [];

  for (const entry of log) {
    if (entry.parentLogId) {
      const children = byParent.get(entry.parentLogId) ?? [];
      children.push(entry);
      byParent.set(entry.parentLogId, children);
    } else {
      topLevelEntries.push(entry);
    }
  }

  const byTurn = new Map<number, ActionLogEntry[]>();
  for (const entry of topLevelEntries) {
    const list = byTurn.get(entry.turn) ?? [];
    list.push(entry);
    byTurn.set(entry.turn, list);
  }

  const turns = Array.from(byTurn.keys()).sort((a, b) => (newestFirst ? b - a : a - b));
  return turns.map((turn) => {
    const turnEntries = byTurn.get(turn) ?? [];
    const orderedEntries = newestFirst ? [...turnEntries].reverse() : turnEntries;
    const playerGroups: PlayerLogGroup[] = [];
    for (const entry of orderedEntries) {
      const rawSubs = byParent.get(entry.id) ?? [];
      const groupedItem: GroupedLogItem = {
        entry,
        subEntries: newestFirst ? [...rawSubs].reverse() : [...rawSubs],
      };
      const last = playerGroups[playerGroups.length - 1];
      if (last && last.actorId === entry.actorId) {
        last.entries.push(groupedItem);
      } else {
        playerGroups.push({
          actorId: entry.actorId,
          actorName: entry.actorName,
          entries: [groupedItem],
        });
      }
    }
    return { turn, players: playerGroups };
  });
}
