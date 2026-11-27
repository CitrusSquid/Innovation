import { ALL_AGES, ALL_COLORS, EMPIRE_ICONS, SPECIAL_ACHIEVEMENTS } from './constants';
import {
  countDemandTopCards,
  countWonderEligibleColors,
  getHighestTopCardAge,
  getTopCards,
  getVisibleIconCounts,
  normalizeStackSplay,
} from './splay';
import type {
  ActionLogEntry,
  Age,
  CardColor,
  CardInstance,
  ClaimedAchievement,
  DogmaExecutionContext,
  GameState,
  PendingPrompt,
  PlayerBoard,
  PlayerState,
  SplayDirection,
  SpecialAchievementId,
} from './types';

function cloneBoardFast(board: PlayerBoard): PlayerBoard {
  return {
    red: { color: 'red', splay: board.red.splay, cards: [...board.red.cards] },
    yellow: { color: 'yellow', splay: board.yellow.splay, cards: [...board.yellow.cards] },
    green: { color: 'green', splay: board.green.splay, cards: [...board.green.cards] },
    blue: { color: 'blue', splay: board.blue.splay, cards: [...board.blue.cards] },
    purple: { color: 'purple', splay: board.purple.splay, cards: [...board.purple.cards] },
  };
}

function clonePromptFast(prompt: PendingPrompt): PendingPrompt {
  switch (prompt.kind) {
    case 'setup_meld':
      return { ...prompt, options: [...prompt.options] };
    case 'choose_cards':
      return { ...prompt, candidates: [...prompt.candidates] };
    case 'choose_color':
      return { ...prompt, options: [...prompt.options] };
    case 'choose_yes_no':
      return { ...prompt };
    case 'choose_value':
      return { ...prompt, options: [...prompt.options] };
    case 'choose_option':
      return { ...prompt, options: prompt.options.map((o) => ({ ...o })) };
    case 'choose_order':
      return { ...prompt, cards: [...prompt.cards] };
  }
}

export function cloneGameState(state: GameState): GameState {
  const decks = {} as Record<Age, CardInstance[]>;
  for (const age of ALL_AGES) {
    decks[age] = [...state.decks[age]];
  }

  let activeDogma: DogmaExecutionContext | null = null;
  if (state.activeDogma) {
    const ad = state.activeDogma;
    activeDogma = {
      ...ad,
      lockedAbilities: [...ad.lockedAbilities],
      eligibleToShareIds: [...ad.eligibleToShareIds],
      vulnerableToDemandIds: [...ad.vulnerableToDemandIds],
      ...(ad.teammateIds ? { teammateIds: [...ad.teammateIds] } : {}),
      steps: ad.steps.map((s) => ({ ...s })),
      ...(ad.demandTransferredByAbility
        ? { demandTransferredByAbility: { ...ad.demandTransferredByAbility } }
        : {}),
      ...(ad.demandReturnedByAbility
        ? { demandReturnedByAbility: { ...ad.demandReturnedByAbility } }
        : {}),
      ...(ad.returnedByPlayer ? { returnedByPlayer: { ...ad.returnedByPlayer } } : {}),
      subState: ad.subState
        ? {
            ...ad.subState,
            ...(ad.subState.chosenColors ? { chosenColors: [...ad.subState.chosenColors] } : {}),
            ...(ad.subState.tempCards ? { tempCards: [...ad.subState.tempCards] } : {}),
          }
        : ad.subState,
    };
  }

  if (state.fastSimulation) {
    return {
      ...state,
      players: state.players.map((p) => ({
        ...p,
        hand: [...p.hand],
        board: cloneBoardFast(p.board),
        scorePile: [...p.scorePile],
        achievements: p.achievements.length > 0 ? p.achievements.map((a) => ({ ...a })) : [],
      })),
      decks,
      standardAchievements: [...state.standardAchievements],
      availableSpecialAchievements: [...state.availableSpecialAchievements],
      junk: state.junk.length > 0 ? [...state.junk] : [],
      revealedCardIds: state.revealedCardIds.length > 0 ? [...state.revealedCardIds] : [],
      setupSelections: state.phase === 'setup' ? { ...state.setupSelections } : state.setupSelections,
      pendingPrompts: state.pendingPrompts.length > 0 ? state.pendingPrompts.map(clonePromptFast) : [],
      activeDogma,
      actionStats: { ...state.actionStats },
      ...(state.junkedStandardAges ? { junkedStandardAges: [...state.junkedStandardAges] } : {}),
      ...(state.repeatDrawEvents ? { repeatDrawEvents: [...state.repeatDrawEvents] } : {}),
      log: state.log,
      victory: state.victory
        ? {
            ...state.victory,
            winnerPlayerIds: [...state.victory.winnerPlayerIds],
            finalScores: { ...state.victory.finalScores },
            finalAchievements: { ...state.victory.finalAchievements },
          }
        : null,
    };
  }

  return {
    ...state,
    players: state.players.map((p) => ({
      ...p,
      hand: [...p.hand],
      board: cloneBoardFast(p.board),
      scorePile: [...p.scorePile],
      achievements: p.achievements.map((a) => ({ ...a })),
    })),
    decks,
    standardAchievements: [...state.standardAchievements],
    availableSpecialAchievements: [...state.availableSpecialAchievements],
    junk: [...state.junk],
    revealedCardIds: [...state.revealedCardIds],
    setupSelections: { ...state.setupSelections },
    pendingPrompts: state.pendingPrompts.map(clonePromptFast),
    activeDogma,
    actionStats: { ...state.actionStats },
    ...(state.lastTurnActionsByPlayer
      ? {
          lastTurnActionsByPlayer: Object.fromEntries(
            Object.entries(state.lastTurnActionsByPlayer).map(([pid, list]) => [
              pid,
              list.map((item) => ({ ...item })),
            ])
          ),
        }
      : {}),
    ...(state.junkedStandardAges ? { junkedStandardAges: [...state.junkedStandardAges] } : {}),
    ...(state.repeatDrawEvents ? { repeatDrawEvents: [...state.repeatDrawEvents] } : {}),
    ...(state.highestAgeReachedByPlayer
      ? { highestAgeReachedByPlayer: { ...state.highestAgeReachedByPlayer } }
      : {}),
    ...(state.chronologyEvents
      ? {
          chronologyEvents: state.chronologyEvents.map((ev) => ({
            ...ev,
            scoresByPlayer: { ...ev.scoresByPlayer },
            achievementsByPlayer: { ...ev.achievementsByPlayer },
          })),
        }
      : {}),
    log: [...state.log],
    victory: state.victory
      ? {
          ...state.victory,
          winnerPlayerIds: [...state.victory.winnerPlayerIds],
          finalScores: { ...state.victory.finalScores },
          finalAchievements: { ...state.victory.finalAchievements },
        }
      : null,
  };
}

const FAST_EMPTY_LOG_ENTRY: ActionLogEntry = {
  id: 'fast_log',
  turn: 0,
  actorId: 'system',
  actorName: 'System',
  message: '',
};

export function appendLog(
  state: GameState,
  actorId: string,
  message: string,
  actionTag?: string,
  parentLogId?: string
): ActionLogEntry {
  if (state.fastSimulation) {
    return FAST_EMPTY_LOG_ENTRY;
  }
  const actor = state.players.find((p) => p.id === actorId);
  const currentTotal = state.actionsTotalThisTurn ?? 2;
  const computedActionNum =
    state.phase === 'setup'
      ? 'Setup'
      : state.actionsRemaining > 0
      ? `Action ${currentTotal - state.actionsRemaining + 1}`
      : undefined;

  const entry: ActionLogEntry = {
    id: `log_${state.turnNumber}_${state.log.length + 1}`,
    turn: state.turnNumber,
    actorId,
    actorName: actor ? actor.name : 'System',
    actionTag: actionTag ?? computedActionNum,
    message,
    ...(parentLogId ? { parentLogId } : {}),
  };
  state.log.push(entry);
  return entry;
}

export function getPlayer(state: GameState, playerId: string): PlayerState {
  const p = state.players.find((pl) => pl.id === playerId);
  if (!p) throw new Error(`Unknown player: ${playerId}`);
  return p;
}

export function computeScoreTotal(player: PlayerState): number {
  return player.scorePile.reduce((sum, card) => sum + card.age, 0);
}

export function computeTeamAchievements(state: GameState, teamId: string): number {
  return state.players
    .filter((p) => p.teamId === teamId)
    .reduce((sum, p) => sum + p.achievements.length, 0);
}

function snapshotMatchMetrics(state: GameState): {
  scoresByPlayer: Record<string, number>;
  achievementsByPlayer: Record<string, number>;
} {
  const scoresByPlayer: Record<string, number> = {};
  const achievementsByPlayer: Record<string, number> = {};
  for (const p of state.players) {
    scoresByPlayer[p.id] = computeScoreTotal(p);
    achievementsByPlayer[p.id] = p.achievements.length;
  }
  return { scoresByPlayer, achievementsByPlayer };
}

export function recordChronologyAchievement(
  state: GameState,
  playerId: string,
  label: string,
  age?: Age
): void {
  if (state.fastSimulation || !state.chronologyEvents || state.phase === 'setup') return;
  const player = getPlayer(state, playerId);
  const { scoresByPlayer, achievementsByPlayer } = snapshotMatchMetrics(state);
  state.chronologyEvents.push({
    id: `chron_${state.turnNumber}_${state.chronologyEvents.length + 1}`,
    turn: state.turnNumber,
    kind: 'achievement',
    playerId,
    playerName: player.name,
    label,
    ...(age !== undefined ? { age } : {}),
    scoresByPlayer,
    achievementsByPlayer,
  });
}

export function checkTopCardAgeMilestones(state: GameState, playerId: string): void {
  if (state.fastSimulation || !state.chronologyEvents || !state.highestAgeReachedByPlayer || state.phase !== 'playing') return;
  const player = getPlayer(state, playerId);
  const currentTopAge = getHighestTopCardAge(player.board);
  const prevBest = state.highestAgeReachedByPlayer[playerId] ?? 1;
  if (currentTopAge > prevBest) {
    state.highestAgeReachedByPlayer[playerId] = currentTopAge;
    const { scoresByPlayer, achievementsByPlayer } = snapshotMatchMetrics(state);
    state.chronologyEvents.push({
      id: `chron_${state.turnNumber}_${state.chronologyEvents.length + 1}`,
      turn: state.turnNumber,
      kind: 'age_milestone',
      playerId,
      playerName: player.name,
      label: `Reached Top Card Age ${currentTopAge}`,
      age: currentTopAge as Age,
      scoresByPlayer,
      achievementsByPlayer,
    });
  }
}

export function getOpponents(state: GameState, playerId: string): PlayerState[] {
  const actor = getPlayer(state, playerId);
  return state.players.filter(
    (p) => p.id !== playerId && !p.eliminated && (state.variant !== '2v2' || p.teamId !== actor.teamId)
  );
}

export function getClockwiseOrderFromLeft(state: GameState, actorId: string): PlayerState[] {
  const idx = state.players.findIndex((p) => p.id === actorId);
  if (idx === -1) return [];
  const ordered: PlayerState[] = [];
  for (let offset = 1; offset <= state.players.length; offset++) {
    const p = state.players[(idx + offset) % state.players.length];
    if (!p.eliminated) ordered.push(p);
  }
  return ordered;
}

export function getClockwiseOpponentsFromLeft(state: GameState, actorId: string): PlayerState[] {
  const actor = getPlayer(state, actorId);
  return getClockwiseOrderFromLeft(state, actorId).filter(
    (p) => p.id !== actorId && (state.variant !== '2v2' || p.teamId !== actor.teamId)
  );
}

function buildFinalMetrics(state: GameState): {
  finalScores: Record<string, number>;
  finalAchievements: Record<string, number>;
} {
  const finalScores: Record<string, number> = {};
  const finalAchievements: Record<string, number> = {};
  for (const p of state.players) {
    finalScores[p.id] = computeScoreTotal(p);
    finalAchievements[p.id] = p.achievements.length;
  }
  return { finalScores, finalAchievements };
}

/**
 * Immediate Score Victory triggered when any player attempts to draw Age 12+.
 * Highest score wins (combined team score in 2v2); tiebreaker = most achievements.
 */
export function resolveScoreVictory(state: GameState): GameState {
  state.phase = 'gameover';
  state.actionsRemaining = 0;
  state.pendingPrompts = [];
  const { finalScores, finalAchievements } = buildFinalMetrics(state);

  const activePlayers = state.players.filter((p) => !p.eliminated);
  if (state.variant === '2v2') {
    const teamIds = Array.from(new Set(activePlayers.map((p) => p.teamId)));
    const teamStats = teamIds.map((teamId) => ({
      teamId,
      score: activePlayers
        .filter((p) => p.teamId === teamId)
        .reduce((s, p) => s + finalScores[p.id], 0),
      achievements: computeTeamAchievements(state, teamId),
      playerIds: activePlayers.filter((p) => p.teamId === teamId).map((p) => p.id),
    }));
    teamStats.sort((a, b) => b.score - a.score || b.achievements - a.achievements);
    const best = teamStats[0];
    const tied = teamStats.filter(
      (t) => t.score === best.score && t.achievements === best.achievements
    );
    if (tied.length > 1) {
      state.victory = {
        winnerPlayerIds: [],
        winnerTeamId: null,
        reason: 'score_age12',
        summary: 'Game ended on Age 12+ draw attempt in a tie.',
        finalScores,
        finalAchievements,
      };
    } else {
      state.victory = {
        winnerPlayerIds: best.playerIds,
        winnerTeamId: best.teamId,
        reason: 'score_age12',
        summary: `Team ${best.teamId} wins by score (${best.score} pts) after Age 11 exhaustion.`,
        finalScores,
        finalAchievements,
      };
    }
    appendLog(state, best.playerIds[0] ?? 'system', state.victory.summary, 'Victory');
    return state;
  }

  const ranked = [...activePlayers].sort(
    (a, b) =>
      finalScores[b.id] - finalScores[a.id] ||
      finalAchievements[b.id] - finalAchievements[a.id]
  );
  const top = ranked[0];
  const tied = ranked.filter(
    (p) =>
      finalScores[p.id] === finalScores[top.id] &&
      finalAchievements[p.id] === finalAchievements[top.id]
  );

  if (tied.length > 1) {
    state.victory = {
      winnerPlayerIds: [],
      winnerTeamId: null,
      reason: 'score_age12',
      summary: `Age 12+ draw triggered a tie at ${finalScores[top.id]} points and ${finalAchievements[top.id]} achievements.`,
      finalScores,
      finalAchievements,
    };
  } else {
    state.victory = {
      winnerPlayerIds: [top.id],
      winnerTeamId: top.teamId,
      reason: 'score_age12',
      summary: `${top.name} wins by score (${finalScores[top.id]} pts) after attempting to draw past Age 11.`,
      finalScores,
      finalAchievements,
    };
  }
  appendLog(state, top.id, state.victory.summary, 'Victory');
  return state;
}

/**
 * Immediate victory triggered by a card Dogma effect (e.g. Empiricism, Collaboration,
 * Globalization, Self Service, Bioengineering, A.I, Astrogeology, Solar Sailing).
 */
export function resolveCardEffectVictory(
  state: GameState,
  winnerPlayerIds: string[],
  summary: string
): GameState {
  state.phase = 'gameover';
  state.actionsRemaining = 0;
  state.pendingPrompts = [];
  const { finalScores, finalAchievements } = buildFinalMetrics(state);
  const firstWinner = state.players.find((p) => p.id === winnerPlayerIds[0]);
  const winnerTeamId = firstWinner?.teamId ?? null;
  const resolvedWinners =
    state.variant === '2v2' && winnerTeamId
      ? state.players.filter((p) => !p.eliminated && p.teamId === winnerTeamId).map((p) => p.id)
      : winnerPlayerIds;

  state.victory = {
    winnerPlayerIds: resolvedWinners,
    winnerTeamId,
    reason: 'card_effect',
    summary,
    finalScores,
    finalAchievements,
  };
  if (firstWinner) {
    appendLog(state, firstWinner.id, summary, 'Victory');
  }
  return state;
}

/**
 * Finds the next non-empty deck at or above `requestedAge`.
 * Returns null if Age 12+ would be drawn.
 */
export function findNextAvailableDeckAge(state: GameState, requestedAge: number): Age | null {
  const start = Math.max(1, requestedAge);
  for (const age of ALL_AGES) {
    if (age >= start && state.decks[age].length > 0) {
      return age;
    }
  }
  return null;
}

export interface DrawCardResult {
  card: CardInstance | null;
  drawnFromAge: Age | null;
  gameEnded: boolean;
}

export function drawCardFromAge(
  state: GameState,
  playerId: string,
  requestedAge: number,
  destination: 'hand' | 'meld' | 'tuck' | 'score' | 'reveal_hand' = 'hand'
): DrawCardResult {
  if (state.phase === 'gameover') {
    return { card: null, drawnFromAge: null, gameEnded: true };
  }

  const targetAge = findNextAvailableDeckAge(state, requestedAge);
  if (targetAge === null) {
    appendLog(
      state,
      playerId,
      `Attempted to draw Age ${Math.max(1, requestedAge)} with no higher decks remaining (Age 12+ trigger).`
    );
    resolveScoreVictory(state);
    return { card: null, drawnFromAge: null, gameEnded: true };
  }

  const card = state.decks[targetAge].shift()!;
  const player = getPlayer(state, playerId);

  if (destination === 'reveal_hand') {
    state.revealedCardIds.push(card.instanceId);
    player.hand.push(card);
  } else if (destination === 'hand') {
    player.hand.push(card);
  } else if (destination === 'meld') {
    meldCardInstance(state, playerId, card);
  } else if (destination === 'tuck') {
    tuckCardInstance(state, playerId, card);
  } else if (destination === 'score') {
    scoreCardInstance(state, playerId, card);
  }

  return { card, drawnFromAge: targetAge, gameEnded: false };
}

export function meldCardInstance(
  state: GameState,
  playerId: string,
  card: CardInstance
): void {
  const player = getPlayer(state, playerId);
  const stack = player.board[card.color];
  stack.cards.push(card);
  player.board[card.color] = normalizeStackSplay(stack);
  checkTopCardAgeMilestones(state, playerId);
}

export function tuckCardInstance(
  state: GameState,
  playerId: string,
  card: CardInstance
): void {
  const player = getPlayer(state, playerId);
  const stack = player.board[card.color];
  stack.cards.unshift(card);
  player.board[card.color] = normalizeStackSplay(stack);
  state.actionStats.tuckedOrScoredCount += 1;
  checkTopCardAgeMilestones(state, playerId);
}

export function scoreCardInstance(
  state: GameState,
  playerId: string,
  card: CardInstance
): void {
  const player = getPlayer(state, playerId);
  player.scorePile.push(card);
  state.actionStats.tuckedOrScoredCount += 1;
}

export function returnCardInstance(state: GameState, card: CardInstance): void {
  state.decks[card.age].push(card);
}

export function splayPlayerColor(
  state: GameState,
  playerId: string,
  color: CardColor,
  direction: SplayDirection,
  actionTag?: string,
  parentLogId?: string
): boolean {
  const player = getPlayer(state, playerId);
  player.board[color] = normalizeStackSplay(player.board[color]);
  const stack = player.board[color];
  if (direction === 'none') return false;
  if (stack.cards.length < 2) return false;
  if (stack.splay === direction) return false;
  stack.splay = direction;
  const dirLabel = direction === 'aslant' ? 'askew' : direction;
  appendLog(
    state,
    playerId,
    parentLogId ? `${player.name}: Splayed ${color} ${dirLabel}.` : `Splayed ${color} ${dirLabel}.`,
    actionTag,
    parentLogId
  );
  return true;
}

export function unsplayPlayerColor(
  state: GameState,
  playerId: string,
  color: CardColor
): boolean {
  const player = getPlayer(state, playerId);
  const stack = player.board[color];
  if (stack.splay === 'none') return false;
  stack.splay = 'none';
  return true;
}

export function removeCardFromHand(
  player: PlayerState,
  cardInstanceId: string
): CardInstance {
  const idx = player.hand.findIndex((c) => c.instanceId === cardInstanceId);
  if (idx === -1) throw new Error(`Card ${cardInstanceId} not in ${player.id} hand`);
  return player.hand.splice(idx, 1)[0];
}

export function removeCardFromScore(
  player: PlayerState,
  cardInstanceId: string
): CardInstance {
  const idx = player.scorePile.findIndex((c) => c.instanceId === cardInstanceId);
  if (idx === -1) throw new Error(`Card ${cardInstanceId} not in ${player.id} scorePile`);
  return player.scorePile.splice(idx, 1)[0];
}

export function removeTopCardFromBoard(
  player: PlayerState,
  color: CardColor
): CardInstance {
  const stack = player.board[color];
  if (stack.cards.length === 0) {
    throw new Error(`No ${color} card on ${player.id} board`);
  }
  const card = stack.cards.pop()!;
  player.board[color] = normalizeStackSplay(stack);
  return card;
}

export function removeBottomCardFromBoard(
  player: PlayerState,
  color: CardColor
): CardInstance {
  const stack = player.board[color];
  if (stack.cards.length === 0) {
    throw new Error(`No ${color} card on ${player.id} board`);
  }
  const card = stack.cards.shift()!;
  player.board[color] = normalizeStackSplay(stack);
  return card;
}

export type TransferLocation =
  | { zone: 'hand'; playerId: string }
  | { zone: 'score'; playerId: string }
  | { zone: 'board'; playerId: string; color?: CardColor };

/**
 * Transfers a card between areas in play without counting as melding, achieving, or scoring.
 * A card transferred to a board becomes a top card on that board.
 */
export function transferCard(
  state: GameState,
  from: TransferLocation,
  to: TransferLocation,
  cardInstanceId: string
): CardInstance {
  const sourcePlayer = getPlayer(state, from.playerId);
  let card: CardInstance;
  if (from.zone === 'hand') {
    card = removeCardFromHand(sourcePlayer, cardInstanceId);
  } else if (from.zone === 'score') {
    card = removeCardFromScore(sourcePlayer, cardInstanceId);
  } else {
    const color =
      from.color ??
      (ALL_COLORS.find(
        (c) =>
          sourcePlayer.board[c].cards[sourcePlayer.board[c].cards.length - 1]?.instanceId ===
          cardInstanceId
      ) as CardColor);
    card = removeTopCardFromBoard(sourcePlayer, color);
  }

  const destPlayer = getPlayer(state, to.playerId);
  if (to.zone === 'hand') {
    destPlayer.hand.push(card);
  } else if (to.zone === 'score') {
    destPlayer.scorePile.push(card);
  } else {
    destPlayer.board[card.color].cards.push(card);
    destPlayer.board[card.color] = normalizeStackSplay(destPlayer.board[card.color]);
    checkTopCardAgeMilestones(state, to.playerId);
  }
  return card;
}

export type ExchangeZone =
  | { zone: 'hand'; playerId: string }
  | { zone: 'score'; playerId: string };

/**
 * Swaps selected cards between two zones, even if one side is empty.
 * Exchanged cards do NOT count as scored/melded/drawn for Special Achievements.
 */
export function exchangeCards(
  state: GameState,
  a: ExchangeZone,
  cardIdsA: string[],
  b: ExchangeZone,
  cardIdsB: string[]
): void {
  const playerA = getPlayer(state, a.playerId);
  const playerB = getPlayer(state, b.playerId);

  const takenFromA = cardIdsA.map((id) =>
    a.zone === 'hand' ? removeCardFromHand(playerA, id) : removeCardFromScore(playerA, id)
  );
  const takenFromB = cardIdsB.map((id) =>
    b.zone === 'hand' ? removeCardFromHand(playerB, id) : removeCardFromScore(playerB, id)
  );

  for (const c of takenFromB) {
    if (a.zone === 'hand') playerA.hand.push(c);
    else playerA.scorePile.push(c);
  }
  for (const c of takenFromA) {
    if (b.zone === 'hand') playerB.hand.push(c);
    else playerB.scorePile.push(c);
  }
}

export function junkCardInstance(state: GameState, card: CardInstance): void {
  state.junk.push(card);
}

export function junkDeck(state: GameState, age: Age): number {
  const cards = state.decks[age];
  const count = cards.length;
  if (count === 0) return 0;
  state.junk.push(...cards);
  state.decks[age] = [];
  return count;
}

export function junkStandardAchievementByAge(state: GameState, age: Age): CardInstance | null {
  const idx = state.standardAchievements.findIndex((c) => c.age === age);
  if (idx === -1) return null;
  const card = state.standardAchievements.splice(idx, 1)[0];
  state.junk.push(card);
  if (state.junkedStandardAges) {
    state.junkedStandardAges.push(age);
  }
  return card;
}

export function junkSpecialAchievement(
  state: GameState,
  specialId: SpecialAchievementId
): boolean {
  const idx = state.availableSpecialAchievements.indexOf(specialId);
  if (idx === -1) return false;
  state.availableSpecialAchievements.splice(idx, 1);
  return true;
}

export function getJunkedSpecialAchievements(state: GameState): SpecialAchievementId[] {
  const allSpecials: SpecialAchievementId[] = ['monument', 'empire', 'world', 'wonder', 'universe'];
  return allSpecials.filter(
    (id) =>
      !state.availableSpecialAchievements.includes(id) &&
      !state.players.some((p) => p.achievements.some((a) => a.specialId === id))
  );
}

export function eliminatePlayer(state: GameState, playerId: string): void {
  const player = getPlayer(state, playerId);
  if (player.eliminated) return;

  player.eliminated = true;
  state.junk.push(...player.hand);
  player.hand = [];
  state.junk.push(...player.scorePile);
  player.scorePile = [];
  for (const color of ALL_COLORS) {
    state.junk.push(...player.board[color].cards);
    player.board[color] = { color, cards: [], splay: 'none' };
  }
  for (const ach of player.achievements) {
    if (ach.card) state.junk.push(ach.card);
  }
  player.achievements = [];

  appendLog(state, playerId, `${player.name} was eliminated and all their cards were junked.`);

  const remaining = state.players.filter((p) => !p.eliminated);
  if (state.variant === '2v2') {
    const remainingTeams = Array.from(new Set(remaining.map((p) => p.teamId)));
    if (remainingTeams.length === 1) {
      const winnerTeamId = remainingTeams[0];
      const { finalScores, finalAchievements } = buildFinalMetrics(state);
      state.phase = 'gameover';
      state.actionsRemaining = 0;
      state.victory = {
        winnerPlayerIds: remaining.map((p) => p.id),
        winnerTeamId,
        reason: 'elimination',
        summary: `Team ${winnerTeamId} wins by elimination.`,
        finalScores,
        finalAchievements,
      };
    }
  } else if (remaining.length === 1) {
    const winner = remaining[0];
    const { finalScores, finalAchievements } = buildFinalMetrics(state);
    state.phase = 'gameover';
    state.actionsRemaining = 0;
    state.victory = {
      winnerPlayerIds: [winner.id],
      winnerTeamId: winner.teamId,
      reason: 'elimination',
      summary: `${winner.name} wins by elimination.`,
      finalScores,
      finalAchievements,
    };
  }
}

export function qualifiesForSpecialAchievement(
  player: PlayerState,
  specialId: SpecialAchievementId
): boolean {
  if (player.eliminated) return false;
  const icons = getVisibleIconCounts(player.board);
  switch (specialId) {
    case 'monument':
      return countDemandTopCards(player.board) >= 4;
    case 'empire':
      return EMPIRE_ICONS.every((icon) => icons[icon] >= 3);
    case 'world':
      return icons.clock >= 12;
    case 'wonder':
      return countWonderEligibleColors(player.board) === 5;
    case 'universe': {
      const topCards = getTopCards(player.board);
      return topCards.length === 5 && topCards.every((c) => c.age >= 8);
    }
  }
}

export function claimSpecialAchievement(
  state: GameState,
  playerId: string,
  specialId: SpecialAchievementId
): boolean {
  const idx = state.availableSpecialAchievements.indexOf(specialId);
  if (idx === -1) return false;
  state.availableSpecialAchievements.splice(idx, 1);
  const player = getPlayer(state, playerId);
  player.achievements.push({
    id: `ach_special_${specialId}`,
    kind: 'special',
    specialId,
  });
  recordChronologyAchievement(
    state,
    playerId,
    `Special Achievement: ${SPECIAL_ACHIEVEMENTS[specialId].name}`
  );
  appendLog(
    state,
    playerId,
    `Claimed Special Achievement: ${SPECIAL_ACHIEVEMENTS[specialId].name}.`,
    'Achievement'
  );
  return true;
}

/**
 * Checked at the end of any action.
 * If multiple players qualify simultaneously, the first qualifying player
 * in clockwise order starting to the left of the current player claims it.
 */
export function checkSpecialAchievementsAtActionEnd(state: GameState): void {
  if (state.phase === 'gameover') return;
  const current = state.players[state.currentPlayerIndex];
  const order = getClockwiseOrderFromLeft(state, current.id);

  const available = [...state.availableSpecialAchievements];
  for (const specialId of available) {
    for (const player of order) {
      if (qualifiesForSpecialAchievement(player, specialId)) {
        claimSpecialAchievement(state, player.id, specialId);
        break;
      }
    }
  }
}

export function checkAchievementVictoryAtActionEnd(state: GameState): boolean {
  if (state.phase === 'gameover') return true;
  const current = state.players[state.currentPlayerIndex];
  const order = getClockwiseOrderFromLeft(state, current.id);
  const { finalScores, finalAchievements } = buildFinalMetrics(state);

  if (state.variant === '2v2') {
    const teamIds = Array.from(new Set(order.map((p) => p.teamId)));
    const qualifying = teamIds
      .map((teamId) => ({
        teamId,
        count: computeTeamAchievements(state, teamId),
        playerIds: state.players
          .filter((p) => p.teamId === teamId && !p.eliminated)
          .map((p) => p.id),
      }))
      .filter((t) => t.count >= state.achievementTarget);

    if (qualifying.length === 0) return false;
    const maxCount = Math.max(...qualifying.map((q) => q.count));
    const tiedTop = qualifying.filter((q) => q.count === maxCount);
    let winnerTeam = tiedTop[0];
    if (tiedTop.length > 1) {
      for (const p of order) {
        const found = tiedTop.find((t) => t.teamId === p.teamId);
        if (found) {
          winnerTeam = found;
          break;
        }
      }
    }
    state.phase = 'gameover';
    state.actionsRemaining = 0;
    state.victory = {
      winnerPlayerIds: winnerTeam.playerIds,
      winnerTeamId: winnerTeam.teamId,
      reason: 'achievements',
      summary: `Team ${winnerTeam.teamId} wins with ${winnerTeam.count} achievements!`,
      finalScores,
      finalAchievements,
    };
    appendLog(state, winnerTeam.playerIds[0] ?? 'system', state.victory.summary, 'Victory');
    return true;
  }

  const qualifying = order.filter((p) => p.achievements.length >= state.achievementTarget);
  if (qualifying.length === 0) return false;

  const maxAchievements = Math.max(...qualifying.map((p) => p.achievements.length));
  // order is already clockwise starting from current player's left
  const winner = qualifying.find((p) => p.achievements.length === maxAchievements)!;

  state.phase = 'gameover';
  state.actionsRemaining = 0;
  state.victory = {
    winnerPlayerIds: [winner.id],
    winnerTeamId: winner.teamId,
    reason: 'achievements',
    summary: `${winner.name} wins with ${winner.achievements.length} achievements!`,
    finalScores,
    finalAchievements,
  };
  appendLog(state, winner.id, state.victory.summary, 'Victory');
  return true;
}

/**
 * Chain Rule (4th Edition p. 28):
 * If while self-executing a card's effect, you would perform "self-execute",
 * first draw and achieve an 11, awarding yourself a Chain Achievement.
 */
export function triggerChainRuleIfNested(
  state: GameState,
  playerId: string,
  dogmaCtx: DogmaExecutionContext
): boolean {
  if (dogmaCtx.selfExecuteDepth <= 0) return false;
  const drawRes = drawCardFromAge(state, playerId, 11, 'hand');
  if (drawRes.gameEnded || !drawRes.card) {
    return true;
  }
  const player = getPlayer(state, playerId);
  // Move the drawn 11 out of hand into achievements as a Chain Achievement
  const idx = player.hand.findIndex((c) => c.instanceId === drawRes.card!.instanceId);
  if (idx !== -1) player.hand.splice(idx, 1);

  const ach: ClaimedAchievement = {
    id: `ach_chain_${drawRes.card.instanceId}`,
    kind: 'chain',
    age: drawRes.card.age,
    card: drawRes.card,
  };
  player.achievements.push(ach);
  recordChronologyAchievement(
    state,
    playerId,
    `Chain Achievement [${drawRes.card.age}]`,
    drawRes.card.age
  );
  appendLog(
    state,
    playerId,
    `Chain Rule triggered: achieved Age ${drawRes.card.age} as a Chain Achievement.`,
    'Chain'
  );
  return false;
}

/**
 * Computes locked-in Dogma sharing & demand eligibility at the moment Dogma begins.
 */
export function createDogmaContext(
  state: GameState,
  activatingPlayerId: string,
  card: CardInstance
): DogmaExecutionContext {
  const actor = getPlayer(state, activatingPlayerId);
  const actorIcons = getVisibleIconCounts(actor.board);
  const actorCount = actorIcons[card.featuredIcon];

  const othersClockwise = getClockwiseOrderFromLeft(state, activatingPlayerId).filter(
    (p) => p.id !== activatingPlayerId
  );
  const teammateIds =
    state.variant === '2v2'
      ? state.players
          .filter(
            (p) => p.id !== activatingPlayerId && !p.eliminated && p.teamId === actor.teamId
          )
          .map((p) => p.id)
      : [];

  const eligibleToShareIds: string[] = [];
  const vulnerableToDemandIds: string[] = [];

  for (const other of othersClockwise) {
    const isTeammate = state.variant === '2v2' && other.teamId === actor.teamId;
    const otherCount = getVisibleIconCounts(other.board)[card.featuredIcon];
    if (otherCount >= actorCount) {
      // Non-demand Dogma effects share with teammates too (even if harmful)
      eligibleToShareIds.push(other.id);
    } else if (!isTeammate) {
      // Teammates are immune to I DEMAND effects
      vulnerableToDemandIds.push(other.id);
    }
  }

  const lockedAbilities = card.abilities.map((a) => ({ ...a }));
  const steps = lockedAbilities.flatMap((ab) => {
    if (ab.isDemand) {
      return vulnerableToDemandIds.map((oppId) => ({
        abilityIndex: ab.index,
        executingPlayerId: oppId,
        isDemand: true,
      }));
    }
    return [
      ...eligibleToShareIds.map((oppId) => ({
        abilityIndex: ab.index,
        executingPlayerId: oppId,
        isDemand: false,
      })),
      {
        abilityIndex: ab.index,
        executingPlayerId: activatingPlayerId,
        isDemand: false,
      },
    ];
  });

  return {
    activatingPlayerId,
    sourceCardDefId: card.defId,
    sourceCardName: card.name,
    featuredIcon: card.featuredIcon,
    lockedAbilities,
    eligibleToShareIds,
    vulnerableToDemandIds,
    teammateIds,
    steps,
    currentStepIndex: 0,
    anyOpponentSharedCardChange: false,
    selfExecuteDepth: 0,
  };
}
