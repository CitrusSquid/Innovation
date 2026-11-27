import { ALL_COLORS } from './constants';
import {
  appendLog,
  drawCardFromAge,
  getPlayer,
  junkCardInstance,
  meldCardInstance,
  removeCardFromHand,
  removeCardFromScore,
  splayPlayerColor,
  transferCard,
  triggerChainRuleIfNested,
  tuckCardInstance,
} from './keywords';
import {
  canSplayStack,
  getStackVisibleIcons,
  normalizeStackSplay,
} from './splay';
import type {
  CardAbility,
  CardColor,
  CardInstance,
  DogmaExecutionContext,
  DogmaSubState,
  FunctionalIcon,
  GameState,
  PlayerBoard,
  PlayerState,
  SplayDirection,
  TurnAction,
} from './types';

export type DogmaStepOutcome = 'completed' | 'awaiting_prompt' | 'gameover' | 'dogma_complete';

export function getTagPrefix(ctx: DogmaExecutionContext, execPlayerId: string, isDemand: boolean): string {
  if (isDemand) return 'Demand';
  return execPlayerId !== ctx.activatingPlayerId ? 'Share' : 'Dogma';
}

export function logStep(
  state: GameState,
  ctx: DogmaExecutionContext,
  execPlayerId: string,
  isDemand: boolean,
  message: string
): void {
  const player = getPlayer(state, execPlayerId);
  appendLog(
    state,
    execPlayerId,
    `${player.name}: ${message}`,
    getTagPrefix(ctx, execPlayerId, isDemand),
    ctx.parentLogId
  );
}

export function recordRepeatDrawStep(
  state: GameState,
  params: {
    actorId: string;
    actorName: string;
    sourceCardDefId: string;
    sourceCardName: string;
    stepNumber: number;
    card: CardInstance;
    repeats: boolean;
    badge: string;
    outcomeText: string;
  }
): void {
  if (state.fastSimulation) return;
  if (!state.repeatDrawEvents) {
    state.repeatDrawEvents = [];
  }
  const idx = state.repeatDrawEvents.length;
  state.repeatDrawEvents.push({
    id: `rdraw_${state.turnNumber}_${idx}_${params.card.instanceId}`,
    turn: state.turnNumber,
    ...params,
  });
}

export function recordChange(
  ctx: DogmaExecutionContext,
  execPlayerId: string,
  isDemand: boolean,
  changed: boolean
): void {
  if (!changed) return;
  if (
    !isDemand &&
    execPlayerId !== ctx.activatingPlayerId &&
    !ctx.teammateIds?.includes(execPlayerId)
  ) {
    ctx.anyOpponentSharedCardChange = true;
  }
}

export function makePromptId(
  state: GameState,
  ctx: DogmaExecutionContext,
  tag: string,
  playerId: string
): string {
  const phase = ctx.subState?.phase ?? 'direct';
  return `prompt_${tag}_${state.turnNumber}_${ctx.currentStepIndex}_${ctx.steps.length}_${phase}_${playerId}_${state.log.length}`;
}

export function parseSplayDirectionFromText(text: string): Exclude<SplayDirection, 'none'> | null {
  const match = /\bsplay\b[^.]*?\b(left|right|up|aslant|askew)\b/i.exec(text);
  if (!match) return null;
  const raw = match[1].toLowerCase();
  if (raw === 'askew') return 'aslant';
  return raw as Exclude<SplayDirection, 'none'>;
}

export function transferCardFromHandToZone(
  state: GameState,
  fromPlayerId: string,
  toZone: 'hand' | 'score',
  toPlayerId: string,
  cardInstanceId: string
): CardInstance {
  return transferCard(
    state,
    { zone: 'hand', playerId: fromPlayerId },
    { zone: toZone, playerId: toPlayerId },
    cardInstanceId
  );
}

export function recordDemandTransfer(ctx: DogmaExecutionContext, abilityIndex: number): void {
  if (!ctx.demandTransferredByAbility) {
    ctx.demandTransferredByAbility = {};
  }
  ctx.demandTransferredByAbility[abilityIndex] = true;
}

export function recordDemandReturn(ctx: DogmaExecutionContext, abilityIndex: number): void {
  if (!ctx.demandReturnedByAbility) {
    ctx.demandReturnedByAbility = {};
  }
  ctx.demandReturnedByAbility[abilityIndex] = true;
}

export function recordPlayerReturn(ctx: DogmaExecutionContext, playerId: string, count: number): void {
  if (!ctx.returnedByPlayer) {
    ctx.returnedByPlayer = {};
  }
  ctx.returnedByPlayer[playerId] = (ctx.returnedByPlayer[playerId] ?? 0) + count;
}

export function countColorsWithIcon(board: PlayerBoard, icon: FunctionalIcon): number {
  return ALL_COLORS.filter((col) => getStackVisibleIcons(board[col])[icon] > 0).length;
}

export function findCardOwnerBoard(
  state: GameState,
  instanceId: string
): { player: PlayerState; color: CardColor } | null {
  for (const p of state.players) {
    if (p.eliminated) continue;
    for (const col of ALL_COLORS) {
      const stack = p.board[col];
      if (stack.cards.length > 0 && stack.cards[stack.cards.length - 1].instanceId === instanceId) {
        return { player: p, color: col };
      }
    }
  }
  return null;
}

export function pickTopKWithTieSplit(
  cards: readonly CardInstance[],
  k: number
): { auto: CardInstance[]; tied: CardInstance[]; needFromTied: number } {
  if (cards.length <= k) {
    return { auto: [...cards], tied: [], needFromTied: 0 };
  }
  const sorted = [...cards].sort((a, b) => b.age - a.age);
  const cutoffAge = sorted[k - 1].age;
  const auto = sorted.filter((c) => c.age > cutoffAge);
  const tied = sorted.filter((c) => c.age === cutoffAge);
  const remaining = k - auto.length;
  if (tied.length === remaining) {
    return { auto: [...auto, ...tied], tied: [], needFromTied: 0 };
  }
  return { auto, tied, needFromTied: remaining };
}

export function getSingleExtremePlayer(
  state: GameState,
  metricFn: (p: PlayerState) => number,
  mode: 'max' | 'min'
): PlayerState | null {
  const active = state.players.filter((p) => !p.eliminated);
  if (active.length === 0) return null;
  const values = active.map((p) => ({ p, val: metricFn(p) }));
  const targetVal =
    mode === 'max'
      ? Math.max(...values.map((v) => v.val))
      : Math.min(...values.map((v) => v.val));
  const winners = values.filter((v) => v.val === targetVal);
  return winners.length === 1 ? winners[0].p : null;
}

export function junkAllNonAchievementCards(state: GameState): number {
  let count = 0;
  for (const p of state.players) {
    for (const c of p.hand) {
      junkCardInstance(state, c);
      count += 1;
    }
    p.hand = [];
    for (const c of p.scorePile) {
      junkCardInstance(state, c);
      count += 1;
    }
    p.scorePile = [];
    for (const col of ALL_COLORS) {
      for (const c of p.board[col].cards) {
        junkCardInstance(state, c);
        count += 1;
      }
      p.board[col] = { color: col, cards: [], splay: 'none' };
    }
  }
  return count;
}

export function promptSplayColor(
  state: GameState,
  ctx: DogmaExecutionContext,
  execPlayer: PlayerState,
  isDemand: boolean,
  ability: CardAbility,
  splayDir: Exclude<SplayDirection, 'none'>,
  cardName?: string,
  allowedColors: readonly CardColor[] = ALL_COLORS,
  requiredCurrentSplay?: SplayDirection,
  subState?: DogmaSubState
): DogmaStepOutcome {
  const dirLabel = splayDir === 'aslant' ? 'askew' : splayDir;
  const eligibleColors = allowedColors.filter((color) => {
    const stack = execPlayer.board[color];
    if (!canSplayStack(stack, splayDir)) return false;
    if (requiredCurrentSplay !== undefined && stack.splay !== requiredCurrentSplay) return false;
    return true;
  });
  if (eligibleColors.length === 0) {
    logStep(state, ctx, execPlayer.id, isDemand, `No eligible stack to splay ${dirLabel}.`);
    return 'completed';
  }
  const isOptional = /\bmay\b/i.test(ability.text);
  const isSharing = execPlayer.id !== ctx.activatingPlayerId && !isDemand;
  if (!isOptional && eligibleColors.length === 1) {
    const changed = splayPlayerColor(
      state,
      execPlayer.id,
      eligibleColors[0],
      splayDir,
      isSharing ? 'Share' : 'Dogma',
      ctx.parentLogId
    );
    recordChange(ctx, execPlayer.id, isDemand, changed);
    return 'completed';
  }
  if (subState) {
    ctx.subState = subState;
  }
  const displayCard = cardName ?? ctx.sourceCardName;
  state.pendingPrompts.push({
    id: makePromptId(state, ctx, 'splay', execPlayer.id),
    kind: 'choose_color',
    playerId: execPlayer.id,
    title: isSharing ? `Share (${displayCard})` : `Dogma (${displayCard})`,
    subtitle: ability.text,
    options: eligibleColors,
    allowSkip: isOptional,
    skipLabel: isOptional ? "Don't Splay" : undefined,
    splayDirection: splayDir,
  });
  return 'awaiting_prompt';
}

/**
 * Self-executes `targetCard` by checking the Chain Rule if already inside a self-execute,
 * then splicing `targetCard`'s non-demand abilities into `ctx.steps` immediately after the
 * current step so all interactive prompts resolve cleanly.
 */
export function enqueueSelfExecute(
  state: GameState,
  ctx: DogmaExecutionContext,
  execPlayer: PlayerState,
  targetCard: CardInstance
): boolean {
  const currentDepth = ctx.steps[ctx.currentStepIndex]?.selfExecuteDepth ?? ctx.selfExecuteDepth ?? 0;
  ctx.selfExecuteDepth = currentDepth;
  const ended = triggerChainRuleIfNested(state, execPlayer.id, ctx);
  if (ended || state.phase === 'gameover') {
    return true;
  }
  const nonDemands = targetCard.abilities.filter((a) => !a.isDemand);
  if (nonDemands.length === 0) {
    logStep(
      state,
      ctx,
      execPlayer.id,
      false,
      `Self-executed ${targetCard.name} [${targetCard.age}] (no non-demand abilities).`
    );
    return false;
  }
  logStep(
    state,
    ctx,
    execPlayer.id,
    false,
    `Self-executing ${targetCard.name} [${targetCard.age}]...`
  );
  const newSteps = nonDemands.map((ab) => ({
    abilityIndex: ab.index,
    executingPlayerId: execPlayer.id,
    isDemand: false,
    sourceCardDefId: targetCard.defId,
    sourceCardName: targetCard.name,
    sourceAbility: { ...ab },
    selfExecuteDepth: currentDepth + 1,
  }));
  ctx.steps.splice(ctx.currentStepIndex + 1, 0, ...newSteps);
  return false;
}

/**
 * Melds or tucks multiple already-removed cards. If >= 2 share a color, pushes a `choose_order`
 * prompt so the player decides which card ends up on top (or bottom for tuck).
 */
export function applyMultiZoneWithOrderCheck(
  state: GameState,
  ctx: DogmaExecutionContext,
  execPlayer: PlayerState,
  isDemand: boolean,
  cardsToPlace: CardInstance[],
  mode: 'meld' | 'tuck',
  cardLabel: string
): DogmaStepOutcome {
  if (cardsToPlace.length === 0) {
    return 'completed';
  }
  // Group remaining cards by color
  const byColor = new Map<CardColor, CardInstance[]>();
  for (const c of cardsToPlace) {
    const arr = byColor.get(c.color) ?? [];
    arr.push(c);
    byColor.set(c.color, arr);
  }

  const remainingMulti: CardInstance[] = [];
  let firstMultiColor: CardColor | null = null;
  const placedNames: string[] = [];

  for (const [color, group] of byColor.entries()) {
    if (group.length === 1 || firstMultiColor !== null) {
      if (group.length === 1) {
        if (mode === 'meld') meldCardInstance(state, execPlayer.id, group[0]);
        else tuckCardInstance(state, execPlayer.id, group[0]);
        placedNames.push(`${group[0].name} [${group[0].age}]`);
      } else {
        remainingMulti.push(...group);
      }
    } else {
      firstMultiColor = color;
      remainingMulti.push(...group);
    }
  }

  if (placedNames.length > 0) {
    recordChange(ctx, execPlayer.id, isDemand, true);
    logStep(
      state,
      ctx,
      execPlayer.id,
      isDemand,
      `${mode === 'meld' ? 'Melded' : 'Tucked'} ${placedNames.join(', ')}.`
    );
  }

  if (firstMultiColor !== null) {
    const currentBatch = remainingMulti.filter((c) => c.color === firstMultiColor);
    const tailCards = remainingMulti.filter((c) => c.color !== firstMultiColor);
    ctx.subState = {
      phase: mode === 'meld' ? 'multi_meld_order' : 'multi_tuck_order',
      chosenColor: firstMultiColor,
      tempCards: tailCards,
    };
    state.pendingPrompts.push({
      id: makePromptId(state, ctx, `order_${mode}`, execPlayer.id),
      kind: 'choose_order',
      playerId: execPlayer.id,
      title: `${cardLabel}: Order ${firstMultiColor} cards to ${mode} (last = ${
        mode === 'meld' ? 'top' : 'furthest bottom'
      })`,
      cards: currentBatch,
    });
    return 'awaiting_prompt';
  }

  return 'completed';
}

export function resolveMultiOrderPrompt(
  state: GameState,
  ctx: DogmaExecutionContext,
  prompt: Extract<NonNullable<GameState['pendingPrompts'][number]>, { kind: 'choose_order' }>,
  action: Extract<TurnAction, { type: 'answer_prompt' }>,
  execPlayer: PlayerState,
  isDemand: boolean,
  mode: 'meld' | 'tuck',
  tailCards: CardInstance[],
  cardLabel: string
): DogmaStepOutcome {
  const orderedIds = action.orderedCardIds ?? [];
  const cardMap = new Map(prompt.cards.map((c) => [c.instanceId, c]));
  if (orderedIds.length !== prompt.cards.length || !orderedIds.every((id) => cardMap.has(id))) {
    throw new Error('Invalid card order provided.');
  }
  const names: string[] = [];
  for (const id of orderedIds) {
    const c = cardMap.get(id)!;
    if (mode === 'meld') meldCardInstance(state, execPlayer.id, c);
    else tuckCardInstance(state, execPlayer.id, c);
    names.push(`${c.name} [${c.age}]`);
  }
  recordChange(ctx, execPlayer.id, isDemand, names.length > 0);
  logStep(
    state,
    ctx,
    execPlayer.id,
    isDemand,
    `${mode === 'meld' ? 'Melded' : 'Tucked'} in order: ${names.join(', ')}.`
  );
  if (tailCards.length > 0) {
    return applyMultiZoneWithOrderCheck(state, ctx, execPlayer, isDemand, tailCards, mode, cardLabel);
  }
  return 'completed';
}

export function validateChooseCardsSelection(
  prompt: Extract<NonNullable<GameState['pendingPrompts'][number]>, { kind: 'choose_cards' }>,
  selectedIds: string[]
): void {
  const uniqueIds = Array.from(new Set(selectedIds));
  if (uniqueIds.length !== selectedIds.length) {
    throw new Error('Duplicate card IDs selected.');
  }
  for (const cid of uniqueIds) {
    if (!prompt.candidates.some((c) => c.instanceId === cid)) {
      throw new Error(`Invalid card selection: ${cid}`);
    }
  }
  const isSkipZero = prompt.allowSkip && uniqueIds.length === 0;
  if (!isSkipZero && (uniqueIds.length < prompt.min || uniqueIds.length > prompt.max)) {
    throw new Error(`Expected between ${prompt.min} and ${prompt.max} cards, got ${uniqueIds.length}.`);
  }
}

export function clearBoardColor(state: GameState, player: PlayerState, color: CardColor): number {
  const stack = player.board[color];
  const count = stack.cards.length;
  for (const c of stack.cards) {
    state.decks[c.age].push(c);
  }
  player.board[color] = { color, cards: [], splay: 'none' };
  return count;
}

export function removeScoreCardsByAge(player: PlayerState, age: number): CardInstance[] {
  const matching = player.scorePile.filter((c) => c.age === age);
  const removed: CardInstance[] = [];
  for (const c of matching) {
    removed.push(removeCardFromScore(player, c.instanceId));
  }
  return removed;
}

export function removeHandCardsByAge(player: PlayerState, age: number): CardInstance[] {
  const matching = player.hand.filter((c) => c.age === age);
  const removed: CardInstance[] = [];
  for (const c of matching) {
    removed.push(removeCardFromHand(player, c.instanceId));
  }
  return removed;
}

export function normalizePlayerStack(player: PlayerState, color: CardColor): void {
  player.board[color] = normalizeStackSplay(player.board[color]);
}

export function drawMultiple(
  state: GameState,
  playerId: string,
  count: number,
  age: number,
  destination: 'hand' | 'meld' | 'tuck' | 'score' | 'reveal_hand'
): { drawn: CardInstance[]; gameEnded: boolean } {
  const drawn: CardInstance[] = [];
  for (let i = 0; i < count; i++) {
    const res = drawCardFromAge(state, playerId, age, destination);
    if (res.gameEnded) {
      return { drawn, gameEnded: true };
    }
    if (res.card) drawn.push(res.card);
  }
  return { drawn, gameEnded: false };
}
