import { BASE_CARD_DATABASE } from '../data/cards/catalog';
import { ALL_AGES, ALL_COLORS, EMPIRE_ICONS } from './constants';
import {
  countDemandTopCards,
  countWonderEligibleColors,
  getTopCard,
  getTopCards,
  getVisibleIconCounts,
} from './splay';
import type {
  Age,
  CardColor,
  CardDefinition,
  CardInstance,
  FunctionalIcon,
  PlayerBoard,
  PlayerView,
  PublicPlayerView,
  SplayDirection,
} from './types';

export const TD_FEATURE_VERSION = 3;
export const TD_CARD_COUNT = BASE_CARD_DATABASE.length;
export const TD_BASE_FEATURE_SIZE = 424;
export const TD_INPUT_SIZE = TD_BASE_FEATURE_SIZE + TD_CARD_COUNT * 7;

const CARD_INDEX_BY_DEF_ID: ReadonlyMap<string, number> = new Map(
  BASE_CARD_DATABASE.map((def, i) => [def.id, i])
);

const SIX_ICONS: readonly FunctionalIcon[] = [
  'tower',
  'coin',
  'leaf',
  'lightbulb',
  'factory',
  'clock',
];

const SPLAY_NORM: Record<SplayDirection, number> = {
  none: 0,
  left: 0.25,
  right: 0.5,
  up: 0.75,
  aslant: 1,
};

const CATALOG_BY_AGE: Record<Age, readonly CardDefinition[]> = ALL_AGES.reduce((acc, age) => {
  acc[age] = BASE_CARD_DATABASE.filter((c) => c.age === age);
  return acc;
}, {} as Record<Age, readonly CardDefinition[]>);

const AGE_CARD_CAPACITY: Record<Age, number> = ALL_AGES.reduce((acc, age) => {
  acc[age] = age === 1 ? 15 : 10;
  return acc;
}, {} as Record<Age, number>);

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function sumIcons(counts: Record<FunctionalIcon, number>): number {
  let s = 0;
  for (const ic of SIX_ICONS) s += counts[ic];
  return s;
}

function scoreBacksTotal(backs: ReadonlyArray<{ age: Age }>): number {
  let s = 0;
  for (const b of backs) s += b.age;
  return s;
}

interface TDNPlayerSlot {
  id: string;
  teamId: string;
  eliminated: boolean;
  board: PlayerBoard;
  visibleIcons: Record<FunctionalIcon, number>;
  highestTopAge: number;
  scoreTotal: number;
  handCount: number;
  handAges: ReadonlyArray<Age>;
  achievementCount: number;
}

interface TDNContext {
  viewerId: string;
  currentPlayerId: string;
  variant: PlayerView['variant'];
  turnNumber: number;
  actionsRemaining: number;
  achievementTarget: number;
  standardAges: ReadonlyArray<Age>;
  availableSpecialAchievements: ReadonlyArray<string>;
  deckCounts: Record<Age, number>;
  viewerHand: ReadonlyArray<CardInstance>;
  viewerScorePile: ReadonlyArray<CardInstance>;
  viewerAchievements: ReadonlyArray<{ card?: CardInstance }>;
  slots: TDNPlayerSlot[];
}

function collectSeenDefIdsFromContext(ctx: TDNContext): Set<string> {
  const seen = new Set<string>();
  for (const p of ctx.slots) {
    for (const c of ALL_COLORS) {
      for (const card of p.board[c].cards) {
        seen.add(card.defId);
      }
    }
  }
  for (const card of ctx.viewerHand) seen.add(card.defId);
  for (const card of ctx.viewerScorePile) seen.add(card.defId);
  for (const ach of ctx.viewerAchievements) {
    if (ach.card) seen.add(ach.card.defId);
  }
  return seen;
}

function countReadyStandardAchFromAges(
  score: number,
  highestTopAge: number,
  standardAges: ReadonlyArray<Age>
): number {
  let ready = 0;
  for (const age of standardAges) {
    if (score >= age * 5 && highestTopAge >= age) ready += 1;
  }
  return ready;
}

function computeSpecialReadinessSummary(
  board: PlayerBoard,
  icons: Record<FunctionalIcon, number>,
  availableSpecials: ReadonlyArray<string>
): number {
  const avail = new Set(availableSpecials);
  let sum = 0;
  if (avail.has('monument')) {
    sum += Math.min(1, countDemandTopCards(board) / 4);
  }
  if (avail.has('empire')) {
    let met = 0;
    for (const ic of EMPIRE_ICONS) {
      met += Math.min(1, icons[ic] / 3);
    }
    sum += met / 6;
  }
  if (avail.has('world')) {
    sum += Math.min(1, icons.clock / 12);
  }
  if (avail.has('wonder')) {
    sum += Math.min(1, countWonderEligibleColors(board) / 5);
  }
  if (avail.has('universe')) {
    let high = 0;
    for (const col of ALL_COLORS) {
      const top = getTopCard(board[col]);
      if (top && top.age >= 8) high += 1;
    }
    sum += Math.min(1, high / 5);
  }
  return sum / 5;
}

function collectRotatedSlotOrder(
  players: ReadonlyArray<TDNPlayerSlot>,
  viewerId: string,
  variant: PlayerView['variant']
): Array<TDNPlayerSlot | null> {
  const viewerIdx = players.findIndex((p) => p.id === viewerId);
  const self = viewerIdx >= 0 ? players[viewerIdx] : players[0];
  if (!self) return [null, null, null, null];

  if (variant === '1v1') {
    const opp = players.find((p) => p.id !== self.id) ?? null;
    return [self, opp, null, null];
  }

  if (variant === '1v1v1') {
    const ordered: TDNPlayerSlot[] = [];
    for (let off = 1; off < players.length; off++) {
      ordered.push(players[(viewerIdx + off) % players.length]);
    }
    return [self, ordered[0] ?? null, ordered[1] ?? null, null];
  }

  // 2v2: [Self, Ally, Next clockwise Opp, Other Opp]
  const ally = players.find((p) => p.id !== self.id && p.teamId === self.teamId) ?? null;
  const opps: TDNPlayerSlot[] = [];
  for (let off = 1; off < players.length; off++) {
    const cand = players[(viewerIdx + off) % players.length];
    if (cand.teamId !== self.teamId) opps.push(cand);
  }
  return [self, ally, opps[0] ?? null, opps[1] ?? null];
}

function writeNormalizedSlotFeatures(
  out: Float32Array,
  offset: number,
  slot: TDNPlayerSlot | null,
  isSelf: boolean,
  ctx: TDNContext,
  selfIcons: Record<FunctionalIcon, number>
): number {
  let idx = offset;
  if (!slot) {
    return offset + 62;
  }

  const slotScore = slot.scoreTotal;
  const slotIcons = slot.visibleIcons;
  const slotTopAge = slot.highestTopAge;

  let handSum = 0;
  let handTechAbove = 0;
  for (let i = 0; i < slot.handAges.length; i++) {
    const age = slot.handAges[i];
    handSum += age;
    if (age > slotTopAge) handTechAbove += 1;
  }
  const meanHandAge = slot.handAges.length > 0 ? handSum / slot.handAges.length : 0;

  out[idx++] = 1; // present
  out[idx++] = slot.eliminated ? 1 : 0;
  out[idx++] = clamp(slotScore / 40, 0, 1.5);
  out[idx++] = clamp(slot.achievementCount / Math.max(1, ctx.achievementTarget), 0, 1.5);
  out[idx++] = clamp(slotTopAge / 11, 0, 1);
  out[idx++] = clamp(slot.handCount / 10, 0, 1.5);
  out[idx++] = clamp(meanHandAge / 11, 0, 1);
  out[idx++] = clamp(handTechAbove / 5, 0, 1.2);
  for (const ic of SIX_ICONS) {
    out[idx++] = clamp(slotIcons[ic] / 12, 0, 1.5);
  }

  const slotOpponents = ctx.slots.filter(
    (p) => !p.eliminated && p.id !== slot.id && (ctx.variant !== '2v2' || p.teamId !== slot.teamId)
  );
  let vulnerableCount = 0;
  let shareCount = 0;

  // Per color board stack: 9 features * 5 = 45
  for (const color of ALL_COLORS) {
    const stack = slot.board[color];
    const top = getTopCard(stack);
    if (!top) {
      idx += 9;
      continue;
    }

    let minAge = top.age;
    let maxAge = top.age;
    for (const c of stack.cards) {
      if (c.age < minAge) minAge = c.age;
      if (c.age > maxAge) maxAge = c.age;
    }
    let topFuncIcons = 0;
    for (const s of ['tl', 'bl', 'bc', 'br'] as const) {
      if (top.icons[s] !== 'hexagon') topFuncIcons += 1;
    }

    const fi = top.featuredIcon;
    const myCountForFi = slotIcons[fi];
    const maxOppForFi = slotOpponents.reduce((m, o) => Math.max(m, o.visibleIcons[fi]), 0);
    const hasMajority = myCountForFi > maxOppForFi ? 1 : 0;
    const hasDemand = top.abilities.some((a) => a.isDemand) ? 1 : 0;
    const hasNonDemand = top.abilities.some((a) => !a.isDemand) ? 1 : 0;

    if (!isSelf) {
      if (slotIcons[fi] < selfIcons[fi]) vulnerableCount += 1;
      else shareCount += 1;
    }

    out[idx++] = 1; // hasTop
    out[idx++] = clamp(top.age / 11, 0, 1);
    out[idx++] = clamp(stack.cards.length / 6, 0, 1.5);
    out[idx++] = SPLAY_NORM[stack.splay];
    out[idx++] = hasMajority;
    out[idx++] = hasDemand;
    out[idx++] = hasNonDemand;
    out[idx++] = clamp((maxAge - minAge) / 10, 0, 1);
    out[idx++] = clamp(topFuncIcons / 4, 0, 1);
  }

  out[idx++] = clamp(
    countReadyStandardAchFromAges(slotScore, slotTopAge, ctx.standardAges) / 5,
    0,
    1.2
  );
  out[idx++] = clamp(vulnerableCount / 5, 0, 1);
  out[idx++] = clamp(shareCount / 5, 0, 1);

  return idx;
}

function extractTDFeaturesFromContext(ctx: TDNContext, target?: Float32Array): Float32Array {
  const out = target && target.length === TD_INPUT_SIZE ? target : new Float32Array(TD_INPUT_SIZE);
  out.fill(0);

  const selfSlot = ctx.slots.find((p) => p.id === ctx.viewerId) ?? ctx.slots[0];
  const selfIcons = selfSlot.visibleIcons;
  const selfScore = selfSlot.scoreTotal;
  const selfAch = selfSlot.achievementCount;
  const selfTopAge = selfSlot.highestTopAge;
  const selfTotalIcons = sumIcons(selfIcons);

  const opponents = ctx.slots.filter(
    (p) =>
      p.id !== ctx.viewerId &&
      !p.eliminated &&
      (ctx.variant !== '2v2' || p.teamId !== selfSlot.teamId)
  );
  const ally =
    ctx.variant === '2v2'
      ? ctx.slots.find(
          (p) => p.id !== ctx.viewerId && !p.eliminated && p.teamId === selfSlot.teamId
        ) ?? null
      : null;

  let maxOppScore = 0;
  let maxOppAch = 0;
  let maxOppTopAge = 0;
  let maxOppIcons = 0;
  for (const opp of opponents) {
    if (opp.scoreTotal > maxOppScore) maxOppScore = opp.scoreTotal;
    if (opp.achievementCount > maxOppAch) maxOppAch = opp.achievementCount;
    if (opp.highestTopAge > maxOppTopAge) maxOppTopAge = opp.highestTopAge;
    const ic = sumIcons(opp.visibleIcons);
    if (ic > maxOppIcons) maxOppIcons = ic;
  }

  let idx = 0;

  // --- Block A: Global & Relative Match Context (36 features: 0..35) ---
  out[idx++] = ctx.variant === '1v1' ? 1 : 0;
  out[idx++] = ctx.variant === '1v1v1' ? 1 : 0;
  out[idx++] = ctx.variant === '2v2' ? 1 : 0;
  out[idx++] = clamp(ctx.turnNumber / 40, 0, 1.5);
  out[idx++] = clamp(ctx.actionsRemaining / 2, 0, 1);

  out[idx++] = clamp(selfScore / 40, 0, 1.5);
  out[idx++] = clamp(selfAch / Math.max(1, ctx.achievementTarget), 0, 1.5);
  out[idx++] = clamp(selfTopAge / 11, 0, 1);
  out[idx++] = clamp(ctx.viewerHand.length / 10, 0, 1.5);
  const selfReadyAch = countReadyStandardAchFromAges(selfScore, selfTopAge, ctx.standardAges);
  out[idx++] = clamp(selfReadyAch / 5, 0, 1.2);

  for (const ic of SIX_ICONS) {
    out[idx++] = clamp(selfIcons[ic] / 12, 0, 1.5);
  }

  const stdCount = ctx.standardAges.length;
  let minStdAge = 11;
  let maxStdAge = 0;
  for (const age of ctx.standardAges) {
    if (age < minStdAge) minStdAge = age;
    if (age > maxStdAge) maxStdAge = age;
  }
  out[idx++] = clamp(stdCount / 10, 0, 1);
  out[idx++] = stdCount > 0 ? minStdAge / 11 : 1;
  out[idx++] = stdCount > 0 ? maxStdAge / 11 : 0;
  out[idx++] = clamp(ctx.availableSpecialAchievements.length / 5, 0, 1);
  out[idx++] = computeSpecialReadinessSummary(
    selfSlot.board,
    selfIcons,
    ctx.availableSpecialAchievements
  );

  for (const age of ALL_AGES) {
    out[idx++] = clamp((ctx.deckCounts[age] ?? 0) / AGE_CARD_CAPACITY[age], 0, 1);
  }

  out[idx++] = clamp((selfScore - maxOppScore) / 30, -1.5, 1.5);
  out[idx++] = clamp((selfAch - maxOppAch) / Math.max(1, ctx.achievementTarget), -1, 1);
  out[idx++] = clamp((selfTopAge - maxOppTopAge) / 10, -1, 1);
  out[idx++] = clamp((selfTotalIcons - maxOppIcons) / 15, -1.5, 1.5);

  // --- Block B: 4 Normalized Player Slots (248 features: 36..283) ---
  const orderedSlots = collectRotatedSlotOrder(ctx.slots, ctx.viewerId, ctx.variant);
  for (let s = 0; s < 4; s++) {
    idx = writeNormalizedSlotFeatures(out, idx, orderedSlots[s], s === 0, ctx, selfIcons);
  }

  // --- Block C: 2v2 Team & Ally Synergy Features (20 features: 284..303) ---
  const nextAchCost = stdCount > 0 ? minStdAge * 5 : 55;
  if (ctx.variant === '2v2') {
    const allyAch = ally ? ally.achievementCount : 0;
    const allyScore = ally ? ally.scoreTotal : 0;
    const allyTopAge = ally ? ally.highestTopAge : 0;
    const allyIcons = ally ? ally.visibleIcons : null;

    const teamAch = selfAch + allyAch;
    const oppTeamAch = opponents.reduce((s, o) => s + o.achievementCount, 0);

    // Combined team achievements out of 4 & out of 6
    out[idx++] = clamp(teamAch / 4, 0, 1.5);
    out[idx++] = clamp(teamAch / 6, 0, 1.2);
    out[idx++] = clamp(oppTeamAch / 4, 0, 1.5);
    out[idx++] = clamp(oppTeamAch / 6, 0, 1.2);
    out[idx++] = clamp((teamAch - oppTeamAch) / 4, -1.5, 1.5);

    // Teammate score proximity to the next achievement
    out[idx++] = clamp(allyScore / Math.max(5, nextAchCost), 0, 1.5);
    out[idx++] = clamp(Math.max(0, nextAchCost - allyScore) / 25, 0, 1.5);
    out[idx++] = stdCount > 0 && allyScore >= nextAchCost && allyTopAge >= minStdAge ? 1 : 0;
    out[idx++] = ally
      ? clamp(countReadyStandardAchFromAges(allyScore, allyTopAge, ctx.standardAges) / 5, 0, 1.2)
      : 0;
    out[idx++] = clamp(selfScore / Math.max(5, nextAchCost), 0, 1.5);

    // Per-color ally Dogma-sharing alignment across all 5 colors
    // (allyIcons >= selfIcons without opponent majority)
    for (const color of ALL_COLORS) {
      const top = getTopCard(selfSlot.board[color]);
      if (!top || !allyIcons || top.abilities.length === 0) {
        out[idx++] = 0;
        out[idx++] = 0;
        continue;
      }
      const fi = top.featuredIcon;
      const hasNonDemand = top.abilities.some((a) => !a.isDemand);
      const selfCount = selfIcons[fi];
      const allyCount = allyIcons[fi];
      const maxOppCount = opponents.reduce((m, o) => Math.max(m, o.visibleIcons[fi]), 0);
      const strictAllyAlignedNoOpp =
        hasNonDemand && allyCount >= selfCount && maxOppCount < selfCount ? 1 : 0;
      const allyNotOutgunned =
        allyCount >= selfCount && maxOppCount <= selfCount ? 1 : 0;
      out[idx++] = strictAllyAlignedNoOpp;
      out[idx++] = allyNotOutgunned;
    }
  } else {
    idx += 20;
  }

  // --- Block D: Viewer Hand, Icon Balance & Keldon Unseen Pool (116 features: 304..419) ---
  const handAgeCounts = new Float32Array(12);
  let handTechUp = 0;
  let handEmptyColor = 0;
  let handSplayMatch = 0;
  let handStale = 0;
  let bestHandAge = 0;
  const handColorCounts: Record<CardColor, number> = {
    red: 0,
    yellow: 0,
    green: 0,
    blue: 0,
    purple: 0,
  };

  for (const c of ctx.viewerHand) {
    handAgeCounts[c.age] += 1;
    handColorCounts[c.color] += 1;
    if (c.age > bestHandAge) bestHandAge = c.age;
    if (c.age > selfTopAge) handTechUp += 1;
    if (c.age <= selfTopAge - 3) handStale += 1;
    if (selfSlot.board[c.color].cards.length === 0) handEmptyColor += 1;
    else handSplayMatch += 1;
  }

  for (const age of ALL_AGES) {
    out[idx++] = clamp(handAgeCounts[age] / 4, 0, 1.5);
  }
  out[idx++] = clamp(handTechUp / 4, 0, 1.5);
  out[idx++] = clamp(handEmptyColor / 5, 0, 1);
  out[idx++] = clamp(handSplayMatch / 5, 0, 1.2);
  out[idx++] = clamp(Math.max(0, ctx.viewerHand.length - 4) / 5, 0, 1.5);
  out[idx++] = clamp(handStale / 4, 0, 1.5);

  for (const col of ALL_COLORS) {
    out[idx++] = clamp(handColorCounts[col] / 4, 0, 1.5);
  }

  // Special-leverage hand/board indicators (4)
  const oppApproachingAge4 = opponents.some(
    (o) => o.highestTopAge >= 3 || o.handAges.some((age) => age >= 4)
  );
  const myTopIds = new Set(getTopCards(selfSlot.board).map((c) => c.defId));
  const myHandIds = new Set(ctx.viewerHand.map((c) => c.defId));
  const hasGunpowderRisk =
    oppApproachingAge4 &&
    ALL_COLORS.some((c) => {
      const t = getTopCard(selfSlot.board[c]);
      return t !== null && (t.icons.tl === 'tower' || t.icons.bl === 'tower' || t.icons.bc === 'tower' || t.icons.br === 'tower');
    });
  const hasMasonryMonument =
    (myTopIds.has('B006') || myHandIds.has('B006')) && selfSlot.board.red.cards.length === 3;
  const hasAltWinLive =
    myTopIds.has('B084') ||
    myHandIds.has('B084') ||
    myTopIds.has('B090') ||
    myHandIds.has('B090') ||
    myTopIds.has('B106') ||
    myHandIds.has('B106') ||
    myTopIds.has('B113') ||
    myHandIds.has('B113');

  out[idx++] = hasGunpowderRisk ? 1 : 0;
  out[idx++] = hasMasonryMonument ? 1 : 0;
  out[idx++] = hasAltWinLive ? 1 : 0;
  out[idx++] = clamp(bestHandAge / 11, 0, 1);

  // D2: Icon balance across 6 icons (18)
  for (const ic of SIX_ICONS) {
    const oppMax = opponents.reduce((m, o) => Math.max(m, o.visibleIcons[ic]), 0);
    out[idx++] = clamp((selfIcons[ic] - oppMax) / 8, -1.5, 1.5);
    out[idx++] = selfIcons[ic] > oppMax ? 1 : 0;
    out[idx++] = oppMax > selfIcons[ic] ? clamp((oppMax - selfIcons[ic]) / 8, 0, 1.5) : 0;
  }

  // D3: Keldon Unseen Pool Probabilities across Ages 1..11 (66)
  const seen = collectSeenDefIdsFromContext(ctx);
  const oppHandAgeCounts = new Float32Array(12);
  for (const opp of opponents) {
    for (const age of opp.handAges) {
      oppHandAgeCounts[age] += 1;
    }
  }

  for (const age of ALL_AGES) {
    const allInAge = CATALOG_BY_AGE[age];
    const cap = AGE_CARD_CAPACITY[age];
    let unseenCount = 0;
    let demandCount = 0;
    let iconSum = 0;
    let emptyColorMatchCount = 0;

    for (const def of allInAge) {
      if (seen.has(def.id)) continue;
      unseenCount += 1;
      if (def.abilities.some((a) => a.isDemand)) demandCount += 1;
      for (const s of ['tl', 'bl', 'bc', 'br'] as const) {
        if (def.icons[s] !== 'hexagon') iconSum += 1;
      }
      if (selfSlot.board[def.color].cards.length === 0) {
        emptyColorMatchCount += 1;
      }
    }

    const denom = Math.max(1, unseenCount);
    out[idx++] = clamp(unseenCount / cap, 0, 1);
    out[idx++] = unseenCount > 0 ? demandCount / denom : 0;
    out[idx++] = unseenCount > 0 ? iconSum / (denom * 4) : 0;
    out[idx++] = unseenCount > 0 ? emptyColorMatchCount / denom : 0;
    out[idx++] = clamp(oppHandAgeCounts[age] / denom, 0, 1);
    out[idx++] = clamp((ctx.deckCounts[age] ?? 0) / denom, 0, 1);
  }

  // D4: Tactical flags (7)
  let unsplayedMultiStacks = 0;
  for (const col of ALL_COLORS) {
    const st = selfSlot.board[col];
    if (st.cards.length >= 2 && st.splay === 'none') unsplayedMultiStacks += 1;
  }
  const oppReadyNow = opponents.some(
    (o) => countReadyStandardAchFromAges(o.scoreTotal, o.highestTopAge, ctx.standardAges) > 0
  );

  out[idx++] = clamp(unsplayedMultiStacks / 5, 0, 1);
  out[idx++] = ctx.viewerHand.some((c) => c.age >= 4) ? 1 : 0;
  out[idx++] = oppReadyNow ? 1 : 0;
  out[idx++] = selfReadyAch > 0 ? 1 : 0;
  out[idx++] = stdCount > 0 && selfScore < nextAchCost && nextAchCost - selfScore <= 5 ? 1 : 0;
  out[idx++] =
    (ctx.variant === '2v2' ? selfAch + (ally?.achievementCount ?? 0) : selfAch) >=
    ctx.achievementTarget - 1
      ? 1
      : 0;
  out[idx++] =
    (ctx.variant === '2v2'
      ? opponents.reduce((s, o) => s + o.achievementCount, 0)
      : maxOppAch) >=
    ctx.achievementTarget - 1
      ? 1
      : 0;

  // D5: Turn-ownership & active-player action signals (4 features: 420..423)
  // Distinguishes "my turn with 2 actions" from "opponent's turn with 2 actions"
  const isViewerTurn = ctx.currentPlayerId === ctx.viewerId;
  const isAllyTurn = Boolean(ally && ctx.currentPlayerId === ally.id);
  out[idx++] = isViewerTurn ? 1 : 0;
  out[idx++] = isAllyTurn ? 1 : 0;
  out[idx++] = isViewerTurn ? clamp(ctx.actionsRemaining / 2, 0, 1) : 0;
  out[idx++] = !isViewerTurn ? clamp(ctx.actionsRemaining / 2, 0, 1) : 0;

  // --- Block E: Sparse Card-Identity & Stack-Exposure Channels (7 * 115 = 805 features: 424..1228) ---
  // Channels:
  //  0: Self Top cards (1.0)
  //  1: Self Non-Top stack cards (1.0 if splay-exposed, 0.35 if covered/unsplayed)
  //  2: Self Hand cards (1.0)
  //  3: Primary/Clockwise Opponent Top cards (1.0)
  //  4: Other Opponents' Top cards in 1v1v1 / 2v2 (1.0)
  //  5: Opponents' Non-Top stack cards (1.0 if splay-exposed, 0.35 if covered/unsplayed)
  //  6: 2v2 Ally board cards (1.0 top, 1.0 splay-exposed, 0.35 covered/unsplayed)
  const writeStackCardIds = (
    board: PlayerBoard,
    topOffset: number | null,
    stackOffset: number | null,
    unsplayedWeight = 0.35
  ) => {
    for (const color of ALL_COLORS) {
      const stack = board[color];
      const len = stack.cards.length;
      if (len === 0) continue;
      if (topOffset !== null) {
        const topIdx = CARD_INDEX_BY_DEF_ID.get(stack.cards[len - 1].defId);
        if (topIdx !== undefined) {
          out[topOffset + topIdx] = 1;
        }
      }
      if (stackOffset !== null && len > 1) {
        const weight = stack.splay !== 'none' ? 1 : unsplayedWeight;
        for (let c = 0; c < len - 1; c++) {
          const cardIdx = CARD_INDEX_BY_DEF_ID.get(stack.cards[c].defId);
          if (cardIdx !== undefined && weight > out[stackOffset + cardIdx]) {
            out[stackOffset + cardIdx] = weight;
          }
        }
      }
    }
  };

  const ch0 = idx;
  const ch1 = ch0 + TD_CARD_COUNT;
  const ch2 = ch1 + TD_CARD_COUNT;
  const ch3 = ch2 + TD_CARD_COUNT;
  const ch4 = ch3 + TD_CARD_COUNT;
  const ch5 = ch4 + TD_CARD_COUNT;
  const ch6 = ch5 + TD_CARD_COUNT;

  // Channels 0 & 1: Self Top & Self Stack
  writeStackCardIds(selfSlot.board, ch0, ch1, 0.35);

  // Channel 2: Self Hand card IDs
  for (const card of ctx.viewerHand) {
    const cardIdx = CARD_INDEX_BY_DEF_ID.get(card.defId);
    if (cardIdx !== undefined) {
      out[ch2 + cardIdx] = 1;
    }
  }

  // Channels 3, 4, 5, 6: Rotated opponents & 2v2 ally
  if (ctx.variant === '2v2') {
    const allySlot = orderedSlots[1];
    if (allySlot && !allySlot.eliminated) {
      writeStackCardIds(allySlot.board, ch6, ch6, 0.35);
    }
    const primaryOpp = orderedSlots[2];
    if (primaryOpp && !primaryOpp.eliminated) {
      writeStackCardIds(primaryOpp.board, ch3, ch5, 0.35);
    }
    const otherOpp = orderedSlots[3];
    if (otherOpp && !otherOpp.eliminated) {
      writeStackCardIds(otherOpp.board, ch4, ch5, 0.35);
    }
  } else {
    const primaryOpp = orderedSlots[1];
    if (primaryOpp && !primaryOpp.eliminated) {
      writeStackCardIds(primaryOpp.board, ch3, ch5, 0.35);
    }
    const otherOpp = orderedSlots[2];
    if (otherOpp && !otherOpp.eliminated) {
      writeStackCardIds(otherOpp.board, ch4, ch5, 0.35);
    }
  }

  return out;
}

/**
 * Extracts a fixed-width (`TD_INPUT_SIZE = 1225`) normalized feature vector strictly
 * from fair-play `PlayerView` fields (never accesses hidden cards or debug reveals).
 */
export function extractTDFeatures(
  view: PlayerView,
  target?: Float32Array
): Float32Array {
  const slots: TDNPlayerSlot[] = view.players.map((p) => {
    const isSelf = p.id === view.viewerId;
    return {
      id: p.id,
      teamId: p.teamId,
      eliminated: p.eliminated,
      board: p.board,
      visibleIcons: isSelf ? view.viewer.visibleIcons : p.visibleIcons,
      highestTopAge: isSelf ? view.viewer.highestTopAge : p.highestTopAge,
      scoreTotal: isSelf ? view.viewer.scoreTotal : scoreBacksTotal(p.scoreBacks),
      handCount: isSelf ? view.viewer.hand.length : p.handCount,
      handAges: isSelf
        ? view.viewer.hand.map((c) => c.age)
        : p.handBacks.map((b) => b.age),
      achievementCount: p.achievementCount,
    };
  });

  return extractTDFeaturesFromContext(
    {
      viewerId: view.viewerId,
      currentPlayerId: view.currentPlayerId,
      variant: view.variant,
      turnNumber: view.turnNumber,
      actionsRemaining: view.actionsRemaining,
      achievementTarget: view.achievementTarget,
      standardAges: view.standardAchievementBacks.map((b) => b.age),
      availableSpecialAchievements: view.availableSpecialAchievements,
      deckCounts: view.deckCounts,
      viewerHand: view.viewer.hand,
      viewerScorePile: view.viewer.scorePile,
      viewerAchievements: view.viewer.achievements,
      slots,
    },
    target
  );
}

/**
 * Zero-projection fair-play feature extractor directly over `GameState` for high-speed
 * training/search leaf evaluation. Reads strictly the same visible zones as `extractTDFeatures`.
 */
export function extractTDFeaturesFromState(
  state: import('./types').GameState,
  viewerId: string,
  target?: Float32Array
): Float32Array {
  const viewer = state.players.find((p) => p.id === viewerId);
  if (!viewer) {
    throw new Error(`Unknown viewerId: ${viewerId}`);
  }

  const deckCounts = {} as Record<Age, number>;
  for (const age of ALL_AGES) {
    deckCounts[age] = state.decks[age].length;
  }

  const slots: TDNPlayerSlot[] = state.players.map((p) => {
    let highest: Age | 0 = 0;
    for (const color of ALL_COLORS) {
      const top = getTopCard(p.board[color]);
      if (top && top.age > highest) highest = top.age;
    }
    return {
      id: p.id,
      teamId: p.teamId,
      eliminated: p.eliminated,
      board: p.board,
      visibleIcons: getVisibleIconCounts(p.board),
      highestTopAge: highest,
      scoreTotal: scoreBacksTotal(p.scorePile),
      handCount: p.hand.length,
      handAges: p.hand.map((c) => c.age),
      achievementCount: p.achievements.length,
    };
  });

  return extractTDFeaturesFromContext(
    {
      viewerId,
      currentPlayerId: state.players[state.currentPlayerIndex]?.id ?? viewerId,
      variant: state.variant,
      turnNumber: state.turnNumber,
      actionsRemaining: state.actionsRemaining,
      achievementTarget: state.achievementTarget,
      standardAges: state.standardAchievements.map((c) => c.age),
      availableSpecialAchievements: state.availableSpecialAchievements,
      deckCounts,
      viewerHand: viewer.hand,
      viewerScorePile: viewer.scorePile,
      viewerAchievements: viewer.achievements,
      slots,
    },
    target
  );
}
