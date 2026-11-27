import { SPECIAL_ACHIEVEMENTS } from './constants';
import type {
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
