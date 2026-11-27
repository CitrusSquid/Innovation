import { BASE_CARD_DATABASE, instantiateCard } from '../data/cards/catalog';
import { ALL_AGES, ALL_COLORS } from './constants';
import { resolveDogmaPromptAnswer, startDogmaStep } from './dogmaEffects';
import {
  appendLog,
  checkAchievementVictoryAtActionEnd,
  checkSpecialAchievementsAtActionEnd,
  cloneGameState,
  computeScoreTotal,
  createDogmaContext,
  drawCardFromAge,
  getPlayer,
  meldCardInstance,
  recordChronologyAchievement,
  removeCardFromHand,
} from './keywords';
import { generateRandomSeed, shuffleWithSeed } from './rng';
import { createEmptyBoard, getHighestTopCardAge, getTopCard } from './splay';
import type {
  Age,
  CardColor,
  CardDefinition,
  CardInstance,
  GameConfig,
  GameState,
  OpponentMoveHighlight,
  PlayerState,
  TurnAction,
} from './types';

export interface LegalTurnOptions {
  canDraw: boolean;
  drawTargetAge: Age | null;
  meldableCardIds: string[];
  dogmaColors: CardColor[];
  achievableAges: Age[];
}

export function getAchievementTarget(variant: GameConfig['variant']): number {
  if (variant === '1v1v1') return 5;
  return 6; // 1v1 and 2v2 both require 6
}

export function getPlayerCountForVariant(variant: GameConfig['variant']): number {
  if (variant === '1v1') return 2;
  if (variant === '1v1v1') return 3;
  return 4;
}

export function buildActiveCatalog(): CardDefinition[] {
  return BASE_CARD_DATABASE;
}

export function createGame(
  config: GameConfig,
  customCatalog?: CardDefinition[]
): GameState {
  const expectedPlayers = getPlayerCountForVariant(config.variant);
  const names = [...config.playerNames];
  while (names.length < expectedPlayers) {
    names.push(`Player ${names.length + 1}`);
  }

  const seed = config.seed !== undefined ? (config.seed >>> 0) : generateRandomSeed();
  let rngState = seed || 1;

  const catalog = customCatalog ?? BASE_CARD_DATABASE;

  // Build and shuffle the 11 Age decks
  const decks = {} as Record<Age, CardInstance[]>;
  for (const age of ALL_AGES) {
    const ageDefs = catalog.filter((c) => c.age === age);
    const instances = ageDefs.map((def, idx) => instantiateCard(def, `g${idx + 1}`));
    const shuffled = shuffleWithSeed(instances, rngState);
    decks[age] = shuffled.value;
    rngState = shuffled.nextState;
  }

  // Standard Achievements: 1 random card from Ages 1 through 10 (NOT Age 11)
  const standardAchievements: CardInstance[] = [];
  for (const age of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as Age[]) {
    if (decks[age].length > 0) {
      standardAchievements.push(decks[age].shift()!);
    }
  }

  const fallbackControlMode = config.controlMode ?? 'vs_ai';
  const players: PlayerState[] = names.slice(0, expectedPlayers).map((name, idx) => {
    const isAI =
      config.playerIsAI !== undefined
        ? Boolean(config.playerIsAI[idx])
        : fallbackControlMode === 'vs_ai' && idx > 0;
    const aiBackend = isAI ? config.playerAIBackends?.[idx] ?? 'heuristic' : undefined;
    const teamId =
      config.variant === '2v2' ? (idx % 2 === 0 ? 'A' : 'B') : `T${idx + 1}`;
    return {
      id: `p${idx + 1}`,
      name,
      isAI,
      ...(aiBackend ? { aiBackend } : {}),
      teamId,
      eliminated: false,
      hand: [],
      board: createEmptyBoard(),
      scorePile: [],
      achievements: [],
    };
  });

  const humanCount = players.filter((p) => !p.isAI).length;
  const resolvedControlMode =
    config.controlMode ?? (humanCount > 1 ? 'pass_and_play' : 'vs_ai');

  // Each player draws 2 cards from Age 1
  for (const player of players) {
    for (let i = 0; i < 2; i++) {
      if (decks[1].length > 0) {
        player.hand.push(decks[1].shift()!);
      }
    }
  }

  // Simultaneous setup meld prompts
  const pendingPrompts = players.map((player) => ({
    id: `prompt_setup_${player.id}`,
    kind: 'setup_meld' as const,
    playerId: player.id,
    title: 'Choose 1 starting card to meld onto your board',
    options: [...player.hand],
  }));

  const modeSummary =
    humanCount === 0
      ? 'AI vs AI'
      : humanCount === players.length
      ? 'Pass & Play'
      : humanCount === 1
      ? 'vs. AI'
      : 'Mixed Human & AI';

  const state: GameState = {
    version: 1,
    seed,
    rngState,
    variant: config.variant,
    controlMode: resolvedControlMode,
    ...(config.fastSimulation ? { fastSimulation: true } : {}),
    phase: 'setup',
    turnNumber: 0,
    currentPlayerIndex: 0,
    actionsRemaining: 1,
    actionsTotalThisTurn: 1,
    manualEndTurn: Boolean(config.manualEndTurn),
    manualEndTurnForAI: Boolean(config.manualEndTurnForAI),
    openingSingleActionTurnsRemaining: config.variant === '2v2' ? 2 : 1,
    achievementTarget: getAchievementTarget(config.variant),
    players,
    decks,
    standardAchievements,
    availableSpecialAchievements: ['monument', 'empire', 'world', 'wonder', 'universe'],
    junk: [],
    revealedCardIds: [],
    setupSelections: {},
    pendingPrompts,
    activeDogma: null,
    actionStats: { tuckedOrScoredCount: 0 },
    lastTurnActionsByPlayer: config.fastSimulation ? undefined : {},
    junkedStandardAges: [],
    highestAgeReachedByPlayer: config.fastSimulation
      ? undefined
      : Object.fromEntries(players.map((p) => [p.id, 1])),
    chronologyEvents: config.fastSimulation ? undefined : [],
    log: config.fastSimulation
      ? []
      : [
          {
            id: 'log_0',
            turn: 0,
            actorId: 'system',
            actorName: 'System',
            message: `New ${config.variant} match started (${modeSummary}).\n${getAchievementTarget(config.variant)} achievements for victory.`,
          },
        ],
    victory: null,
  };

  return state;
}

export function getEligibleAchievementAges(state: GameState, playerId: string): Age[] {
  const player = getPlayer(state, playerId);
  const score = computeScoreTotal(player);
  const highestTop = getHighestTopCardAge(player.board);

  return state.standardAchievements
    .map((c) => c.age)
    .filter((age) => score >= age * 5 && highestTop >= age)
    .sort((a, b) => a - b);
}

export function getLegalTurnOptions(state: GameState, playerId: string): LegalTurnOptions {
  if (state.phase !== 'playing' || state.pendingPrompts.length > 0) {
    return {
      canDraw: false,
      drawTargetAge: null,
      meldableCardIds: [],
      dogmaColors: [],
      achievableAges: [],
    };
  }
  const current = state.players[state.currentPlayerIndex];
  if (current.id !== playerId || current.eliminated || state.actionsRemaining <= 0) {
    return {
      canDraw: false,
      drawTargetAge: null,
      meldableCardIds: [],
      dogmaColors: [],
      achievableAges: [],
    };
  }

  const highest = getHighestTopCardAge(current.board);
  let drawTargetAge: Age | null = null;
  for (const age of ALL_AGES) {
    if (age >= Math.max(1, highest) && state.decks[age].length > 0) {
      drawTargetAge = age;
      break;
    }
  }

  const dogmaColors = ALL_COLORS.filter((color) => {
    const top = getTopCard(current.board[color]);
    return top !== null && top.abilities.length > 0;
  });

  return {
    canDraw: true, // Always legal; triggers Age 12+ game end if no higher deck exists
    drawTargetAge,
    meldableCardIds: current.hand.map((c) => c.instanceId),
    dogmaColors,
    achievableAges: getEligibleAchievementAges(state, playerId),
  };
}

function recordLastTurnHighlight(
  state: GameState,
  playerId: string,
  highlight: OpponentMoveHighlight
): void {
  if (state.fastSimulation) return;
  if (!state.lastTurnActionsByPlayer) {
    state.lastTurnActionsByPlayer = {};
  }
  const existing = state.lastTurnActionsByPlayer[playerId] ?? [];
  state.lastTurnActionsByPlayer[playerId] = [...existing.slice(-1), highlight];
}

function advanceToNextTurn(state: GameState): void {
  if (state.phase === 'gameover') return;
  let nextIdx = (state.currentPlayerIndex + 1) % state.players.length;
  while (state.players[nextIdx].eliminated) {
    nextIdx = (nextIdx + 1) % state.players.length;
  }
  state.currentPlayerIndex = nextIdx;
  state.turnNumber += 1;

  if (!state.fastSimulation) {
    const nextPlayer = state.players[nextIdx];
    if (!state.lastTurnActionsByPlayer) {
      state.lastTurnActionsByPlayer = {};
    }
    state.lastTurnActionsByPlayer[nextPlayer.id] = [];
  }

  if (state.openingSingleActionTurnsRemaining > 0) {
    state.actionsRemaining = 1;
    state.actionsTotalThisTurn = 1;
    state.openingSingleActionTurnsRemaining -= 1;
  } else {
    state.actionsRemaining = 2;
    state.actionsTotalThisTurn = 2;
  }
}

export function setManualEndTurn(
  rawState: GameState,
  manual: boolean,
  manualForAI?: boolean
): GameState {
  const state = cloneGameState(rawState);
  state.manualEndTurn = manual;
  if (manualForAI !== undefined) {
    state.manualEndTurnForAI = manualForAI;
  }
  const activePlayer = state.players[state.currentPlayerIndex];
  const shouldHoldTurn =
    manual && (!activePlayer?.isAI || Boolean(state.manualEndTurnForAI));
  if (
    !shouldHoldTurn &&
    state.phase === 'playing' &&
    state.pendingPrompts.length === 0 &&
    state.actionsRemaining <= 0
  ) {
    advanceToNextTurn(state);
  }
  return state;
}

function advanceTurnOrAction(state: GameState): void {
  if (state.phase === 'gameover') return;

  checkSpecialAchievementsAtActionEnd(state);
  if (checkAchievementVictoryAtActionEnd(state)) return;

  const activePlayer = state.players[state.currentPlayerIndex];
  if (activePlayer?.eliminated) {
    state.actionsRemaining = 0;
    state.actionStats = { tuckedOrScoredCount: 0 };
    state.revealedCardIds = [];
    advanceToNextTurn(state);
    return;
  }

  state.actionsRemaining = Math.max(0, state.actionsRemaining - 1);
  state.actionStats = { tuckedOrScoredCount: 0 };
  state.revealedCardIds = [];

  if (state.actionsRemaining <= 0) {
    if (state.manualEndTurn && (!activePlayer.isAI || state.manualEndTurnForAI)) {
      return;
    }
    advanceToNextTurn(state);
  }
}

function finalizeSetupIfReady(state: GameState): void {
  if (state.pendingPrompts.length > 0) return;

  // Simultaneously meld each player's chosen card (recorded under turn 0 / Setup)
  const meldedByPlayer: Array<{ playerIndex: number; playerId: string; cardName: string }> = [];
  for (let i = 0; i < state.players.length; i++) {
    const player = state.players[i];
    const chosenId = state.setupSelections[player.id];
    const card = removeCardFromHand(player, chosenId);
    meldCardInstance(state, player.id, card);
    meldedByPlayer.push({ playerIndex: i, playerId: player.id, cardName: card.name });
    appendLog(state, player.id, `Melded starting card ${card.name} (Age ${card.age} ${card.color}).`);
  }

  // First player: card title first in alphabetical order
  meldedByPlayer.sort((a, b) => a.cardName.localeCompare(b.cardName) || a.playerIndex - b.playerIndex);
  const first = meldedByPlayer[0];
  state.currentPlayerIndex = first.playerIndex;
  appendLog(
    state,
    first.playerId,
    `${state.players[first.playerIndex].name} goes first (alphabetical title "${first.cardName}") with 1 opening action.`,
    'Setup'
  );

  state.phase = 'playing';
  state.turnNumber = 1;
  state.actionsRemaining = 1;
  state.actionsTotalThisTurn = 1;
  state.openingSingleActionTurnsRemaining = Math.max(0, state.openingSingleActionTurnsRemaining - 1);
  if (!state.fastSimulation) {
    if (!state.highestAgeReachedByPlayer) state.highestAgeReachedByPlayer = {};
    for (const p of state.players) {
      state.highestAgeReachedByPlayer[p.id] = getHighestTopCardAge(p.board);
    }
  }
}

function advanceActiveDogma(state: GameState): void {
  while (
    state.activeDogma &&
    state.activeDogma.currentStepIndex < state.activeDogma.steps.length &&
    state.phase !== 'gameover'
  ) {
    const ctx = state.activeDogma;
    const step = ctx.steps[ctx.currentStepIndex];
    ctx.selfExecuteDepth = step.selfExecuteDepth ?? 0;
    const stepDefId = step.sourceCardDefId ?? ctx.sourceCardDefId;
    const stepCardName = step.sourceCardName ?? ctx.sourceCardName;
    const ability =
      step.sourceAbility ?? ctx.lockedAbilities.find((a) => a.index === step.abilityIndex);
    if (!ability) {
      ctx.currentStepIndex += 1;
      continue;
    }

    const execPlayer = getPlayer(state, step.executingPlayerId);
    if (execPlayer.eliminated) {
      ctx.currentStepIndex += 1;
      continue;
    }

    const outcome = startDogmaStep(
      state,
      ctx,
      ability,
      execPlayer,
      step.isDemand,
      stepDefId,
      stepCardName
    );
    if (outcome === 'gameover') {
      state.activeDogma = null;
      return;
    }
    if (outcome === 'dogma_complete') {
      ctx.currentStepIndex = ctx.steps.length;
      break;
    }
    if (outcome === 'awaiting_prompt') {
      return;
    }
    ctx.currentStepIndex += 1;
  }

  // All Dogma steps completed: evaluate Sharing Free Draw
  if (state.activeDogma && state.phase !== 'gameover') {
    const ctx = state.activeDogma;
    if (ctx.anyOpponentSharedCardChange) {
      const actor = getPlayer(state, ctx.activatingPlayerId);
      if (!actor.eliminated) {
        const highest = getHighestTopCardAge(actor.board);
        const drawRes = drawCardFromAge(state, ctx.activatingPlayerId, highest, 'hand');
        if (drawRes.gameEnded) {
          state.activeDogma = null;
          return;
        }
        if (drawRes.card) {
          appendLog(
            state,
            ctx.activatingPlayerId,
            `${actor.name}: Free Draw from Age ${drawRes.drawnFromAge} (sharing bonus).`,
            'Free Draw',
            ctx.parentLogId
          );
        }
      }
    }
    state.activeDogma = null;
    advanceTurnOrAction(state);
  }
}

export function applyAction(
  rawState: GameState,
  action: TurnAction,
  options?: { mutateInPlace?: boolean }
): GameState {
  const state = options?.mutateInPlace ? rawState : cloneGameState(rawState);

  if (state.phase === 'gameover') {
    throw new Error('Game is already over.');
  }

  if (action.type === 'setup_meld') {
    if (state.phase !== 'setup') throw new Error('Not in setup phase.');
    const promptIdx = state.pendingPrompts.findIndex(
      (p) => p.kind === 'setup_meld' && p.playerId === action.playerId
    );
    if (promptIdx === -1) throw new Error(`No setup prompt for ${action.playerId}`);
    const player = getPlayer(state, action.playerId);
    if (!player.hand.some((c) => c.instanceId === action.cardInstanceId)) {
      throw new Error('Selected starting card is not in hand.');
    }
    state.setupSelections[action.playerId] = action.cardInstanceId;
    state.pendingPrompts.splice(promptIdx, 1);
    finalizeSetupIfReady(state);
    return state;
  }

  if (state.phase !== 'playing') {
    throw new Error(`Cannot perform ${action.type} during phase ${state.phase}`);
  }

  if (state.pendingPrompts.length > 0) {
    if (action.type !== 'answer_prompt') {
      throw new Error('Must resolve pending prompt before taking a turn action.');
    }
    const top = state.pendingPrompts[0];
    if (top.id !== action.promptId || top.playerId !== action.playerId) {
      throw new Error('Prompt mismatch.');
    }
    state.pendingPrompts.shift();

    if (state.activeDogma) {
      const step = state.activeDogma.steps[state.activeDogma.currentStepIndex];
      state.activeDogma.selfExecuteDepth = step?.selfExecuteDepth ?? 0;
      const outcome = resolveDogmaPromptAnswer(state, state.activeDogma, top, action);
      if (outcome === 'gameover') {
        state.activeDogma = null;
        return state;
      }
      if (outcome === 'dogma_complete') {
        state.activeDogma.currentStepIndex = state.activeDogma.steps.length;
        advanceActiveDogma(state);
        return state;
      }
      if (outcome === 'awaiting_prompt') {
        return state;
      }
      state.activeDogma.currentStepIndex += 1;
      advanceActiveDogma(state);
      return state;
    }

    if (state.pendingPrompts.length === 0) {
      advanceTurnOrAction(state);
    }
    return state;
  }

  const currentPlayer = state.players[state.currentPlayerIndex];
  if (action.playerId !== currentPlayer.id) {
    throw new Error(`Not ${action.playerId}'s turn (current: ${currentPlayer.id}).`);
  }

  if (action.type === 'end_turn') {
    if (state.actionsRemaining > 0) {
      throw new Error('Cannot end turn while actions remain.');
    }
    advanceToNextTurn(state);
    return state;
  }

  if (state.actionsRemaining <= 0) {
    throw new Error('No actions remaining this turn; press End Turn.');
  }

  if (action.type === 'draw') {
    const highest = getHighestTopCardAge(currentPlayer.board);
    const res = drawCardFromAge(state, currentPlayer.id, highest, 'hand');
    if (res.gameEnded) {
      return state;
    }
    recordLastTurnHighlight(state, currentPlayer.id, { kind: 'draw' });
    appendLog(
      state,
      currentPlayer.id,
      `Drew 1 card from Age ${res.drawnFromAge}${highest > 0 && res.drawnFromAge !== highest ? ` (Age ${highest} empty)` : ''}.`
    );
    advanceTurnOrAction(state);
    return state;
  }

  if (action.type === 'meld') {
    const card = removeCardFromHand(currentPlayer, action.cardInstanceId);
    meldCardInstance(state, currentPlayer.id, card);
    recordLastTurnHighlight(state, currentPlayer.id, { kind: 'meld', color: card.color });
    appendLog(state, currentPlayer.id, `Melded ${card.name} (Age ${card.age} ${card.color}).`);
    advanceTurnOrAction(state);
    return state;
  }

  if (action.type === 'achieve') {
    const eligible = getEligibleAchievementAges(state, currentPlayer.id);
    if (!eligible.includes(action.age)) {
      throw new Error(`Player ${currentPlayer.id} is not eligible for Age ${action.age} achievement.`);
    }
    const idx = state.standardAchievements.findIndex((c) => c.age === action.age);
    const achCard = state.standardAchievements.splice(idx, 1)[0];
    currentPlayer.achievements.push({
      id: `ach_std_${achCard.instanceId}`,
      kind: 'standard',
      age: achCard.age,
      card: achCard,
    });
    recordChronologyAchievement(
      state,
      currentPlayer.id,
      `Standard Achievement [${achCard.age}]`,
      achCard.age
    );
    recordLastTurnHighlight(state, currentPlayer.id, { kind: 'achieve' });
    appendLog(state, currentPlayer.id, `Claimed Standard Achievement (Age ${achCard.age}).`);
    advanceTurnOrAction(state);
    return state;
  }

  if (action.type === 'dogma') {
    const top = getTopCard(currentPlayer.board[action.color]);
    if (!top) {
      throw new Error(`No top ${action.color} card to dogma.`);
    }
    if (top.abilities.length === 0) {
      throw new Error(`${top.name} has no dogma abilities.`);
    }
    recordLastTurnHighlight(state, currentPlayer.id, { kind: 'dogma', color: action.color });
    const parentEntry = appendLog(state, currentPlayer.id, `Activated Dogma on ${top.name}.`);
    state.activeDogma = createDogmaContext(state, currentPlayer.id, top);
    state.activeDogma.parentLogId = parentEntry.id;
    advanceActiveDogma(state);
    return state;
  }

  throw new Error(`Unhandled action type.`);
}
