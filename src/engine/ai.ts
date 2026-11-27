import { BASE_CARD_DATABASE, instantiateCard } from '../data/cards/catalog';
import { ALL_AGES, ALL_COLORS, EMPIRE_ICONS, SPECIAL_ACHIEVEMENTS } from './constants';
import { applyAction, buildActiveCatalog, getLegalTurnOptions } from './engine';
import {
  cloneGameState,
  computeScoreTotal,
  exchangeCards,
  junkDeck,
  junkStandardAchievementByAge,
  meldCardInstance,
  removeBottomCardFromBoard,
  removeCardFromScore,
  removeTopCardFromBoard,
  returnCardInstance,
  scoreCardInstance,
  splayPlayerColor,
  transferCard,
  tuckCardInstance,
} from './keywords';
import { projectPlayerView } from './playerView';
import { shuffleWithSeed } from './rng';
import {
  canSplayStack,
  cardHasIcon,
  countDemandTopCards,
  countWonderEligibleColors,
  createEmptyBoard,
  getExposedSlots,
  getHighestTopCardAge,
  getStackVisibleIcons,
  getTopCard,
  getTopCards,
  getVisibleIconCounts,
} from './splay';
import type {
  AIDecisionCandidateTrace,
  AIDecisionFactorScore,
  AIDecisionTrace,
  Age,
  CardBack,
  CardColor,
  CardDefinition,
  CardInstance,
  ClaimedAchievement,
  FunctionalIcon,
  GameState,
  PlayerBoard,
  PlayerState,
  PlayerView,
  PublicPlayerView,
  SplayDirection,
  TurnAction,
} from './types';

export interface StrategyWeights {
  pointsFocus: number;
  techUpFocus: number;
  demandFocus: number;
  iconsSplayFocus: number;
  isLosingPoints: boolean;
  isLosingBoard: boolean;
  isExtremelyLosing: boolean;
  gunpowderThreat: boolean;
}

export interface SituationAssessment {
  weights: StrategyWeights;
  myScore: number;
  maxOppScore: number;
  maxOppTopAge: number;
  myIconTotal: number;
  maxOppIconTotal: number;
  opponents: PublicPlayerView[];
  unseenAge1TowerRatio: number;
  unseenAge1BoardMatchRatio: number;
  specialPlans: {
    monumentByRed3: boolean;
    monumentNeedRed: boolean;
    empireMissingIcons: FunctionalIcon[];
    worldClose: boolean;
    wonderClose: boolean;
    universeClose: boolean;
  };
  /** Score (0..5) of how urgently we want each functional icon right now */
  iconNeedWeights: Record<FunctionalIcon, number>;
}

export interface AIHandParams {
  handAgeWeight: number;
  techAboveTopBonus: number;
  emptyColorBonus: number;
  abilityBonus: number;
  softCap: number;
  penaltyPerExcess: number;
  quadraticExcessPenalty: number;
  /** Discount applied to cards ranked past top `softCap` in hand (1 = no discount) */
  excessCardWeight: number;
  /** Slight penalty per age gap below (myTopAge - 2) for obsolete low-age cards in hand */
  staleCardPenaltyPerAge: number;
}

export const DEFAULT_AI_HAND_PARAMS: AIHandParams = {
  handAgeWeight: 1.15,
  techAboveTopBonus: 3.0,
  emptyColorBonus: 2.0,
  abilityBonus: 1.0,
  softCap: 4,
  penaltyPerExcess: 2.0,
  quadraticExcessPenalty: 0.25,
  excessCardWeight: 0.5,
  staleCardPenaltyPerAge: 0.4,
};

function getPromptFullText(prompt: NonNullable<GameState['pendingPrompts'][number]>): string {
  const sub = 'subtitle' in prompt && prompt.subtitle ? prompt.subtitle : '';
  return sub ? `${prompt.title} ${sub}` : prompt.title;
}

/** Strict splay hierarchy (worse to best): none < left < right < up < aslant (askew) */
export const SPLAY_RANK: Record<SplayDirection, number> = {
  none: 0,
  left: 1,
  right: 2,
  up: 3,
  aslant: 4,
};

const AGE1_BASE_CARDS: readonly CardDefinition[] = BASE_CARD_DATABASE.filter((c) => c.age === 1);
const ACTIVE_CATALOG: readonly CardDefinition[] = buildActiveCatalog();
export const ACTIVE_BY_AGE: Record<Age, readonly CardDefinition[]> = ALL_AGES.reduce((acc, age) => {
  acc[age] = ACTIVE_CATALOG.filter((c) => c.age === age);
  return acc;
}, {} as Record<Age, readonly CardDefinition[]>);

function sumBacksAge(backs: ReadonlyArray<{ age: Age }>): number {
  let total = 0;
  for (const b of backs) total += b.age;
  return total;
}

function sumIconCounts(counts: Record<FunctionalIcon, number>): number {
  let sum = 0;
  for (const k of Object.keys(counts) as FunctionalIcon[]) {
    sum += counts[k];
  }
  return sum;
}

function cloneBoard(board: PlayerBoard): PlayerBoard {
  return {
    red: { color: 'red', splay: board.red.splay, cards: [...board.red.cards] },
    yellow: { color: 'yellow', splay: board.yellow.splay, cards: [...board.yellow.cards] },
    green: { color: 'green', splay: board.green.splay, cards: [...board.green.cards] },
    blue: { color: 'blue', splay: board.blue.splay, cards: [...board.blue.cards] },
    purple: { color: 'purple', splay: board.purple.splay, cards: [...board.purple.cards] },
  };
}

export function collectVisiblySeenDefIds(view: PlayerView): Set<string> {
  const seen = new Set<string>();
  for (const p of view.players) {
    for (const color of ALL_COLORS) {
      for (const c of p.board[color].cards) {
        seen.add(c.defId);
      }
    }
  }
  for (const c of view.viewer.hand) seen.add(c.defId);
  for (const c of view.viewer.scorePile) seen.add(c.defId);
  for (const a of view.viewer.achievements) {
    if (a.card) seen.add(a.card.defId);
  }
  return seen;
}

function isGunpowderVisiblyKnown(view: PlayerView): boolean {
  for (const p of view.players) {
    for (const color of ALL_COLORS) {
      if (p.board[color].cards.some((c) => c.name.toUpperCase() === 'GUNPOWDER')) {
        return true;
      }
    }
  }
  if (view.viewer.hand.some((c) => c.name.toUpperCase() === 'GUNPOWDER')) return true;
  if (view.viewer.scorePile.some((c) => c.name.toUpperCase() === 'GUNPOWDER')) return true;
  if (view.viewer.achievements.some((a) => a.card?.name.toUpperCase() === 'GUNPOWDER')) return true;
  return false;
}

function parseSplayDirectionFromText(text: string): Exclude<SplayDirection, 'none'> | null {
  const m = /\bsplay\s+(left|right|up|aslant|askew)\b/i.exec(text);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  return raw === 'askew' ? 'aslant' : (raw as Exclude<SplayDirection, 'none'>);
}

/**
 * Purely fair-play strategic assessment built strictly from `PlayerView`
 * (visible boards, viewer's own hand/score, public deck counts, and Age backs).
 */
export function assessSituation(view: PlayerView): SituationAssessment {
  const ally =
    view.variant === '2v2'
      ? view.players.find(
          (p) => p.id !== view.viewerId && !p.eliminated && p.teamId === view.viewer.teamId
        ) ?? null
      : null;
  const opponents = view.players.filter(
    (p) =>
      p.id !== view.viewerId &&
      !p.eliminated &&
      (view.variant !== '2v2' || p.teamId !== view.viewer.teamId)
  );
  const myIcons = getVisibleIconCounts(view.viewer.board);
  const myIconTotal = sumIconCounts(myIcons);
  const myScore = view.viewer.scoreTotal;
  const allyScore = ally ? sumBacksAge(ally.scoreBacks) : 0;
  const myTopAge = view.viewer.highestTopAge;

  let maxOppScore = 0;
  let sumOppScore = 0;
  let maxOppTopAge = 0;
  let maxOppIconTotal = 0;
  let maxOppAch = 0;
  let sumOppAch = 0;
  let oppHasActiveDemand = false;
  let oppApproachingAge4 = false;

  for (const opp of opponents) {
    const oppScore = sumBacksAge(opp.scoreBacks);
    sumOppScore += oppScore;
    if (oppScore > maxOppScore) maxOppScore = oppScore;
    if (opp.highestTopAge > maxOppTopAge) maxOppTopAge = opp.highestTopAge;
    const oppIconSum = sumIconCounts(opp.visibleIcons);
    if (oppIconSum > maxOppIconTotal) maxOppIconTotal = oppIconSum;
    sumOppAch += opp.achievementCount;
    if (opp.achievementCount > maxOppAch) maxOppAch = opp.achievementCount;

    for (const top of getTopCards(opp.board)) {
      for (const ab of top.abilities) {
        if (ab.isDemand && opp.visibleIcons[ab.icon] > myIcons[ab.icon]) {
          oppHasActiveDemand = true;
        }
      }
    }

    if (opp.highestTopAge >= 3 || opp.handBacks.some((b) => b.age >= 4)) {
      oppApproachingAge4 = true;
    }
  }

  const is2v2 = view.variant === '2v2';
  const myTeamAch = view.viewer.achievements.length + (ally?.achievementCount ?? 0);
  const effectiveMyScore = is2v2 ? myScore + allyScore : myScore;
  const effectiveOppScore = is2v2 ? sumOppScore : maxOppScore;
  const effectiveMyAch = is2v2 ? myTeamAch : view.viewer.achievements.length;
  const effectiveOppAch = is2v2 ? sumOppAch : maxOppAch;

  const scoreDiff = effectiveMyScore - effectiveOppScore;
  const achDiff = effectiveMyAch - effectiveOppAch;
  const myAchToWin = view.achievementTarget - effectiveMyAch;
  const oppAchToWin = view.achievementTarget - effectiveOppAch;

  const isLosingPoints = scoreDiff <= -5 || (achDiff < 0 && scoreDiff <= 0);
  const isLosingBoard =
    oppHasActiveDemand || maxOppTopAge > myTopAge || maxOppIconTotal > myIconTotal + 3;
  const isExtremelyLosing =
    (oppAchToWin <= 1 && achDiff <= -2) ||
    (achDiff <= -2 && scoreDiff <= -8) ||
    maxOppTopAge >= myTopAge + 3 ||
    (scoreDiff <= -15 && myTopAge < maxOppTopAge);

  // Factory icon awareness once any player nears Age 4 (without deckCounts[4] < 10 which is true from Turn 1)
  const age4ActiveOrApproaching =
    oppApproachingAge4 || myTopAge >= 3 || view.viewer.hand.some((c) => c.age >= 4);
  // Gunpowder awareness: only triggers once at least one opponent has reached Age 3 (or holds Age 4+)
  // and Gunpowder's location is not visibly accounted for
  const gunpowderThreat = oppApproachingAge4 && !isGunpowderVisiblyKnown(view);

  // Public card counting on Age 1 unseen cards
  const seen = collectVisiblySeenDefIds(view);
  const unseenAge1 = AGE1_BASE_CARDS.filter((c) => !seen.has(c.id));
  const unseenPool = unseenAge1.length > 0 ? unseenAge1 : AGE1_BASE_CARDS;
  const unseenAge1TowerRatio =
    unseenPool.filter(
      (c) =>
        c.icons.tl === 'tower' ||
        c.icons.bl === 'tower' ||
        c.icons.bc === 'tower' ||
        c.icons.br === 'tower'
    ).length / unseenPool.length;
  const unseenAge1BoardMatchRatio =
    unseenPool.filter((c) => view.viewer.board[c.color].cards.length > 0).length / unseenPool.length;

  const nextAchCost =
    view.standardAchievementBacks.length > 0
      ? Math.min(...view.standardAchievementBacks.map((b) => b.age)) * 5
      : 999;
  const closeToAchieve = myScore > 0 && nextAchCost - myScore <= 5;

  const pointsFocus =
    1.0 +
    (myAchToWin <= 2 ? 0.6 : 0) +
    (closeToAchieve ? 0.45 : 0) +
    (isLosingPoints ? 0.4 : 0);

  const techUpFocus =
    1.0 +
    (isLosingBoard ? 0.5 : 0) +
    (maxOppTopAge > myTopAge ? 0.45 : 0) +
    (isExtremelyLosing ? 1.1 : 0);

  const totalOppHandScore = opponents.reduce((s, o) => s + o.handCount + o.scoreCount, 0);
  const demandFocus =
    1.0 +
    (totalOppHandScore >= 3 ? 0.35 : -0.25) +
    (achDiff < 0 && !isExtremelyLosing ? 0.25 : 0);

  const splaysAvailable = ALL_COLORS.filter((c) => view.viewer.board[c].cards.length >= 2).length;
  const iconsSplayFocus =
    1.0 +
    (isLosingBoard ? 0.5 : 0) +
    (oppHasActiveDemand ? 0.45 : 0) +
    (splaysAvailable >= 1 ? 0.25 : 0);

  // Special Achievement 1-3 turn opportunity checks
  const availSpecial = new Set(view.availableSpecialAchievements);
  const hasMasonry =
    getTopCard(view.viewer.board.yellow)?.defId === 'B006' ||
    view.viewer.hand.some((c) => c.defId === 'B006');
  const redCount = view.viewer.board.red.cards.length;
  const monumentByRed3 = availSpecial.has('monument') && hasMasonry && redCount <= 3 && redCount >= 2;
  const monumentNeedRed =
    availSpecial.has('monument') &&
    hasMasonry &&
    redCount < 3 &&
    redCount + view.viewer.hand.filter((c) => c.color === 'red').length >= 3;

  const missingEmpireIcons = availSpecial.has('empire')
    ? EMPIRE_ICONS.filter((ic) => myIcons[ic] < 3)
    : [];
  const empireClose =
    availSpecial.has('empire') &&
    missingEmpireIcons.length > 0 &&
    missingEmpireIcons.length <= 2 &&
    EMPIRE_ICONS.every((ic) => myIcons[ic] >= 1);

  const worldClose = availSpecial.has('world') && myIcons.clock >= 7;
  const wonderClose =
    availSpecial.has('wonder') &&
    countWonderEligibleColors(view.viewer.board) >= 3 &&
    ALL_COLORS.filter((c) => view.viewer.board[c].cards.length >= 2).length >= 4;
  const universeClose =
    availSpecial.has('universe') &&
    getTopCards(view.viewer.board).filter((c) => c.age >= 8).length >= 3;

  const iconNeedWeights: Record<FunctionalIcon, number> = {
    tower: 1,
    coin: 1,
    leaf: 1,
    lightbulb: 1,
    factory: 1,
    clock: 1,
    persona: 1,
  };

  for (const ic of ['tower', 'coin', 'leaf', 'lightbulb', 'factory', 'clock', 'persona'] as FunctionalIcon[]) {
    let w = 1.0;
    const maxOppIc = opponents.reduce((m, o) => Math.max(m, o.visibleIcons[ic]), 0);
    if (maxOppIc > 0 && myIcons[ic] <= maxOppIc && maxOppIc - myIcons[ic] <= 2) {
      w += 0.8;
    }
    for (const top of getTopCards(view.viewer.board)) {
      if (top.featuredIcon === ic && top.abilities.length > 0) {
        w += top.abilities.some((a) => a.isDemand) ? 0.9 : 0.45;
      }
    }
    for (const opp of opponents) {
      for (const top of getTopCards(opp.board)) {
        if (top.abilities.some((a) => a.isDemand && a.icon === ic) && opp.visibleIcons[ic] >= myIcons[ic]) {
          w += 1.1;
        }
      }
    }
    if (empireClose && missingEmpireIcons.includes(ic)) {
      w += 1.6;
    }
    if (worldClose && ic === 'clock') {
      w += 1.4;
    }
    if (age4ActiveOrApproaching && ic === 'factory') {
      w += 0.6;
    }
    iconNeedWeights[ic] = w;
  }

  return {
    weights: {
      pointsFocus,
      techUpFocus,
      demandFocus,
      iconsSplayFocus,
      isLosingPoints,
      isLosingBoard,
      isExtremelyLosing,
      gunpowderThreat,
    },
    myScore,
    maxOppScore,
    maxOppTopAge,
    myIconTotal,
    maxOppIconTotal,
    opponents,
    unseenAge1TowerRatio,
    unseenAge1BoardMatchRatio,
    specialPlans: {
      monumentByRed3,
      monumentNeedRed,
      empireMissingIcons: empireClose ? missingEmpireIcons : [],
      worldClose,
      wonderClose,
      universeClose,
    },
    iconNeedWeights,
  };
}

function scoreCardIconsForPlayer(
  card: CardInstance,
  situ: SituationAssessment,
  slots: readonly ('tl' | 'bl' | 'bc' | 'br')[] = ['tl', 'bl', 'bc', 'br']
): number {
  let score = 0;
  for (const s of slots) {
    const ic = card.icons[s];
    if (ic !== 'hexagon') {
      score += situ.iconNeedWeights[ic];
    }
  }
  return score;
}

/**
 * Evaluates a splay transition (both immediate icons exposed AND future-meld/tuck
 * capacity ordered strictly: left (1) < right (2) < up (3) < aslant/askew (4)).
 */
export function computeSplayGainScore(
  stackCards: readonly CardInstance[],
  currentSplay: SplayDirection,
  targetSplay: Exclude<SplayDirection, 'none'>,
  situ: SituationAssessment,
  sameColorInHandCount = 0
): number {
  if (stackCards.length < 2 || currentSplay === targetSplay) return 0;
  const prevSlots = new Set(getExposedSlots(currentSplay));
  const nextSlots = getExposedSlots(targetSplay);
  const addedSlots = nextSlots.filter((s) => !prevSlots.has(s));
  const removedSlots = Array.from(prevSlots).filter((s) => !nextSlots.includes(s));

  let delta = 0;
  // 1. Immediate icons exposed/hidden on currently covered cards
  for (let i = 0; i < stackCards.length - 1; i++) {
    const c = stackCards[i];
    for (const s of addedSlots) {
      const ic = c.icons[s];
      if (ic !== 'hexagon') delta += situ.iconNeedWeights[ic] * 2.2;
    }
    for (const s of removedSlots) {
      const ic = c.icons[s];
      if (ic !== 'hexagon') delta -= situ.iconNeedWeights[ic] * 2.2;
    }
  }

  // 2. Future-meld splay value: current top card will remain splayed when covered,
  // and all subsequent melds/tucks on this stack inherit the splay direction!
  const rankDelta = SPLAY_RANK[targetSplay] - SPLAY_RANK[currentSplay];
  const topCard = stackCards[stackCards.length - 1];
  const handBoost = 1 + Math.min(2, sameColorInHandCount) * 0.6;
  for (const s of addedSlots) {
    const ic = topCard.icons[s];
    if (ic !== 'hexagon') {
      delta += situ.iconNeedWeights[ic] * 0.9 * handBoost;
    }
  }
  for (const s of removedSlots) {
    const ic = topCard.icons[s];
    if (ic !== 'hexagon') {
      delta -= situ.iconNeedWeights[ic] * 0.9 * handBoost;
    }
  }

  // Rank progression bonus ensures splaying has positive future value even when hexagons sit in the immediate slots
  if (rankDelta > 0) {
    delta += rankDelta * (1.85 + Math.min(2, sameColorInHandCount) * 1.1) * situ.weights.iconsSplayFocus;
  } else {
    delta += rankDelta * 2.6 * situ.weights.iconsSplayFocus;
  }

  // 3. Wonder Special Achievement progress (Right / Up / Aslant)
  const wasWonderEligible = currentSplay === 'right' || currentSplay === 'up' || currentSplay === 'aslant';
  const isWonderEligible = targetSplay === 'right' || targetSplay === 'up' || targetSplay === 'aslant';
  if (!wasWonderEligible && isWonderEligible) {
    delta += situ.specialPlans.wonderClose ? 10 : 2.2;
  } else if (wasWonderEligible && !isWonderEligible) {
    delta -= situ.specialPlans.wonderClose ? 10 : 2.2;
  }

  return delta;
}

function estimateHandCardKeepValue(view: PlayerView, card: CardInstance, situ: SituationAssessment): number {
  let val = card.age * 2.2 * situ.weights.techUpFocus;
  if (card.age > view.viewer.highestTopAge) val += (card.age - view.viewer.highestTopAge) * 2.2;
  if (situ.weights.isExtremelyLosing && card.age >= 8) val += 10;
  if (view.viewer.board[card.color].cards.length === 0) val += 2.5;
  if (card.abilities.length > 0 && !card.isPlaceholder) val += 1.5;
  const currentTop = getTopCard(view.viewer.board[card.color]);
  if (currentTop && currentTop.age > card.age + 1) val -= 1.8;
  return val;
}

function hashViewDeterministic(view: PlayerView): number {
  let h = 2166136261;
  const mix = (n: number) => {
    h ^= n & 0xffffffff;
    h = Math.imul(h, 16777619) >>> 0;
  };
  mix(view.turnNumber);
  mix(view.actionsRemaining);
  mix(view.viewer.scoreTotal);
  mix(view.viewer.achievements.length);
  mix(view.viewer.hand.length);
  for (const age of ALL_AGES) mix(view.deckCounts[age]);
  for (const p of view.players) {
    mix(p.handCount);
    mix(p.scoreCount);
    mix(p.highestTopAge);
    mix(p.achievementCount);
  }
  return h || 1;
}

function makeNeutralCardFromBack(back: CardBack, idx: number): CardInstance {
  const color = ALL_COLORS[(back.age + idx) % ALL_COLORS.length];
  const iconsList: FunctionalIcon[] = ['tower', 'coin', 'leaf', 'lightbulb', 'factory', 'clock'];
  const featured = iconsList[(back.age + idx) % iconsList.length];
  return {
    instanceId: back.instanceId || `sim_back_${back.age}_${idx}`,
    defId: `SIM_P_${back.age}_${idx}`,
    age: back.age,
    set: 'base',
    name: `Card [${back.age}]`,
    color,
    icons: { tl: 'hexagon', bl: featured, bc: featured, br: 'hexagon' },
    featuredIcon: featured,
    abilities: [],
    isPlaceholder: false,
  };
}

/**
 * Reconstructs a fair-play hypothetical `GameState` strictly from `PlayerView`
 * (zero hidden-information access). Unseen cards in opponent hands, scores, decks,
 * and standard achievements are sampled deterministically from unseen catalog cards
 * matching each zone's exact visible age backs.
 */
export function buildFairPlaySimState(view: PlayerView, sampleIndex = 0): GameState {
  const seen = collectVisiblySeenDefIds(view);
  const baseSeed = hashViewDeterministic(view);

  const unseenByAge = {} as Record<Age, CardDefinition[]>;
  const allByAge = ACTIVE_BY_AGE;
  for (const age of ALL_AGES) {
    const allAge = allByAge[age];
    const unseenAge = allAge.filter((c) => !seen.has(c.id));
    const pool = unseenAge.length > 0 ? unseenAge : allAge;
    unseenByAge[age] = shuffleWithSeed(pool, (baseSeed + sampleIndex * 1009 + age * 97) >>> 0).value;
  }

  let simSeq = 0;
  const pickUnseenByAgeAndSet = (age: Age, set: 'base', instanceId?: string): CardInstance => {
    const pool = unseenByAge[age];
    let idx = pool.findIndex((c) => c.set === set);
    if (idx === -1 && pool.length > 0) idx = 0;
    if (idx !== -1) {
      const [def] = pool.splice(idx, 1);
      const inst = instantiateCard(def, `sim_${sampleIndex}_${++simSeq}`);
      if (instanceId) inst.instanceId = instanceId;
      return inst;
    }
    const fallbackPool = allByAge[age];
    if (fallbackPool.length > 0) {
      const def = fallbackPool[(simSeq + sampleIndex) % fallbackPool.length];
      const inst = instantiateCard(def, `sim_${sampleIndex}_${++simSeq}`);
      if (instanceId) inst.instanceId = instanceId;
      return inst;
    }
    return makeNeutralCardFromBack({ instanceId: instanceId ?? `sim_${++simSeq}`, age, set }, ++simSeq);
  };

  const players: PlayerState[] = view.players.map((pv) => {
    if (pv.id === view.viewerId) {
      return {
        id: pv.id,
        name: pv.name,
        isAI: pv.isAI,
        teamId: pv.teamId,
        eliminated: pv.eliminated,
        hand: [...view.viewer.hand],
        board: cloneBoard(view.viewer.board),
        scorePile: [...view.viewer.scorePile],
        achievements: [...view.viewer.achievements],
      };
    }

    const oppAchievements: ClaimedAchievement[] = pv.achievementBacks.map((ab) => ({
      id: ab.id,
      kind: ab.kind,
      age: ab.age,
      specialId: ab.specialId,
    }));

    return {
      id: pv.id,
      name: pv.name,
      isAI: pv.isAI,
      teamId: pv.teamId,
      eliminated: pv.eliminated,
      hand: pv.handBacks.map((b) => pickUnseenByAgeAndSet(b.age, b.set, b.instanceId)),
      board: cloneBoard(pv.board),
      scorePile: pv.scoreBacks.map((b) => pickUnseenByAgeAndSet(b.age, b.set, b.instanceId)),
      achievements: oppAchievements,
    };
  });

  const decks = {} as Record<Age, CardInstance[]>;
  for (const age of ALL_AGES) {
    const count = view.deckCounts[age] ?? 0;
    const cards: CardInstance[] = [];
    for (let i = 0; i < count; i++) {
      cards.push(pickUnseenByAgeAndSet(age, 'base'));
    }
    decks[age] = cards;
  }

  const standardAchievements = view.standardAchievementBacks.map((b) =>
    pickUnseenByAgeAndSet(b.age, b.set, b.instanceId)
  );
  const junk = view.junkBacks.map((b) => pickUnseenByAgeAndSet(b.age, b.set, b.instanceId));

  const currentIdx = Math.max(0, players.findIndex((p) => p.id === view.currentPlayerId));

  return {
    version: 1,
    seed: (baseSeed + sampleIndex) >>> 0,
    rngState: (baseSeed + sampleIndex * 31) >>> 0,
    variant: view.variant,
    controlMode: view.controlMode,
    fastSimulation: true,
    phase: view.phase,
    turnNumber: view.turnNumber,
    currentPlayerIndex: currentIdx,
    actionsRemaining: view.actionsRemaining,
    actionsTotalThisTurn: view.actionsRemaining === 1 && view.turnNumber <= 2 ? 1 : 2,
    openingSingleActionTurnsRemaining: 0,
    achievementTarget: view.achievementTarget,
    players,
    decks,
    standardAchievements,
    availableSpecialAchievements: [...view.availableSpecialAchievements],
    junk,
    revealedCardIds: [],
    setupSelections: {},
    pendingPrompts: [],
    activeDogma: null,
    actionStats: { tuckedOrScoredCount: 0 },
    log: [],
    victory: view.victory,
  };
}

function scorePlayerHandQuality(
  hand: readonly CardInstance[],
  board: PlayerBoard,
  topAge: number,
  weights: StrategyWeights,
  params: AIHandParams,
  includeDetails: boolean
): number {
  let hasTechBreakthrough = false;
  const cardValues: number[] = [];

  for (const c of hand) {
    let hv = c.age * params.handAgeWeight * weights.techUpFocus;
    if (c.age > topAge) {
      hv += (c.age - topAge) * params.techAboveTopBonus * weights.techUpFocus;
      hasTechBreakthrough = true;
    } else if (params.staleCardPenaltyPerAge > 0 && topAge - c.age >= 3) {
      hv -= (topAge - c.age - 2) * params.staleCardPenaltyPerAge;
    }
    if (board[c.color].cards.length === 0) hv += params.emptyColorBonus;
    if (includeDetails && c.abilities.length > 0 && !c.isPlaceholder) {
      hv += params.abilityBonus;
    }
    if (includeDetails && weights.isExtremelyLosing && c.age >= 8) hv += 10;
    cardValues.push(Math.max(0, hv));
  }

  let handQuality = 0;
  if (params.excessCardWeight < 1 && cardValues.length > params.softCap) {
    cardValues.sort((a, b) => b - a);
    for (let i = 0; i < cardValues.length; i++) {
      const mult = i < params.softCap ? 1 : params.excessCardWeight;
      handQuality += cardValues[i] * mult;
    }
  } else {
    for (const v of cardValues) handQuality += v;
  }

  if (includeDetails && hasTechBreakthrough) {
    handQuality += 2.2 * weights.techUpFocus;
  }
  if (hand.length > params.softCap) {
    const excess = hand.length - params.softCap;
    handQuality -= excess * params.penaltyPerExcess + excess * excess * params.quadraticExcessPenalty;
  }
  return handQuality;
}

/**
 * Unified board-state evaluator used to rate EVERY candidate move (Achieve, Dogma,
 * Meld, Draw, and Prompt responses) strictly by the resulting change to the table.
 */
export function evaluateGameStateForPlayer(
  state: GameState,
  playerId: string,
  situ: SituationAssessment,
  breakdownOut?: Record<string, number>,
  handParams: AIHandParams = DEFAULT_AI_HAND_PARAMS
): number {
  const me = state.players.find((p) => p.id === playerId);
  if (!me || me.eliminated) {
    if (breakdownOut) breakdownOut['Eliminated'] = -100000;
    return -100000;
  }

  if (state.phase === 'gameover' && state.victory) {
    const val = state.victory.winnerPlayerIds.includes(playerId)
      ? 100000
      : state.victory.winnerPlayerIds.length === 0
      ? -5000
      : -100000;
    if (breakdownOut) breakdownOut['Match Victory'] = val;
    return val;
  }

  const { weights } = situ;
  const is2v2 = state.variant === '2v2';
  const ally = is2v2
    ? state.players.find((p) => p.id !== playerId && !p.eliminated && p.teamId === me.teamId)
    : undefined;
  const opps = state.players.filter(
    (p) => p.id !== playerId && !p.eliminated && (!is2v2 || p.teamId !== me.teamId)
  );
  // In 2v2, both opponents share the same win bar so each point/achievement counts at full weight
  const oppFactor = is2v2 ? 0.85 : opps.length > 1 ? 0.62 : 0.85;

  const myIcons = getVisibleIconCounts(me.board);
  const myTopAge = getHighestTopCardAge(me.board);
  const myScore = computeScoreTotal(me);
  const myAch = me.achievements.length;
  const allyScore = ally ? computeScoreTotal(ally) : 0;
  const allyAch = ally ? ally.achievements.length : 0;
  const allyTopAge = ally ? getHighestTopCardAge(ally.board) : 0;
  const teamAch = myAch + allyAch;

  let total = 0;
  const addF = (name: string, val: number) => {
    total += val;
    if (breakdownOut && val !== 0) {
      breakdownOut[name] = (breakdownOut[name] ?? 0) + val;
    }
  };

  // 1. Achievements (ours + ally vs opponents)
  addF(
    'Your Achievements',
    myAch * (48 * weights.pointsFocus) +
      ((is2v2 ? teamAch : myAch) >= state.achievementTarget - 1 ? 16 : 0)
  );
  if (ally) {
    addF('Ally Achievements', allyAch * (48 * weights.pointsFocus));
  }

  let maxOppAch = 0;
  let sumOppAch = 0;
  let maxOppScore = 0;
  let sumOppScore = 0;
  let maxOppTopAge = 0;
  let maxOppTower = 0;

  for (const opp of opps) {
    sumOppAch += opp.achievements.length;
    if (opp.achievements.length > maxOppAch) maxOppAch = opp.achievements.length;
    const os = computeScoreTotal(opp);
    sumOppScore += os;
    if (os > maxOppScore) maxOppScore = os;
    const oTop = getHighestTopCardAge(opp.board);
    if (oTop > maxOppTopAge) maxOppTopAge = oTop;
    const oIcons = getVisibleIconCounts(opp.board);
    if (oIcons.tower > maxOppTower) maxOppTower = oIcons.tower;
  }

  if (is2v2) {
    addF(
      'Opponent Achievements',
      -sumOppAch * 44 * oppFactor - (sumOppAch >= state.achievementTarget - 1 ? 24 * oppFactor : 0)
    );
  } else {
    addF(
      'Opponent Achievements',
      -maxOppAch * 42 * oppFactor - (maxOppAch >= state.achievementTarget - 1 ? 24 * oppFactor : 0)
    );
  }

  // 2. Score pile, claim readiness, & junked achievement threat suppression across [1]..[10]
  addF('Score Pile', myScore * (2.5 * weights.pointsFocus));
  if (ally) {
    addF('Ally Score Pile', allyScore * (2.5 * weights.pointsFocus));
  }
  addF(
    'Opponent Score Pile',
    (is2v2
      ? -sumOppScore * 2.15
      : -(maxOppScore * 1.85 + (opps.length > 1 ? (sumOppScore - maxOppScore) * 0.65 : 0))) *
      weights.pointsFocus *
      oppFactor
  );

  let myReadyAch = 0;
  let allyReadyAch = 0;
  let oppReadyAch = 0;
  let oppThreatenedAchValue = 0;
  for (const std of state.standardAchievements) {
    const meReady = myScore >= std.age * 5 && myTopAge >= std.age;
    const aReady = Boolean(ally && allyScore >= std.age * 5 && allyTopAge >= std.age);
    const oppReady = opps.some(
      (o) => computeScoreTotal(o) >= std.age * 5 && getHighestTopCardAge(o.board) >= std.age
    );
    if (meReady) myReadyAch += 1;
    if (aReady) allyReadyAch += 1;
    if (oppReady) oppReadyAch += 1;
    if (!meReady && !aReady && (oppReady || (weights.isLosingPoints && maxOppScore >= std.age * 4))) {
      oppThreatenedAchValue += 1;
    }
  }
  addF('Achievement Readiness', myReadyAch * 7.5 * weights.pointsFocus);
  if (ally && allyReadyAch > 0) {
    addF('Ally Achievement Readiness', allyReadyAch * 7.5 * weights.pointsFocus);
  }
  addF(
    'Opponent Achievement Threat',
    -oppReadyAch * 6.0 * oppFactor * weights.pointsFocus -
      (oppThreatenedAchValue > 0 ? oppThreatenedAchValue * 1.6 * weights.pointsFocus : 0)
  );

  // 3. Board presence, top ages, splay quality (immediate + future-meld rank), & icons
  addF('Highest Top Age', myTopAge * 7.5 * weights.techUpFocus + Math.max(0, myTopAge - 1) * 1.5);
  let activeColors = 0;
  let sumTopAges = 0;
  let totalBoardCards = 0;
  let topAbilityQuality = 0;
  let futureSplayScore = 0;
  let exposedTowerTops = 0;
  let desperationTopBonus = 0;

  for (const color of ALL_COLORS) {
    const stack = me.board[color];
    totalBoardCards += stack.cards.length;
    const top = getTopCard(stack);
    if (!top) continue;

    activeColors += 1;
    sumTopAges += top.age;
    if (weights.isExtremelyLosing && top.age >= 8) desperationTopBonus += 16;

    if (top.abilities.length > 0 && !top.isPlaceholder) {
      topAbilityQuality += 1.6 + Math.min(2, top.abilities.length) * 0.5;
      if (top.abilities.some((a) => a.isDemand) && myIcons[top.featuredIcon] > opps.reduce((m, o) => Math.max(m, getVisibleIconCounts(o.board)[top.featuredIcon]), 0)) {
        topAbilityQuality += 2.0 * weights.demandFocus;
      }
    }

    if (weights.gunpowderThreat && cardHasIcon(top, 'tower')) {
      exposedTowerTops += 1;
    }

    // Future-meld / future-tuck splay capacity (worse to best: left < right < up < aslant)
    if (stack.cards.length >= 2 && stack.splay !== 'none') {
      const sameColorInHand = me.hand.filter((c) => c.color === color).length;
      const rank = SPLAY_RANK[stack.splay];
      futureSplayScore += rank * (2.2 + Math.min(2, sameColorInHand) * 1.1) * weights.iconsSplayFocus;

      const exposed = getExposedSlots(stack.splay);
      for (const s of exposed) {
        const ic = top.icons[s];
        if (ic !== 'hexagon') {
          futureSplayScore += situ.iconNeedWeights[ic] * (0.85 + Math.min(2, sameColorInHand) * 0.5);
        }
      }
    }
  }

  if (desperationTopBonus > 0) addF('Late-Age Catch-Up', desperationTopBonus);
  const topAgeScale = 2.5 * (0.75 + 0.25 * weights.techUpFocus);
  addF('Board Colors & Cards', activeColors * 5.2 + sumTopAges * topAgeScale + totalBoardCards * 1.5);
  addF('Top Card Abilities', topAbilityQuality);
  addF('Splay Progression', futureSplayScore);
  if (countWonderEligibleColors(me.board) > 0) {
    addF('Wonder Splay Progress', countWonderEligibleColors(me.board) * (situ.specialPlans.wonderClose ? 10 : 2.5));
  }

  let visibleIconScore = 0;
  for (const ic of Object.keys(myIcons) as FunctionalIcon[]) {
    visibleIconScore += myIcons[ic] * 1.85 * situ.iconNeedWeights[ic] * weights.iconsSplayFocus;
  }
  addF('Visible Icons', visibleIconScore);

  // Gunpowder penalty on exposed tower tops when our Tower total isn't safely ahead
  if (weights.gunpowderThreat && myIcons.tower < maxOppTower + 3) {
    if (exposedTowerTops === 0) {
      addF('Gunpowder Tower Safety', 14.0);
    } else {
      addF('Gunpowder Tower Safety', -(exposedTowerTops * 16.0 + (exposedTowerTops > 1 ? (exposedTowerTops - 1) * 6.0 : 0)));
    }
  }

  // Monument 3-Red preservation bonus when Masonry is live & Monument unclaimed
  const hasMasonryNow =
    getTopCard(me.board.yellow)?.defId === 'B006' || me.hand.some((c) => c.defId === 'B006');
  if (state.availableSpecialAchievements.includes('monument') && hasMasonryNow && me.board.red.cards.length === 3) {
    addF('Monument 3-Red Setup', 22);
  }

  // Opponent board strength subtraction
  let oppBoardDelta = 0;
  for (const opp of opps) {
    const oppTops = getTopCards(opp.board);
    const oppIconSum = sumIconCounts(getVisibleIconCounts(opp.board));
    const oppSumAges = oppTops.reduce((s, c) => s + c.age, 0);
    const oppBoardCards = ALL_COLORS.reduce((s, col) => s + opp.board[col].cards.length, 0);
    const oppSplayRankSum = ALL_COLORS.reduce((s, col) => s + SPLAY_RANK[opp.board[col].splay], 0);
    oppBoardDelta -=
      (getHighestTopCardAge(opp.board) * 4.0 +
        oppTops.length * 3.5 +
        oppSumAges * 1.4 +
        oppBoardCards * 1.1 +
        oppIconSum * 1.25 +
        oppSplayRankSum * 1.8) *
      oppFactor;
  }
  addF('Opponent Board Strength', oppBoardDelta);

  // 4. Hand quality (intrinsic bonus for acquiring higher-tech cards) & opponent hand subtraction
  const handQuality = scorePlayerHandQuality(me.hand, me.board, myTopAge, weights, handParams, true);
  addF('Hand Value & Tech', handQuality);

  let oppHandDelta = 0;
  for (const opp of opps) {
    const oppHandAges = opp.hand.reduce((s, c) => s + c.age, 0);
    oppHandDelta -= (opp.hand.length * 2.1 + oppHandAges * 1.1) * oppFactor;
  }
  addF('Opponent Hand', oppHandDelta);

  // 4b. Ally board, icons, and hand evaluated with 1:1 parity with your own state
  // (harming an ally is bad, no worse than harming yourself; helping both teammates is additive)
  if (ally) {
    const allyIcons = getVisibleIconCounts(ally.board);
    const allyIconSum = sumIconCounts(allyIcons);
    let allyActiveColors = 0;
    let allySumTopAges = 0;
    let allyTotalBoardCards = 0;
    let allyAbilityQuality = 0;
    let allySplayVal = 0;

    for (const color of ALL_COLORS) {
      const stack = ally.board[color];
      allyTotalBoardCards += stack.cards.length;
      const top = getTopCard(stack);
      if (!top) continue;
      allyActiveColors += 1;
      allySumTopAges += top.age;
      if (top.abilities.length > 0 && !top.isPlaceholder) {
        allyAbilityQuality += 1.6 + Math.min(2, top.abilities.length) * 0.5;
      }
      if (stack.cards.length >= 2 && stack.splay !== 'none') {
        allySplayVal += SPLAY_RANK[stack.splay] * 2.2 * weights.iconsSplayFocus;
      }
    }

    const allyHandQuality = scorePlayerHandQuality(
      ally.hand,
      ally.board,
      allyTopAge,
      weights,
      handParams,
      false
    );

    const allyBoardVal =
      allyTopAge * 7.5 * weights.techUpFocus +
      Math.max(0, allyTopAge - 1) * 1.5 +
      allyActiveColors * 5.2 +
      allySumTopAges * topAgeScale +
      allyTotalBoardCards * 1.5 +
      allyAbilityQuality +
      allySplayVal +
      allyIconSum * 1.85 * weights.iconsSplayFocus;

    addF('Ally Board & Icons', allyBoardVal);
    addF('Ally Hand & Tech', allyHandQuality);
  }

  // 5. Alternate card-effect victory progress & Space Traffic safety
  const myTops = getTopCards(me.board);
  const myTopIds = new Set(myTops.map((c) => c.defId));
  const myHandIds = new Set(me.hand.map((c) => c.defId));
  let altWin = 0;
  if ((myTopIds.has('B084') || myHandIds.has('B084')) && myIcons.lightbulb >= 14) {
    altWin += (myIcons.lightbulb - 12) * 2.8;
  }
  if ((myTopIds.has('B090') || myHandIds.has('B090')) && me.board.green.cards.length >= 6) {
    altWin += (me.board.green.cards.length - 5) * 3.5;
  }
  if ((myTopIds.has('B113') || myHandIds.has('B113')) && me.board.blue.cards.length >= 4) {
    altWin += (me.board.blue.cards.length - 3) * 2.5 + (me.board.blue.splay === 'aslant' ? 6 : 0);
  }
  if ((myTopIds.has('B106') || myHandIds.has('B106')) && me.hand.length >= 5) {
    altWin += me.hand.length * 1.8;
  }
  const spaceTrafficActive =
    myTopIds.has('B111') ||
    myHandIds.has('B111') ||
    opps.some((o) => getTopCards(o.board).some((c) => c.defId === 'B111'));
  if (spaceTrafficActive) {
    for (const col of ALL_COLORS) {
      if (me.board[col].cards[0]?.age === 11) {
        altWin -= 35;
      }
    }
  }
  if (altWin !== 0) addF('Card Win / Safety', altWin);

  return total;
}

function buildChooseCardsSubsets(
  state: GameState,
  prompt: Extract<NonNullable<GameState['pendingPrompts'][number]>, { kind: 'choose_cards' }>,
  situ: SituationAssessment,
  maxBranches: number,
  precomputedView?: PlayerView
): CardInstance[][] {
  const player = state.players.find((p) => p.id === prompt.playerId);
  const view = precomputedView ?? projectPlayerView(state, prompt.playerId);
  const titleUpper = getPromptFullText(prompt).toUpperCase();

  const sortedLow = [...prompt.candidates].sort(
    (a, b) => estimateHandCardKeepValue(view, a, situ) - estimateHandCardKeepValue(view, b, situ)
  );
  const sortedHigh = [...prompt.candidates].sort((a, b) => {
    const scoreA = a.age * 3 + scoreCardIconsForPlayer(a, situ);
    const scoreB = b.age * 3 + scoreCardIconsForPlayer(b, situ);
    return scoreB - scoreA;
  });

  const subsets: CardInstance[][] = [];
  const seenKeys = new Set<string>();
  const addSubset = (cards: CardInstance[]) => {
    const unique = Array.from(new Map(cards.map((c) => [c.instanceId, c])).values());
    const valid =
      (prompt.allowSkip && unique.length === 0) ||
      (unique.length >= prompt.min && unique.length <= prompt.max);
    if (!valid) return;
    const key = unique
      .map((c) => c.instanceId)
      .sort()
      .join('|');
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    subsets.push(unique);
  };

  if (prompt.allowSkip) addSubset([]);

  // Single-card subsets when max === 1 or small pool
  if (prompt.max === 1) {
    const limit = Math.max(maxBranches, Math.min(12, prompt.candidates.length));
    for (const c of sortedHigh.slice(0, limit)) addSubset([c]);
    for (const c of sortedLow.slice(0, limit)) addSubset([c]);
    return subsets.slice(0, Math.max(maxBranches, limit));
  }

  // Multi-card smart subsets (covers Masonry, Tools, Currency, Pottery, Road Building, Demands)
  addSubset(sortedHigh.slice(0, Math.min(prompt.max, sortedHigh.length)));
  addSubset(sortedLow.slice(0, Math.min(prompt.max, sortedLow.length)));
  if (prompt.min > 0) {
    addSubset(sortedHigh.slice(0, Math.min(prompt.min, sortedHigh.length)));
    addSubset(sortedLow.slice(0, Math.min(prompt.min, sortedLow.length)));
  }

  // Subset stopping Red board count at 3 (if melding Red cards while Monument is available)
  if (player && state.availableSpecialAchievements.includes('monument') && prompt.candidates.some((c) => c.color === 'red')) {
    let redCount = player.board.red.cards.length;
    const capRed: CardInstance[] = [];
    for (const c of sortedHigh) {
      if (capRed.length >= prompt.max) break;
      if (c.color === 'red' && redCount >= 3) continue;
      if (c.color === 'red') redCount += 1;
      capRed.push(c);
    }
    addSubset(capRed);
  }

  // Distinct-age subset (covers Currency / varied returns)
  const distinctAges: CardInstance[] = [];
  const agesSeen = new Set<number>();
  for (const c of sortedLow) {
    if (distinctAges.length >= prompt.max) break;
    if (!agesSeen.has(c.age) && c.age <= 3) {
      agesSeen.add(c.age);
      distinctAges.push(c);
    }
  }
  addSubset(distinctAges);

  // Weak <=2 subset (covers Tools / Pottery)
  const weak = sortedLow.filter((c) => c.age <= 2);
  addSubset(weak.slice(0, Math.min(prompt.max, weak.length)));

  // Prefix of 1..2 from sortedHigh
  if (prompt.max >= 2 && sortedHigh.length >= 1) {
    addSubset(sortedHigh.slice(0, 1));
    if (sortedHigh.length >= 2) addSubset(sortedHigh.slice(0, 2));
  }

  // Prefer shedding Tower cards on Gunpowder-threatened demands
  if ((titleUpper.includes('DEMAND') || titleUpper.includes('TRANSFER')) && situ.weights.gunpowderThreat) {
    const towerFirst = [...prompt.candidates].sort((a, b) => {
      const aPen = a.age * 3 + scoreCardIconsForPlayer(a, situ) - (cardHasIcon(a, 'tower') ? 6 : 0);
      const bPen = b.age * 3 + scoreCardIconsForPlayer(b, situ) - (cardHasIcon(b, 'tower') ? 6 : 0);
      return aPen - bPen;
    });
    addSubset(towerFirst.slice(0, Math.min(prompt.min, towerFirst.length)));
  }

  return subsets.slice(0, maxBranches);
}

export function buildCandidatePromptAnswers(
  state: GameState,
  prompt: NonNullable<GameState['pendingPrompts'][number]>,
  situ: SituationAssessment,
  maxBranches: number,
  precomputedView?: PlayerView
): TurnAction[] {
  const pid = prompt.playerId;

  if (prompt.kind === 'setup_meld') {
    return prompt.options.map((c) => ({
      type: 'setup_meld',
      playerId: pid,
      cardInstanceId: c.instanceId,
    }));
  }

  if (prompt.kind === 'choose_color') {
    const actions: TurnAction[] = prompt.options.map((color) => ({
      type: 'answer_prompt',
      playerId: pid,
      promptId: prompt.id,
      selectedColor: color,
    }));
    if (prompt.allowSkip) {
      actions.push({ type: 'answer_prompt', playerId: pid, promptId: prompt.id });
    }
    return actions;
  }

  if (prompt.kind === 'choose_yes_no') {
    return [
      { type: 'answer_prompt', playerId: pid, promptId: prompt.id, confirmed: true },
      { type: 'answer_prompt', playerId: pid, promptId: prompt.id, confirmed: false },
    ];
  }

  if (prompt.kind === 'choose_value') {
    return prompt.options.map((val) => ({
      type: 'answer_prompt',
      playerId: pid,
      promptId: prompt.id,
      selectedValue: val,
    }));
  }

  if (prompt.kind === 'choose_option') {
    return prompt.options.map((opt) => ({
      type: 'answer_prompt',
      playerId: pid,
      promptId: prompt.id,
      selectedOptionId: opt.id,
    }));
  }

  if (prompt.kind === 'choose_order') {
    return [
      {
        type: 'answer_prompt',
        playerId: pid,
        promptId: prompt.id,
        orderedCardIds: prompt.cards.map((c) => c.instanceId),
      },
    ];
  }

  if (prompt.kind === 'choose_cards') {
    const subsets = buildChooseCardsSubsets(state, prompt, situ, maxBranches, precomputedView);
    return subsets.map((cards) => ({
      type: 'answer_prompt',
      playerId: pid,
      promptId: prompt.id,
      selectedCardIds: cards.map((c) => c.instanceId),
    }));
  }

  return [];
}

export function resolveStateThroughPrompts(
  rawState: GameState,
  aiId: string,
  aiSitu: SituationAssessment,
  depth = 0,
  budget: { remaining: number } = { remaining: 24 },
  aiView?: PlayerView,
  handParams: AIHandParams = DEFAULT_AI_HAND_PARAMS,
  evaluateLeaf?: (state: GameState, playerId: string) => number
): GameState {
  if (rawState.phase !== 'playing' || rawState.pendingPrompts.length === 0 || depth >= 6) {
    return rawState;
  }

  const prompt = rawState.pendingPrompts[0];
  const actingId = prompt.playerId;
  const maxBranches =
    budget.remaining <= 0
      ? 1
      : depth >= 2
      ? 2
      : depth === 1
      ? actingId === aiId
        ? 3
        : 2
      : actingId === aiId
      ? 5
      : 2;

  const actingView =
    actingId !== aiId || prompt.kind === 'choose_cards'
      ? projectPlayerView(rawState, actingId)
      : undefined;
  const actingSitu =
    actingId === aiId ? aiSitu : assessSituation(actingView!);
  const candidates = buildCandidatePromptAnswers(
    rawState,
    prompt,
    actingSitu,
    maxBranches,
    actingView
  );

  if (candidates.length === 0) return rawState;

  if (budget.remaining <= 0 || candidates.length === 1) {
    try {
      const next = applyAction(rawState, candidates[0]);
      return resolveStateThroughPrompts(
        next,
        aiId,
        aiSitu,
        depth + 1,
        budget,
        aiView,
        handParams,
        evaluateLeaf
      );
    } catch {
      return rawState;
    }
  }

  let bestResolved: GameState | null = null;
  let bestScore = -Infinity;

  for (const ans of candidates) {
    if (budget.remaining <= 0 && bestResolved !== null) break;
    budget.remaining -= 1;
    try {
      const next = applyAction(rawState, ans);
      const resolved = resolveStateThroughPrompts(
        next,
        aiId,
        aiSitu,
        depth + 1,
        budget,
        aiView,
        handParams,
        evaluateLeaf
      );
      const score = evaluateLeaf
        ? evaluateLeaf(resolved, actingId)
        : evaluateGameStateForPlayer(resolved, actingId, actingSitu, undefined, handParams);
      if (score > bestScore) {
        bestScore = score;
        bestResolved = resolved;
      }
    } catch {
      // Ignore any branch that is illegal in this substate
    }
  }

  return bestResolved ?? rawState;
}

/**
 * Simulates the next opponent's strongest visible response (Achieve, visible top-card
 * Dogmas, or Draw) on `simAfter` using strictly public information, returning the
 * AI's board evaluation AFTER that opponent counter-move.
 */
function simulateOpponentBestCounterScore(
  simAfter: GameState,
  aiId: string,
  aiSitu: SituationAssessment,
  cachedOppSitu?: { oppId: string; situ: SituationAssessment },
  handParams: AIHandParams = DEFAULT_AI_HAND_PARAMS
): number | null {
  if (simAfter.phase !== 'playing') return null;

  const aiIdx = simAfter.players.findIndex((p) => p.id === aiId);
  if (aiIdx === -1) return null;
  const aiPlayer = simAfter.players[aiIdx];

  // Determine which opponent acts next (skip eliminated players and ally in 2v2)
  let oppIdx = simAfter.currentPlayerIndex;
  const isValidOpp = (p: PlayerState) =>
    !p.eliminated && p.id !== aiId && (simAfter.variant !== '2v2' || p.teamId !== aiPlayer.teamId);

  if (!isValidOpp(simAfter.players[oppIdx])) {
    let probe = (oppIdx + 1) % simAfter.players.length;
    while (probe !== oppIdx && !isValidOpp(simAfter.players[probe])) {
      probe = (probe + 1) % simAfter.players.length;
    }
    if (!isValidOpp(simAfter.players[probe])) return null;
    oppIdx = probe;
  }

  const opp = simAfter.players[oppIdx];
  if (!opp || opp.eliminated) return null;

  const oppSim: GameState = {
    ...simAfter,
    currentPlayerIndex: oppIdx,
    actionsRemaining: 1,
  };
  const oppOptions = getLegalTurnOptions(oppSim, opp.id);
  const oppSitu =
    cachedOppSitu && cachedOppSitu.oppId === opp.id
      ? cachedOppSitu.situ
      : assessSituation(projectPlayerView(oppSim, opp.id));

  const oppCandidates: TurnAction[] = [];
  if (oppOptions.achievableAges.length > 0) {
    const maxAch = oppOptions.achievableAges[oppOptions.achievableAges.length - 1];
    oppCandidates.push({ type: 'achieve', playerId: opp.id, age: maxAch });
  }
  for (const color of oppOptions.dogmaColors) {
    oppCandidates.push({ type: 'dogma', playerId: opp.id, color });
  }
  if (oppOptions.canDraw) {
    oppCandidates.push({ type: 'draw', playerId: opp.id });
  }

  let bestOppUtility = -Infinity;
  let aiScoreAfterBestOpp: number | null = null;

  for (const oppCand of oppCandidates) {
    try {
      const oppMid = applyAction(oppSim, oppCand);
      const oppAfter = resolveStateThroughPrompts(oppMid, opp.id, oppSitu, 2, { remaining: 8 }, undefined, handParams);
      const oppUtil = evaluateGameStateForPlayer(oppAfter, opp.id, oppSitu, undefined, handParams);
      if (oppUtil > bestOppUtility) {
        bestOppUtility = oppUtil;
        aiScoreAfterBestOpp = evaluateGameStateForPlayer(oppAfter, aiId, aiSitu, undefined, handParams);
      }
    } catch {
      // Ignore illegal branch
    }
  }

  return aiScoreAfterBestOpp;
}

export function hasMaterialStateChange(before: GameState, after: GameState): boolean {
  if (
    before.standardAchievements.length !== after.standardAchievements.length ||
    before.availableSpecialAchievements.length !== after.availableSpecialAchievements.length ||
    before.junk.length !== after.junk.length
  ) {
    return true;
  }
  for (const age of ALL_AGES) {
    if (before.decks[age].length !== after.decks[age].length) return true;
  }
  for (let i = 0; i < before.players.length; i++) {
    const bp = before.players[i];
    const ap = after.players[i];
    if (!ap) return true;
    if (
      bp.hand.length !== ap.hand.length ||
      bp.scorePile.length !== ap.scorePile.length ||
      bp.achievements.length !== ap.achievements.length
    ) {
      return true;
    }
    for (const col of ALL_COLORS) {
      if (
        bp.board[col].cards.length !== ap.board[col].cards.length ||
        bp.board[col].splay !== ap.board[col].splay
      ) {
        return true;
      }
    }
  }
  return false;
}

function simulateActionDelta(
  view: PlayerView,
  action: TurnAction,
  situ: SituationAssessment,
  sampleCount: number,
  precomputedSims?: readonly GameState[],
  includeOppLookahead = true,
  cachedOppSitu?: { oppId: string; situ: SituationAssessment },
  breakdownOut?: Record<string, number>,
  handParams: AIHandParams = DEFAULT_AI_HAND_PARAMS
): number | null {
  let sumDelta = 0;
  let validSamples = 0;
  let oppCounterAdjustment = 0;
  const factorSums: Record<string, number> | undefined = breakdownOut ? {} : undefined;
  let noOpPenaltySum = 0;

  for (let s = 0; s < sampleCount; s++) {
    const simBefore = precomputedSims?.[s] ?? buildFairPlaySimState(view, s);
    const beforeFactors: Record<string, number> | undefined = factorSums ? {} : undefined;
    const beforeScore = evaluateGameStateForPlayer(simBefore, view.viewerId, situ, beforeFactors, handParams);

    try {
      const simMid = applyAction(simBefore, action);
      const simAfter = resolveStateThroughPrompts(simMid, view.viewerId, situ, 0, { remaining: 20 }, undefined, handParams);
      const afterFactors: Record<string, number> | undefined = factorSums ? {} : undefined;
      const immediateScore = evaluateGameStateForPlayer(simAfter, view.viewerId, situ, afterFactors, handParams);
      let sampleDelta = immediateScore - beforeScore;

      if (factorSums && beforeFactors && afterFactors) {
        const keys = new Set([...Object.keys(beforeFactors), ...Object.keys(afterFactors)]);
        for (const k of keys) {
          const diff = (afterFactors[k] ?? 0) - (beforeFactors[k] ?? 0);
          if (diff !== 0) factorSums[k] = (factorSums[k] ?? 0) + diff;
        }
      }

      // Never waste an action activating a Dogma that resolves into a complete no-op
      if (action.type === 'dogma' && !hasMaterialStateChange(simBefore, simAfter)) {
        sampleDelta -= 8.0;
        noOpPenaltySum -= 8.0;
      }
      sumDelta += sampleDelta;
      validSamples += 1;

      // Apply opponent's best visible counter-delta once per candidate move consistently
      if (includeOppLookahead && s === 0 && simAfter.phase === 'playing') {
        const postOppScore = simulateOpponentBestCounterScore(
          simAfter,
          view.viewerId,
          situ,
          cachedOppSitu,
          handParams
        );
        if (postOppScore !== null) {
          const turnEnded = simAfter.players[simAfter.currentPlayerIndex]?.id !== view.viewerId;
          const oppWeight = turnEnded ? 0.9 : 0.2;
          oppCounterAdjustment = oppWeight * (postOppScore - immediateScore);
        }
      }
    } catch {
      // Action not legal in simulated state
    }
  }

  if (validSamples === 0) return null;
  if (breakdownOut && factorSums) {
    for (const [k, v] of Object.entries(factorSums)) {
      const avg = v / validSamples;
      if (Math.abs(avg) >= 0.01) breakdownOut[k] = avg;
    }
    if (noOpPenaltySum !== 0) {
      breakdownOut['No-Op Dogma Penalty'] = noOpPenaltySum / validSamples;
    }
    if (Math.abs(oppCounterAdjustment) >= 0.01) {
      breakdownOut['Opponent Counter-Play'] = oppCounterAdjustment;
    }
  }
  return sumDelta / validSamples + oppCounterAdjustment;
}

/**
 * Evaluates activating Dogma on `card` strictly by the resulting simulated
 * board-state delta across fair-play determinized samples.
 * Works generically for Ages 1–2 AND future Ages 3–11 cards.
 */
export function evaluateDogmaAction(
  view: PlayerView,
  card: CardInstance,
  situ: SituationAssessment,
  sampleCount = 2,
  includeOppLookahead = true,
  precomputedSims?: readonly GameState[]
): number {
  if (card.abilities.length === 0) return -100;
  const delta = simulateActionDelta(
    view,
    { type: 'dogma', playerId: view.viewerId, color: card.color },
    situ,
    sampleCount,
    precomputedSims,
    includeOppLookahead
  );
  return delta ?? -100;
}

export function scoreCardForSetup(card: CardInstance): number {
  const icons = [card.icons.tl, card.icons.bl, card.icons.bc, card.icons.br];
  let value = 0;
  for (const icon of icons) {
    if (icon === 'hexagon') continue;
    value += 2;
    if (icon === 'leaf' || icon === 'lightbulb') value += 0.5;
  }
  if (card.abilities.length > 0 && !card.isPlaceholder) {
    value += 1.0;
  }
  return value;
}

/**
 * Evaluates melding `card` by simulating the resulting board state (plus optional
 * second-action Dogma synergy if actions remain).
 */
export function scoreCardForMeld(
  view: PlayerView,
  card: CardInstance,
  situInput?: SituationAssessment,
  includeDogmaBonus = true
): number {
  const situ = situInput ?? assessSituation(view);
  const simBefore = buildFairPlaySimState(view, 0);
  const meBefore = simBefore.players.find((p) => p.id === view.viewerId);
  if (!meBefore) return -100;

  // Ensure card exists in sim hand even if called directly in unit test on non-hand card
  if (!meBefore.hand.some((c) => c.instanceId === card.instanceId)) {
    meBefore.hand.push({ ...card });
  }

  const beforeScore = evaluateGameStateForPlayer(simBefore, view.viewerId, situ);
  try {
    const simAfter = applyAction(simBefore, {
      type: 'meld',
      playerId: view.viewerId,
      cardInstanceId: card.instanceId,
    });
    let delta = evaluateGameStateForPlayer(simAfter, view.viewerId, situ) - beforeScore;

    // If melding reveals a useful Dogma and we have another action (or evaluating synergy), add dampened Dogma follow-up value
    if (includeDogmaBonus && card.abilities.length > 0 && simAfter.phase === 'playing') {
      const afterView = projectPlayerView(simAfter, view.viewerId);
      const afterSitu = assessSituation(afterView);
      const followUp = evaluateDogmaAction(afterView, card, afterSitu, 1, false);
      if (followUp > 4) {
        delta += Math.min(12, followUp * 0.35);
      }
    }

    return delta;
  } catch {
    return -100;
  }
}

export function simulateDirectPromptState(
  baseSim: GameState,
  view: PlayerView,
  prompt: NonNullable<GameState['pendingPrompts'][number]>,
  action: TurnAction,
  situ: SituationAssessment,
  evaluateStateFn?: (state: GameState, playerId: string) => number
): { sim: GameState; bonus: number; simulated: boolean } {
  const aiId = prompt.playerId;
  const sim = cloneGameState(baseSim);
  const me = sim.players.find((p) => p.id === aiId);
  if (!me) return { sim, bonus: 0, simulated: false };

  if (prompt.kind === 'setup_meld' && action.type === 'setup_meld') {
    sim.setupSelections[aiId] = action.cardInstanceId;
    const idx = me.hand.findIndex((h) => h.instanceId === action.cardInstanceId);
    if (idx !== -1) {
      const [c] = me.hand.splice(idx, 1);
      me.board[c.color].cards.push(c);
    }
    sim.phase = 'playing';
    sim.pendingPrompts = [];
    return { sim, bonus: 0, simulated: true };
  }

  if (action.type !== 'answer_prompt') {
    return { sim, bonus: 0, simulated: false };
  }

  const fullText = getPromptFullText(prompt);
  const titleUpper = fullText.toUpperCase();
  const srcLower = 'sourceLabel' in prompt && prompt.sourceLabel ? prompt.sourceLabel.toLowerCase() : '';

  if (prompt.kind === 'choose_order') {
    const orderedIds = action.orderedCardIds ?? prompt.cards.map((c) => c.instanceId);
    const cardMap = new Map(prompt.cards.map((c) => [c.instanceId, c]));
    const isTuck = titleUpper.includes('TUCK') && !titleUpper.includes('MELD');
    for (const cid of orderedIds) {
      const c = cardMap.get(cid);
      if (!c) continue;
      const hIdx = me.hand.findIndex((h) => h.instanceId === cid);
      if (hIdx !== -1) me.hand.splice(hIdx, 1);
      if (isTuck) tuckCardInstance(sim, aiId, { ...c });
      else meldCardInstance(sim, aiId, { ...c });
    }
    return { sim, bonus: 0, simulated: true };
  }

  if (prompt.kind === 'choose_color') {
    const color = action.selectedColor;
    if (!color) {
      return { sim, bonus: 0, simulated: true };
    }
    if (prompt.splayDirection && prompt.splayDirection !== 'none') {
      if (canSplayStack(me.board[color], prompt.splayDirection)) {
        splayPlayerColor(sim, aiId, color, prompt.splayDirection, 'Dogma');
        return { sim, bonus: 0, simulated: true };
      }
      return { sim, bonus: 0, simulated: false };
    }
    if (titleUpper.includes('COAL')) {
      const top = getTopCard(me.board[color]);
      if (top) {
        removeTopCardFromBoard(me, color);
        scoreCardInstance(sim, aiId, top);
        me.scorePile.push({ ...top, instanceId: `${top.instanceId}_sim2` });
      }
      return { sim, bonus: 0, simulated: true };
    }
    if (titleUpper.includes('EMPIRICISM')) {
      if (canSplayStack(me.board[color], 'up')) {
        splayPlayerColor(sim, aiId, color, 'up', 'Dogma');
      }
      return { sim, bonus: 0, simulated: true };
    }
    return { sim, bonus: 0, simulated: false };
  }

  if (prompt.kind === 'choose_yes_no') {
    const colorMatch = /\bsplay\s+(red|yellow|green|blue|purple)\s+(left|right|up|aslant|askew)\b/i.exec(
      fullText
    );
    if (action.confirmed) {
      if (colorMatch) {
        const col = colorMatch[1].toLowerCase() as CardColor;
        const dir = parseSplayDirectionFromText(fullText) ?? 'left';
        if (canSplayStack(me.board[col], dir)) {
          splayPlayerColor(sim, aiId, col, dir, 'Dogma');
        }
        return { sim, bonus: 0, simulated: true };
      }
      if (titleUpper.includes('TRANSLATION')) {
        while (me.scorePile.length > 0) {
          meldCardInstance(sim, aiId, me.scorePile.shift()!);
        }
        return { sim, bonus: 0, simulated: true };
      }
      if (titleUpper.includes('STEM CELLS')) {
        while (me.hand.length > 0) {
          scoreCardInstance(sim, aiId, me.hand.shift()!);
        }
        return { sim, bonus: 0, simulated: true };
      }
      if (titleUpper.includes('BICYCLE')) {
        const oldHand = me.hand;
        me.hand = me.scorePile;
        me.scorePile = oldHand;
        return { sim, bonus: 0, simulated: true };
      }
      if (titleUpper.includes('CANNING')) {
        const d = sim.decks[6]?.[0];
        if (d) tuckCardInstance(sim, aiId, d);
        for (const col of ALL_COLORS) {
          const top = getTopCard(me.board[col]);
          if (top && !cardHasIcon(top, 'factory')) {
            scoreCardInstance(sim, aiId, removeTopCardFromBoard(me, col));
          }
        }
        return { sim, bonus: 0, simulated: true };
      }
      if (titleUpper.includes('ECOLOGY') && titleUpper.includes('[10]')) {
        junkDeck(sim, 10);
        return { sim, bonus: 0, simulated: true };
      }
      if (titleUpper.includes('SUBURBIA') && titleUpper.includes('[9]')) {
        junkDeck(sim, 9);
        return { sim, bonus: 0, simulated: true };
      }
      return { sim, bonus: 0, simulated: false };
    }
    return { sim, bonus: 0, simulated: true };
  }

  if (prompt.kind === 'choose_value') {
    const val = action.selectedValue ?? prompt.options[0];
    let bonus = 0;
    if (titleUpper.includes('ACHIEVEMENT')) {
      junkStandardAchievementByAge(sim, val);
      const oppCanClaim = situ.opponents.some(
        (o) => sumBacksAge(o.scoreBacks) >= val * 5 && o.highestTopAge >= val
      );
      if (oppCanClaim) bonus += 6;
      bonus += val * 0.5;
    } else if (titleUpper.includes('DECK TO JUNK') || titleUpper.includes('SANITATION')) {
      junkDeck(sim, val as Age);
      bonus += view.deckCounts[val as Age] * 0.2;
    } else if (titleUpper.includes('CLEAR FROM ALL SCORE PILES') || titleUpper.includes('MASS MEDIA')) {
      for (const p of sim.players) {
        const matching = p.scorePile.filter((c) => c.age === val);
        for (const c of matching) removeCardFromScore(p, c.instanceId);
      }
    } else if (titleUpper.includes('FROM') && titleUpper.includes('SCORE PILE')) {
      for (const opp of sim.players) {
        if (opp.id === aiId || (sim.variant === '2v2' && opp.teamId === me.teamId)) continue;
        const matching = opp.scorePile.filter((c) => c.age === val);
        if (matching.length > 0 && (titleUpper.includes('STATISTICS') || titleUpper.includes('SERVICES') || titleUpper.includes('NEAR-FIELD'))) {
          for (const c of matching) {
            if (titleUpper.includes('STATISTICS')) {
              opp.hand.push(removeCardFromScore(opp, c.instanceId));
            } else {
              transferCard(sim, { zone: 'score', playerId: opp.id }, { zone: 'score', playerId: aiId }, c.instanceId);
            }
          }
        }
      }
    } else if (titleUpper.includes('FUSION')) {
      const target = getTopCards(me.board).find((c) => c.age === val);
      if (target) {
        scoreCardInstance(sim, aiId, removeTopCardFromBoard(me, target.color));
      }
    } else if (titleUpper.includes('HYPERSONICS')) {
      const pair = getTopCards(me.board).filter((c) => c.age === val).slice(0, 2);
      for (const c of pair) returnCardInstance(sim, removeTopCardFromBoard(me, c.color));
    } else {
      junkStandardAchievementByAge(sim, val);
    }
    return { sim, bonus, simulated: true };
  }

  if (prompt.kind === 'choose_option') {
    const optId = action.selectedOptionId ?? prompt.options[0].id;
    let bonus = 0;

    if (optId === 'decline') {
      return { sim, bonus: 0, simulated: true };
    }
    if (optId === 'junk3') {
      junkDeck(sim, 3);
      return { sim, bonus: 0, simulated: true };
    }
    if (optId === 'exchange') {
      const maxH = me.hand.length > 0 ? Math.max(...me.hand.map((c) => c.age)) : 0;
      const highHandIds = me.hand.filter((c) => c.age === maxH).map((c) => c.instanceId);
      const maxS = me.scorePile.length > 0 ? Math.max(...me.scorePile.map((c) => c.age)) : 0;
      const highScoreIds = me.scorePile.filter((c) => c.age === maxS).map((c) => c.instanceId);
      if (highHandIds.length + highScoreIds.length > 0) {
        exchangeCards(
          sim,
          { zone: 'hand', playerId: aiId },
          highHandIds,
          { zone: 'score', playerId: aiId },
          highScoreIds
        );
      }
      return { sim, bonus: 0, simulated: true };
    }
    if (optId.startsWith('target_')) {
      const oppId = optId.slice('target_'.length);
      const opp = sim.players.find((p) => p.id === oppId);
      if (opp && getTopCard(me.board.red)) {
        const oppGreen = opp.board.green.cards.pop();
        const movedRed = me.board.red.cards.pop();
        if (movedRed) opp.board.red.cards.push(movedRed);
        if (oppGreen) me.board.green.cards.push(oppGreen);
      }
      return { sim, bonus: 0, simulated: true };
    }
    if (optId.includes('::')) {
      const [oppId, ageStr] = optId.split('::');
      const age = Number(ageStr);
      const opp = sim.players.find((p) => p.id === oppId);
      const target = opp?.scorePile.find((c) => c.age === age);
      if (opp && target) {
        returnCardInstance(sim, removeCardFromScore(opp, target.instanceId));
      }
    } else if (titleUpper.includes('ENCYCLOPEDIA') && optId.startsWith('age_')) {
      const age = Number(optId.slice(4));
      const cards = me.scorePile.filter((c) => c.age === age);
      for (const c of cards) {
        meldCardInstance(sim, aiId, removeCardFromScore(me, c.instanceId));
      }
    } else if (optId.startsWith('junk_') && /^\d+$/.test(optId.slice(5))) {
      const age = Number(optId.slice(5)) as Age;
      junkStandardAchievementByAge(sim, age);
      const oppCanClaim = situ.opponents.some(
        (o) => sumBacksAge(o.scoreBacks) >= age * 5 && o.highestTopAge >= age
      );
      if (oppCanClaim) bonus += 6;
    } else if (titleUpper.includes('EVOLUTION')) {
      if (optId === 'score_8_return') {
        const d = sim.decks[8]?.[0];
        if (d) scoreCardInstance(sim, aiId, d);
        const low = [...me.scorePile].sort((a, b) => a.age - b.age)[0];
        if (low) returnCardInstance(sim, removeCardFromScore(me, low.instanceId));
      } else if (optId === 'draw_plus_1') {
        const maxS = me.scorePile.length > 0 ? Math.max(...me.scorePile.map((c) => c.age)) : 0;
        const nextAge = Math.min(11, maxS + 1) as Age;
        const d = sim.decks[nextAge]?.[0];
        if (d) me.hand.push(d);
      }
    } else if (titleUpper.includes('PUBLICATIONS')) {
      if (optId.startsWith('junk_')) {
        const sp = optId.slice(5) as keyof typeof SPECIAL_ACHIEVEMENTS;
        sim.availableSpecialAchievements = sim.availableSpecialAchievements.filter((a) => a !== sp);
        bonus += 1;
      } else if (optId.startsWith('restore_')) {
        bonus -= 1;
      }
    } else if (titleUpper.includes('OPTICS')) {
      const opp = sim.players.find((p) => p.id === optId);
      if (opp) {
        const low = [...me.scorePile].sort((a, b) => a.age - b.age)[0];
        if (low) opp.scorePile.push(removeCardFromScore(me, low.instanceId));
      }
    } else if (titleUpper.includes('CLIMATOLOGY')) {
      const ic = optId as FunctionalIcon;
      for (const opp of sim.players) {
        if (opp.id === aiId || (sim.variant === '2v2' && opp.teamId === me.teamId)) continue;
        const matches = getTopCards(opp.board).filter((c) => cardHasIcon(c, ic));
        for (const c of matches.slice(0, 2)) {
          returnCardInstance(sim, removeTopCardFromBoard(opp, c.color));
        }
        if (matches.length >= 2) bonus += 3;
      }
    }
    return { sim, bonus, simulated: true };
  }

  if (prompt.kind === 'choose_cards') {
    const selectedSet = new Set(action.selectedCardIds ?? []);
    const subset = prompt.candidates.filter((c) => selectedSet.has(c.instanceId));

    const isKeepPrompt = titleUpper.includes('TO KEEP');
    const isSelfExecutePrompt = titleUpper.includes('SELF-EXECUTE');
    const isScorePileTarget = srcLower.includes('score pile');
    const isBoardTarget = srcLower.includes('board') || srcLower.includes('top');
    const isTransferOrDemand =
      titleUpper.includes('DEMAND') || titleUpper.includes('TRANSFER') || !prompt.allowSkip;
    const isMeldPrompt = titleUpper.includes('MELD') && srcLower.includes('hand');
    const isTuckPrompt = titleUpper.includes('TUCK') && srcLower.includes('hand');
    const isScorePrompt = titleUpper.includes('SCORE') && srcLower.includes('hand');
    const isReturnPrompt = titleUpper.includes('RETURN') && srcLower.includes('hand');

    if (isSelfExecutePrompt && subset.length === 1) {
      const chosen = subset[0];
      let bonus = chosen.abilities.filter((a) => !a.isDemand).length * 4 + chosen.age * 0.5;
      if (titleUpper.includes('SATELLITES')) {
        const idx = me.hand.findIndex((h) => h.instanceId === chosen.instanceId);
        if (idx !== -1) {
          const [card] = me.hand.splice(idx, 1);
          meldCardInstance(sim, aiId, card);
        }
      }
      try {
        const fakeCol = chosen.color;
        if (!titleUpper.includes('ESCAPISM')) {
          const top = getTopCard(me.board[fakeCol]);
          if (top?.instanceId === chosen.instanceId) {
            const evalState =
              evaluateStateFn ?? ((s: GameState, pid: string) => evaluateGameStateForPlayer(s, pid, situ));
            const baseScore = evalState(baseSim, aiId);
            const after = resolveStateThroughPrompts(
              applyAction(sim, { type: 'dogma', playerId: aiId, color: fakeCol }),
              aiId,
              situ,
              1,
              { remaining: 14 },
              view,
              DEFAULT_AI_HAND_PARAMS,
              evaluateStateFn
            );
            bonus = evalState(after, aiId) - baseScore;
            return { sim: after, bonus, simulated: true };
          }
        }
      } catch {
        // Ignore non-standard sub-dogma execution
      }
      return { sim, bonus, simulated: true };
    }

    if (isKeepPrompt) {
      const keepSet = new Set(subset.map((c) => c.instanceId));
      for (const cand of prompt.candidates) {
        if (keepSet.has(cand.instanceId)) continue;
        const hIdx = me.hand.findIndex((h) => h.instanceId === cand.instanceId);
        if (hIdx !== -1) me.hand.splice(hIdx, 1);
      }
      return { sim, bonus: 0, simulated: true };
    }

    if (titleUpper.includes('COLLABORATION')) {
      for (const cand of prompt.candidates) {
        if (subset.some((s) => s.instanceId === cand.instanceId)) {
          meldCardInstance(sim, aiId, { ...cand });
        } else {
          const opp = sim.players.find((p) => p.id !== aiId && !p.eliminated);
          if (opp) meldCardInstance(sim, opp.id, { ...cand });
        }
      }
      return { sim, bonus: 0, simulated: true };
    }

    if (isMeldPrompt) {
      for (const c of subset) {
        const idx = me.hand.findIndex((h) => h.instanceId === c.instanceId);
        if (idx !== -1) {
          const [card] = me.hand.splice(idx, 1);
          meldCardInstance(sim, aiId, card);
        }
      }
      if (
        titleUpper.includes('MASONRY') &&
        me.board.red.cards.length === 3 &&
        sim.availableSpecialAchievements.includes('monument')
      ) {
        me.achievements.push({ id: 'ach_sim_mon', kind: 'special', specialId: 'monument' });
      }
      return { sim, bonus: 0, simulated: true };
    }

    if (isTuckPrompt) {
      let tuckedColor: CardColor | null = null;
      for (const c of subset) {
        const idx = me.hand.findIndex((h) => h.instanceId === c.instanceId);
        if (idx !== -1) {
          const [card] = me.hand.splice(idx, 1);
          tuckCardInstance(sim, aiId, card);
          tuckedColor = card.color;
        }
      }
      if (titleUpper.includes('FERMENTING') && subset.length === 0) {
        sim.decks[2] = [];
        for (const p of sim.players) {
          const topY = getTopCard(p.board.yellow);
          if (topY && topY.defId === 'B019') {
            p.board.yellow.cards.pop();
            if (p.board.yellow.cards.length <= 1) p.board.yellow.splay = 'none';
          }
        }
      }
      if (
        titleUpper.includes('CODE OF LAWS') &&
        tuckedColor &&
        canSplayStack(me.board[tuckedColor], 'left')
      ) {
        const evalState =
          evaluateStateFn ?? ((s: GameState, pid: string) => evaluateGameStateForPlayer(s, pid, situ));
        const withoutSplay = evalState(sim, aiId);
        const simSplay = cloneGameState(sim);
        splayPlayerColor(simSplay, aiId, tuckedColor, 'left', 'Dogma');
        const withSplay = evalState(simSplay, aiId);
        if (withSplay > withoutSplay) {
          return { sim: simSplay, bonus: 0, simulated: true };
        }
      }
      return { sim, bonus: 0, simulated: true };
    }

    if (isScorePrompt) {
      for (const c of subset) {
        const idx = me.hand.findIndex((h) => h.instanceId === c.instanceId);
        if (idx !== -1) {
          const [card] = me.hand.splice(idx, 1);
          scoreCardInstance(sim, aiId, card);
        }
      }
      return { sim, bonus: 0, simulated: true };
    }

    if (isReturnPrompt) {
      for (const c of subset) {
        const idx = me.hand.findIndex((h) => h.instanceId === c.instanceId);
        if (idx !== -1) {
          const [card] = me.hand.splice(idx, 1);
          returnCardInstance(sim, card);
        }
      }
      if (subset.length > 0) {
        if (titleUpper.includes('AGRICULTURE')) {
          const targetAge = Math.min(11, subset[0].age + 1) as Age;
          const d = sim.decks[targetAge]?.[0];
          if (d) me.scorePile.push(d);
        } else if (titleUpper.includes('POTTERY')) {
          const targetAge = Math.min(11, subset.length) as Age;
          const d = sim.decks[targetAge]?.[0];
          if (d) me.scorePile.push(d);
        } else if (titleUpper.includes('CURRENCY')) {
          const distinct = new Set(subset.map((c) => c.age)).size;
          for (let k = 0; k < distinct; k++) {
            const d = sim.decks[2]?.[k];
            if (d) me.scorePile.push(d);
          }
        } else if (titleUpper.includes('MATHEMATICS')) {
          const targetAge = Math.min(11, subset[0].age + 1) as Age;
          const d = sim.decks[targetAge]?.[0];
          if (d) meldCardInstance(sim, aiId, d);
        } else if (titleUpper.includes('TOOLS')) {
          if (subset.length === 3) {
            const d = sim.decks[3]?.[0];
            if (d) meldCardInstance(sim, aiId, d);
          } else if (subset.length === 1 && subset[0].age === 3) {
            for (let k = 0; k < 3; k++) {
              const d = sim.decks[1]?.[k];
              if (d) me.hand.push(d);
            }
          }
        } else if (titleUpper.includes('ANTIBIOTICS')) {
          const distinct = new Set(subset.map((c) => c.age)).size;
          for (let k = 0; k < distinct * 2; k++) {
            const d = sim.decks[8]?.[k];
            if (d) me.hand.push(d);
          }
        } else if (titleUpper.includes('QUANTUM THEORY')) {
          const d = sim.decks[11]?.[0];
          if (d) me.scorePile.push(d);
        } else if (titleUpper.includes('ECOLOGY')) {
          const d = sim.decks[10]?.[0];
          if (d) me.scorePile.push(d);
          const d2 = sim.decks[10]?.[1];
          if (d2) me.hand.push(d2);
        }
      }
      return { sim, bonus: 0, simulated: true };
    }

    if (isScorePileTarget) {
      for (const c of subset) {
        const idx = me.scorePile.findIndex((s) => s.instanceId === c.instanceId);
        if (idx !== -1) me.scorePile.splice(idx, 1);
      }
      if (titleUpper.includes('PRINTING PRESS') && subset.length > 0) {
        const topAge = getHighestTopCardAge(me.board);
        const d = sim.decks[Math.min(11, topAge + 2) as Age]?.[0];
        if (d) me.hand.push(d);
      } else if (titleUpper.includes('CHEMISTRY') && subset.length > 0) {
        const topAge = getHighestTopCardAge(me.board);
        const d = sim.decks[Math.min(11, topAge + 1) as Age]?.[0];
        if (d) me.scorePile.push(d);
      }
      return { sim, bonus: 0, simulated: true };
    }

    if (isBoardTarget) {
      for (const c of subset) {
        if (titleUpper.includes('SERVICES') && (titleUpper.includes('TAKE A TOP CARD') || titleUpper.includes('MELD'))) {
          for (const opp of sim.players) {
            if (opp.id === aiId || (sim.variant === '2v2' && opp.teamId === me.teamId)) continue;
            const top = getTopCard(opp.board[c.color]);
            if (top && top.instanceId === c.instanceId) {
              meldCardInstance(sim, aiId, removeTopCardFromBoard(opp, c.color));
            }
          }
        } else if (titleUpper.includes('BIOENGINEERING') || titleUpper.includes('FISSION')) {
          for (const p of sim.players) {
            const top = getTopCard(p.board[c.color]);
            if (top && top.instanceId === c.instanceId) {
              const removed = removeTopCardFromBoard(p, c.color);
              if (titleUpper.includes('BIOENGINEERING')) {
                scoreCardInstance(sim, aiId, removed);
              }
              break;
            }
          }
        } else if (titleUpper.includes('SOCIALISM')) {
          const top = getTopCard(me.board[c.color]);
          if (top && top.instanceId === c.instanceId) {
            const card = removeTopCardFromBoard(me, c.color);
            me.board[card.color].cards.unshift(card);
          }
        } else {
          const bIdx = me.board[c.color].cards.findIndex((b) => b.instanceId === c.instanceId);
          if (bIdx !== -1) {
            const [removed] = me.board[c.color].cards.splice(bIdx, 1);
            if (me.board[c.color].cards.length <= 1) me.board[c.color].splay = 'none';
            if ((titleUpper.includes('DEMAND') || titleUpper.includes('TRANSFER')) && view.currentPlayerId !== aiId) {
              const requester = sim.players.find((p) => p.id === view.currentPlayerId);
              if (requester && removed) {
                if (titleUpper.includes('SCORE')) requester.scorePile.push(removed);
                else if (titleUpper.includes('BOARD')) meldCardInstance(sim, requester.id, removed);
                else requester.hand.push(removed);
              }
            }
          }
        }
      }
      return { sim, bonus: 0, simulated: true };
    }

    if (isTransferOrDemand) {
      const requester =
        view.currentPlayerId !== aiId
          ? sim.players.find((p) => p.id === view.currentPlayerId)
          : undefined;
      for (const c of subset) {
        const hIdx = me.hand.findIndex((h) => h.instanceId === c.instanceId);
        if (hIdx !== -1) {
          const [removed] = me.hand.splice(hIdx, 1);
          if (requester && removed && (titleUpper.includes('DEMAND') || titleUpper.includes('TRANSFER'))) {
            if (titleUpper.includes('SCORE')) requester.scorePile.push(removed);
            else requester.hand.push(removed);
          }
          continue;
        }
        for (const col of ALL_COLORS) {
          const bIdx = me.board[col].cards.findIndex((b) => b.instanceId === c.instanceId);
          if (bIdx !== -1) {
            const [removed] = me.board[col].cards.splice(bIdx, 1);
            if (me.board[col].cards.length <= 1) me.board[col].splay = 'none';
            if (requester && removed && (titleUpper.includes('DEMAND') || titleUpper.includes('TRANSFER'))) {
              if (titleUpper.includes('SCORE')) requester.scorePile.push(removed);
              else if (titleUpper.includes('MELD')) meldCardInstance(sim, requester.id, removed);
              else requester.hand.push(removed);
            }
            break;
          }
        }
      }
      return { sim, bonus: 0, simulated: true };
    }
  }

  return { sim, bonus: 0, simulated: false };
}

export function handleDirectPromptDecision(view: PlayerView, situ: SituationAssessment): TurnAction {
  const aiId = view.viewerId;
  const prompt = view.pendingPromptForViewer!;

  if (prompt.kind === 'setup_meld') {
    const sorted = [...prompt.options].sort((a, b) => scoreCardForSetup(b) - scoreCardForSetup(a));
    return { type: 'setup_meld', playerId: aiId, cardInstanceId: sorted[0].instanceId };
  }

  if (prompt.kind === 'choose_color') {
    const simBase = buildFairPlaySimState(view, 0);
    const baseline = evaluateGameStateForPlayer(simBase, aiId, situ);
    const sameColorCounts = Object.fromEntries(
      ALL_COLORS.map((col) => [col, view.viewer.hand.filter((c) => c.color === col).length])
    ) as Record<CardColor, number>;

    if (prompt.splayDirection && prompt.splayDirection !== 'none') {
      const targetDir = prompt.splayDirection;
      let bestColor: CardColor | null = null;
      let bestGain = -Infinity;
      for (const color of prompt.options) {
        const stack = view.viewer.board[color];
        if (!canSplayStack(stack, targetDir)) continue;
        const { sim } = simulateDirectPromptState(
          simBase,
          view,
          prompt,
          { type: 'answer_prompt', playerId: aiId, promptId: prompt.id, selectedColor: color },
          situ
        );
        const simDelta = evaluateGameStateForPlayer(sim, aiId, situ) - baseline;
        const splayScore = computeSplayGainScore(
          stack.cards,
          stack.splay,
          targetDir,
          situ,
          sameColorCounts[color]
        );
        const combined = simDelta * 0.6 + splayScore * 0.4;
        if (combined > bestGain) {
          bestGain = combined;
          bestColor = color;
        }
      }
      if (bestGain <= 0 && prompt.allowSkip) {
        return { type: 'answer_prompt', playerId: aiId, promptId: prompt.id };
      }
      const chosen = bestColor ?? prompt.options[0];
      return { type: 'answer_prompt', playerId: aiId, promptId: prompt.id, selectedColor: chosen };
    }

    let bestColor: CardColor | null = null;
    let bestGain = -Infinity;
    for (const color of prompt.options) {
      const { sim } = simulateDirectPromptState(
        simBase,
        view,
        prompt,
        { type: 'answer_prompt', playerId: aiId, promptId: prompt.id, selectedColor: color },
        situ
      );
      const gain = evaluateGameStateForPlayer(sim, aiId, situ) - baseline;
      if (gain > bestGain) {
        bestGain = gain;
        bestColor = color;
      }
    }
    if (bestGain <= 0 && prompt.allowSkip) {
      return { type: 'answer_prompt', playerId: aiId, promptId: prompt.id };
    }
    return {
      type: 'answer_prompt',
      playerId: aiId,
      promptId: prompt.id,
      selectedColor: bestColor ?? prompt.options[0],
    };
  }

  if (prompt.kind === 'choose_yes_no') {
    const fullText = getPromptFullText(prompt);
    const colorMatch = /\bsplay\s+(red|yellow|green|blue|purple)\s+(left|right|up|aslant|askew)\b/i.exec(
      fullText
    );
    if (colorMatch) {
      const col = colorMatch[1].toLowerCase() as CardColor;
      const dir = parseSplayDirectionFromText(fullText) ?? 'left';
      const stack = view.viewer.board[col];
      const sameColorInHand = view.viewer.hand.filter((c) => c.color === col).length;
      const confirm = computeSplayGainScore(stack.cards, stack.splay, dir, situ, sameColorInHand) > 0;
      return { type: 'answer_prompt', playerId: aiId, promptId: prompt.id, confirmed: confirm };
    }

    const titleUpper = fullText.toUpperCase();
    const simBase = buildFairPlaySimState(view, 0);
    const baseScore = evaluateGameStateForPlayer(simBase, aiId, situ);
    const { sim: simYes, simulated } = simulateDirectPromptState(
      simBase,
      view,
      prompt,
      { type: 'answer_prompt', playerId: aiId, promptId: prompt.id, confirmed: true },
      situ
    );

    let confirm = !titleUpper.includes('DECLINE');
    if (simulated) {
      confirm = evaluateGameStateForPlayer(simYes, aiId, situ) >= baseScore;
    }
    return { type: 'answer_prompt', playerId: aiId, promptId: prompt.id, confirmed: confirm };
  }

  if (prompt.kind === 'choose_value') {
    let bestVal = prompt.options[0];
    let bestDelta = -Infinity;
    const baseSim = buildFairPlaySimState(view, 0);
    const baseScore = evaluateGameStateForPlayer(baseSim, aiId, situ);

    for (const val of prompt.options) {
      const { sim, bonus } = simulateDirectPromptState(
        baseSim,
        view,
        prompt,
        { type: 'answer_prompt', playerId: aiId, promptId: prompt.id, selectedValue: val },
        situ
      );
      const delta = evaluateGameStateForPlayer(sim, aiId, situ) - baseScore + bonus;
      if (delta > bestDelta) {
        bestDelta = delta;
        bestVal = val;
      }
    }
    return { type: 'answer_prompt', playerId: aiId, promptId: prompt.id, selectedValue: bestVal };
  }

  if (prompt.kind === 'choose_option') {
    const simBase = buildFairPlaySimState(view, 0);
    const baseScore = evaluateGameStateForPlayer(simBase, aiId, situ);

    const exchangeOpt = prompt.options.find((o) => o.id === 'exchange');
    if (exchangeOpt) {
      const maxH = view.viewer.hand.length > 0 ? Math.max(...view.viewer.hand.map((c) => c.age)) : 0;
      const sumH = view.viewer.hand.filter((c) => c.age === maxH).reduce((s, c) => s + c.age, 0);
      const maxS = view.viewer.scorePile.length > 0 ? Math.max(...view.viewer.scorePile.map((c) => c.age)) : 0;
      const sumS = view.viewer.scorePile.filter((c) => c.age === maxS).reduce((s, c) => s + c.age, 0);

      if (sumH > sumS || (maxS > maxH + 1 && situ.weights.isExtremelyLosing)) {
        return { type: 'answer_prompt', playerId: aiId, promptId: prompt.id, selectedOptionId: 'exchange' };
      }
      if (view.deckCounts[3] > 0) {
        return { type: 'answer_prompt', playerId: aiId, promptId: prompt.id, selectedOptionId: 'junk3' };
      }
      return {
        type: 'answer_prompt',
        playerId: aiId,
        promptId: prompt.id,
        selectedOptionId: prompt.options.find((o) => o.id === 'decline')?.id ?? prompt.options[0].id,
      };
    }

    const targets = prompt.options.filter((o) => o.id.startsWith('target_'));
    if (targets.length > 0) {
      let bestId = prompt.options.find((o) => o.id === 'decline')?.id ?? prompt.options[0].id;
      let bestDelta = 0;
      for (const opt of targets) {
        const { sim } = simulateDirectPromptState(
          simBase,
          view,
          prompt,
          { type: 'answer_prompt', playerId: aiId, promptId: prompt.id, selectedOptionId: opt.id },
          situ
        );
        const delta = evaluateGameStateForPlayer(sim, aiId, situ) - baseScore;
        if (delta > bestDelta) {
          bestDelta = delta;
          bestId = opt.id;
        }
      }
      return { type: 'answer_prompt', playerId: aiId, promptId: prompt.id, selectedOptionId: bestId };
    }

    let bestOptId = prompt.options[0].id;
    let bestOptScore = -Infinity;
    for (const opt of prompt.options) {
      const { sim, bonus } = simulateDirectPromptState(
        simBase,
        view,
        prompt,
        { type: 'answer_prompt', playerId: aiId, promptId: prompt.id, selectedOptionId: opt.id },
        situ
      );
      const delta = evaluateGameStateForPlayer(sim, aiId, situ) - baseScore + bonus;
      if (delta > bestOptScore) {
        bestOptScore = delta;
        bestOptId = opt.id;
      }
    }

    return {
      type: 'answer_prompt',
      playerId: aiId,
      promptId: prompt.id,
      selectedOptionId: bestOptId,
    };
  }

  if (prompt.kind === 'choose_cards') {
    const baseSim = buildFairPlaySimState(view, 0);
    const baseScore = evaluateGameStateForPlayer(baseSim, aiId, situ);
    const subsets = buildChooseCardsSubsets(baseSim, prompt, situ, 8);

    let bestSubset = subsets[0] ?? (prompt.allowSkip ? [] : prompt.candidates.slice(0, prompt.min));
    let bestDelta = -Infinity;

    for (const subset of subsets) {
      const candAction: TurnAction = {
        type: 'answer_prompt',
        playerId: aiId,
        promptId: prompt.id,
        selectedCardIds: subset.map((c) => c.instanceId),
      };
      const { sim, bonus } = simulateDirectPromptState(baseSim, view, prompt, candAction, situ);
      const delta = evaluateGameStateForPlayer(sim, aiId, situ) - baseScore + bonus;
      if (delta > bestDelta) {
        bestDelta = delta;
        bestSubset = subset;
      }
    }

    return {
      type: 'answer_prompt',
      playerId: aiId,
      promptId: prompt.id,
      selectedCardIds: bestSubset.map((c) => c.instanceId),
    };
  }

  if (prompt.kind === 'choose_order') {
    const ordered = [...prompt.cards].sort((a, b) => {
      const valA = a.age * 3 + scoreCardIconsForPlayer(a, situ);
      const valB = b.age * 3 + scoreCardIconsForPlayer(b, situ);
      return valA - valB;
    });
    return {
      type: 'answer_prompt',
      playerId: aiId,
      promptId: prompt.id,
      orderedCardIds: ordered.map((c) => c.instanceId),
    };
  }

  return { type: 'draw', playerId: aiId };
}

/**
 * Guarantees every prompt answer strictly satisfies exact legal UI/engine bounds
 * (never selects out-of-range counts, duplicates, or non-candidate options).
 */
export function sanitizePromptAction(view: PlayerView, action: TurnAction): TurnAction {
  const prompt = view.pendingPromptForViewer;
  if (!prompt) return action;
  const aiId = view.viewerId;

  if (prompt.kind === 'setup_meld') {
    const valid =
      action.type === 'setup_meld' &&
      prompt.options.some((o) => o.instanceId === action.cardInstanceId);
    if (valid) return action;
    return { type: 'setup_meld', playerId: aiId, cardInstanceId: prompt.options[0].instanceId };
  }

  if (action.type !== 'answer_prompt' || action.promptId !== prompt.id) {
    return sanitizePromptAction(view, {
      type: 'answer_prompt',
      playerId: aiId,
      promptId: prompt.id,
    });
  }

  if (prompt.kind === 'choose_cards') {
    const candidateIds = new Set(prompt.candidates.map((c) => c.instanceId));
    const unique = Array.from(new Set((action.selectedCardIds ?? []).filter((id) => candidateIds.has(id))));
    const isSkip = Boolean(prompt.allowSkip && unique.length === 0);
    if (isSkip || (unique.length >= prompt.min && unique.length <= prompt.max)) {
      return { ...action, selectedCardIds: unique };
    }
    const fallback = prompt.allowSkip ? [] : prompt.candidates.slice(0, prompt.min).map((c) => c.instanceId);
    return { ...action, selectedCardIds: fallback };
  }

  if (prompt.kind === 'choose_color') {
    if (action.selectedColor && prompt.options.includes(action.selectedColor)) {
      return action;
    }
    if (!action.selectedColor && prompt.allowSkip) {
      return action;
    }
    return { ...action, selectedColor: prompt.options[0] };
  }

  if (prompt.kind === 'choose_value') {
    if (action.selectedValue && prompt.options.includes(action.selectedValue)) {
      return action;
    }
    return { ...action, selectedValue: prompt.options[0] };
  }

  if (prompt.kind === 'choose_option') {
    if (action.selectedOptionId && prompt.options.some((o) => o.id === action.selectedOptionId)) {
      return action;
    }
    return { ...action, selectedOptionId: prompt.options[0].id };
  }

  if (prompt.kind === 'choose_order') {
    const expected = new Set(prompt.cards.map((c) => c.instanceId));
    const provided = action.orderedCardIds ?? [];
    if (provided.length === expected.size && provided.every((id) => expected.has(id))) {
      return action;
    }
    return { ...action, orderedCardIds: prompt.cards.map((c) => c.instanceId) };
  }

  return {
    type: 'answer_prompt',
    playerId: aiId,
    promptId: prompt.id,
    confirmed: Boolean(action.confirmed),
  };
}

export function formatCandidateLabel(view: PlayerView, cand: TurnAction, drawAgeTarget: number): string {
  switch (cand.type) {
    case 'achieve':
      return `Achieve [${cand.age}]`;
    case 'dogma': {
      const top = getTopCard(view.viewer.board[cand.color]);
      return `Dogma ${cand.color.toUpperCase()} (${top?.name ?? 'card'})`;
    }
    case 'meld': {
      const card = view.viewer.hand.find((c) => c.instanceId === cand.cardInstanceId);
      return `Meld ${card ? `${card.name} [${card.age}]` : 'card'}`;
    }
    case 'draw':
      return `Draw [${drawAgeTarget}]`;
    default:
      return cand.type;
  }
}

/**
 * Fair, non-cheating AI decision engine.
 * Type signature strictly accepts ONLY `PlayerView` (never `GameState`),
 * enumerates ONLY human-legal actions via `getLegalTurnOptions`, and scores
 * EVERY candidate move (Achieve, Dogma, Meld, Draw) by simulating the actual
 * change to the game board.
 */
export function chooseAIAction(
  view: PlayerView,
  traceOut?: AIDecisionTrace,
  handParams: AIHandParams = DEFAULT_AI_HAND_PARAMS,
  simOptions?: { fastWarmstart?: boolean }
): TurnAction {
  const aiId = view.viewerId;
  const situ = assessSituation(view);
  const fastWarmstart = Boolean(simOptions?.fastWarmstart);

  if (view.pendingPromptForViewer) {
    const chosenPromptAction = sanitizePromptAction(view, handleDirectPromptDecision(view, situ));
    if (traceOut) {
      let answerDesc = 'Answered prompt';
      if (chosenPromptAction.type === 'setup_meld') {
        const c = view.viewer.hand.find((x) => x.instanceId === chosenPromptAction.cardInstanceId);
        answerDesc = `Starting meld: ${c ? `${c.name} [${c.age}]` : chosenPromptAction.cardInstanceId}`;
      } else if (chosenPromptAction.type === 'answer_prompt') {
        if (typeof chosenPromptAction.confirmed === 'boolean') {
          answerDesc = chosenPromptAction.confirmed ? 'Confirmed (Yes)' : 'Declined (No)';
        } else if (chosenPromptAction.selectedColor) {
          answerDesc = `Selected color: ${chosenPromptAction.selectedColor}`;
        } else if (chosenPromptAction.selectedValue) {
          answerDesc = `Selected value: [${chosenPromptAction.selectedValue}]`;
        } else if (chosenPromptAction.selectedOptionId) {
          answerDesc = `Selected option: ${chosenPromptAction.selectedOptionId}`;
        } else if (chosenPromptAction.selectedCardIds) {
          answerDesc = `Selected ${chosenPromptAction.selectedCardIds.length} card(s)`;
        } else if (chosenPromptAction.orderedCardIds) {
          answerDesc = `Ordered ${chosenPromptAction.orderedCardIds.length} card(s)`;
        }
      }
      traceOut.id = `ai_trace_${view.turnNumber}_${Date.now()}`;
      traceOut.turn = view.turnNumber;
      traceOut.actorId = aiId;
      traceOut.actorName = view.viewer.name;
      traceOut.actionLabel = view.pendingPromptForViewer.title;
      traceOut.situationSummary = `Score ${situ.myScore} · Top [${view.viewer.highestTopAge}] · Hand ${view.viewer.hand.length}`;
      traceOut.chosenLabel = answerDesc;
      traceOut.candidates = [];
    }
    return chosenPromptAction;
  }

  const simSamples = fastWarmstart
    ? [buildFairPlaySimState(view, 0)]
    : [0, 1].map((s) => buildFairPlaySimState(view, s));
  const simBase = simSamples[0];
  const legal = getLegalTurnOptions(simBase, aiId);

  const aiIdx = simBase.players.findIndex((p) => p.id === aiId);
  const aiPlayerBase = simBase.players[aiIdx];
  let nextOppIdx = (aiIdx + 1) % simBase.players.length;
  while (
    nextOppIdx !== aiIdx &&
    (simBase.players[nextOppIdx].eliminated ||
      (simBase.variant === '2v2' && simBase.players[nextOppIdx].teamId === aiPlayerBase.teamId))
  ) {
    nextOppIdx = (nextOppIdx + 1) % simBase.players.length;
  }
  const cachedOppSitu =
    !fastWarmstart && nextOppIdx !== aiIdx && !simBase.players[nextOppIdx].eliminated
      ? {
          oppId: simBase.players[nextOppIdx].id,
          situ: assessSituation(projectPlayerView(simBase, simBase.players[nextOppIdx].id)),
        }
      : undefined;

  const candidates: TurnAction[] = [];
  for (const age of legal.achievableAges) {
    candidates.push({ type: 'achieve', playerId: aiId, age });
  }
  for (const color of legal.dogmaColors) {
    candidates.push({ type: 'dogma', playerId: aiId, color });
  }
  for (const cardInstanceId of legal.meldableCardIds) {
    candidates.push({ type: 'meld', playerId: aiId, cardInstanceId });
  }
  if (legal.canDraw) {
    candidates.push({ type: 'draw', playerId: aiId });
  }

  let bestAction: TurnAction = { type: 'draw', playerId: aiId };
  let bestDelta = -Infinity;
  const candidateScores: Array<{
    cand: TurnAction;
    label: string;
    score: number;
    breakdown?: AIDecisionFactorScore[];
  }> = [];

  for (const cand of candidates) {
    const sampleCount = !fastWarmstart && (cand.type === 'dogma' || cand.type === 'draw') ? 2 : 1;
    const rawBreakdown: Record<string, number> | undefined = traceOut ? {} : undefined;
    let delta = simulateActionDelta(
      view,
      cand,
      situ,
      sampleCount,
      simSamples,
      !fastWarmstart,
      cachedOppSitu,
      rawBreakdown,
      handParams
    );
    if (delta === null) continue;

    // Slight tiebreak preference for higher-age achievements or immediate Dogma unlock on meld
    if (cand.type === 'achieve') {
      const tb = cand.age * 0.05;
      delta += tb;
      if (rawBreakdown) rawBreakdown['Achieve Age Tiebreak'] = tb;
    } else if (cand.type === 'meld') {
      const card = view.viewer.hand.find((c) => c.instanceId === cand.cardInstanceId);
      if (
        card &&
        card.abilities.length > 0 &&
        view.actionsRemaining >= 2 &&
        (!fastWarmstart || legal.meldableCardIds.length <= 4 || card.age >= view.viewer.highestTopAge - 1)
      ) {
        const followUpSim = applyAction(simBase, cand);
        if (followUpSim.phase === 'playing') {
          const followUp = evaluateDogmaAction(view, card, situ, 1, false, [followUpSim]);
          if (followUp > 4) {
            const synergy = Math.min(10, followUp * 0.25);
            delta += synergy;
            if (rawBreakdown) rawBreakdown['Follow-up Dogma Synergy'] = synergy;
          }
        }
      }
    }

    if (traceOut && rawBreakdown) {
      const breakdownList: AIDecisionFactorScore[] = Object.entries(rawBreakdown)
        .filter(([, val]) => Math.abs(val) >= 0.01)
        .map(([factor, val]) => ({ factor, delta: Math.round(val * 100) / 100 }))
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

      candidateScores.push({
        cand,
        label: formatCandidateLabel(view, cand, legal.drawTargetAge ?? Math.max(1, view.viewer.highestTopAge)),
        score: Math.round(delta * 100) / 100,
        breakdown: breakdownList,
      });
    }

    if (delta > bestDelta) {
      bestDelta = delta;
      bestAction = cand;
    }
  }

  const populateTrace = (finalAction: TurnAction) => {
    if (!traceOut) return;
    const drawTarget = legal.drawTargetAge ?? Math.max(1, view.viewer.highestTopAge);
    const chosenLabel = formatCandidateLabel(view, finalAction, drawTarget);
    const sortedTraces: AIDecisionCandidateTrace[] = candidateScores
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((entry) => ({
        label: entry.label,
        actionType: entry.cand.type,
        score: entry.score,
        selected: entry.cand === finalAction,
        breakdown: entry.breakdown,
      }));
    traceOut.id = `ai_trace_${view.turnNumber}_${view.actionsRemaining}_${Date.now()}`;
    traceOut.turn = view.turnNumber;
    traceOut.actorId = aiId;
    traceOut.actorName = view.viewer.name;
    traceOut.actionLabel = `Action (${view.actionsRemaining} left)`;
    traceOut.situationSummary = `Score ${situ.myScore} (opp ${situ.maxOppScore}) · Ach ${view.viewer.achievements.length}/${view.achievementTarget} · Top [${view.viewer.highestTopAge}] · Hand ${view.viewer.hand.length}`;
    traceOut.chosenLabel = chosenLabel;
    traceOut.candidates = sortedTraces;
  };

  // Final human-legality verification against the engine
  try {
    applyAction(simBase, bestAction);
    populateTrace(bestAction);
    return bestAction;
  } catch {
    let fallback: TurnAction = { type: 'draw', playerId: aiId };
    if (legal.achievableAges.length > 0) {
      fallback = { type: 'achieve', playerId: aiId, age: legal.achievableAges[0] };
    } else if (legal.meldableCardIds.length > 0) {
      fallback = { type: 'meld', playerId: aiId, cardInstanceId: legal.meldableCardIds[0] };
    }
    populateTrace(fallback);
    return fallback;
  }
}

export function getSpecialAchievementProgressLabel(
  view: PlayerView,
  id: keyof typeof SPECIAL_ACHIEVEMENTS
): string {
  const icons = view.viewer.visibleIcons;
  switch (id) {
    case 'empire': {
      const met = ['tower', 'coin', 'leaf', 'lightbulb', 'factory', 'clock'].filter(
        (ic) => icons[ic as keyof typeof icons] >= 3
      ).length;
      return `${met}/6 icons >= 3`;
    }
    case 'world':
      return `${icons.clock}/12 Clock`;
    case 'monument': {
      const demandTops = countDemandTopCards(view.viewer.board);
      return `${demandTops}/4 Demand tops`;
    }
    case 'wonder': {
      const splayed = countWonderEligibleColors(view.viewer.board);
      return `${splayed}/5 R/U/A`;
    }
    case 'universe': {
      const high = ALL_COLORS.filter((c) => {
        const top = getTopCard(view.viewer.board[c]);
        return top !== null && top.age >= 8;
      }).length;
      return `${high}/5 tops >= 8`;
    }
  }
}
