import test from 'node:test';
import assert from 'node:assert/strict';

import { chooseAIAction } from './ai';
import { ALL_AGES } from './constants';
import { debugTakeAnyCard, debugTriggerEndGame } from './debug';
import {
  applyAction,
  createGame,
  getEligibleAchievementAges,
  setManualEndTurn,
} from './engine';
import {
  appendLog,
  checkSpecialAchievementsAtActionEnd,
  createDogmaContext,
  drawCardFromAge,
  eliminatePlayer,
  exchangeCards,
  getPlayer,
  junkDeck,
  junkStandardAchievementByAge,
  meldCardInstance,
  removeBottomCardFromBoard,
  removeTopCardFromBoard,
  returnCardInstance,
  scoreCardInstance,
  splayPlayerColor,
  transferCard,
  triggerChainRuleIfNested,
  tuckCardInstance,
} from './keywords';
import { projectPlayerView } from './playerView';
import { getExposedSlots, getHighestTopCardAge, getVisibleIconCounts } from './splay';
import { AVAILABLE_DATABASE_AGES, BASE_CARD_DATABASE, instantiateCard } from '../data/cards/catalog';
import { deserializeGameState, serializeGameState } from './storage';
import type {
  AIDecisionTrace,
  CardColor,
  CardInstance,
  DogmaExecutionContext,
  FunctionalIcon,
  GameState,
} from './types';

type AbilityResolver = (args: {
  state: GameState;
  executingPlayerId: string;
  activatingPlayerId: string;
  abilityIndex: number;
  isDemand: boolean;
  dogmaContext: DogmaExecutionContext;
}) => { cardChanged: boolean };

function isGameOver(state: GameState): boolean {
  return state.phase === 'gameover';
}

function runDogmaAction(
  state: GameState,
  activatingPlayerId: string,
  card: CardInstance,
  resolver: AbilityResolver
): void {
  const ctx = createDogmaContext(state, activatingPlayerId, card);
  state.activeDogma = ctx;

  for (const ability of ctx.lockedAbilities) {
    if (isGameOver(state)) break;

    if (ability.isDemand) {
      for (const oppId of ctx.vulnerableToDemandIds) {
        if (isGameOver(state)) break;
        const opp = getPlayer(state, oppId);
        if (opp.eliminated) continue;
        resolver({
          state,
          executingPlayerId: oppId,
          activatingPlayerId,
          abilityIndex: ability.index,
          isDemand: true,
          dogmaContext: ctx,
        });
      }
    } else {
      for (const oppId of ctx.eligibleToShareIds) {
        if (isGameOver(state)) break;
        const opp = getPlayer(state, oppId);
        if (opp.eliminated) continue;
        const res = resolver({
          state,
          executingPlayerId: oppId,
          activatingPlayerId,
          abilityIndex: ability.index,
          isDemand: false,
          dogmaContext: ctx,
        });
        if (res.cardChanged && !ctx.teammateIds?.includes(oppId)) {
          ctx.anyOpponentSharedCardChange = true;
        }
      }
      if (!isGameOver(state)) {
        resolver({
          state,
          executingPlayerId: activatingPlayerId,
          activatingPlayerId,
          abilityIndex: ability.index,
          isDemand: false,
          dogmaContext: ctx,
        });
      }
    }
  }

  if (!isGameOver(state) && ctx.anyOpponentSharedCardChange) {
    const actor = getPlayer(state, activatingPlayerId);
    const highest = getHighestTopCardAge(actor.board);
    const drawRes = drawCardFromAge(state, activatingPlayerId, highest, 'hand');
    if (!drawRes.gameEnded && drawRes.card) {
      appendLog(
        state,
        activatingPlayerId,
        `Took a free Draw action (Age ${drawRes.drawnFromAge}) from Dogma sharing.`,
        'Free Draw'
      );
    }
  }

  state.activeDogma = null;
}

function runSelfExecute(
  state: GameState,
  playerId: string,
  targetCard: CardInstance,
  dogmaCtx: DogmaExecutionContext,
  resolver: AbilityResolver
): void {
  const ended = triggerChainRuleIfNested(state, playerId, dogmaCtx);
  if (ended || isGameOver(state)) return;

  dogmaCtx.selfExecuteDepth += 1;
  try {
    for (const ability of targetCard.abilities) {
      if (isGameOver(state)) break;
      if (ability.isDemand) continue;
      resolver({
        state,
        executingPlayerId: playerId,
        activatingPlayerId: playerId,
        abilityIndex: ability.index,
        isDemand: false,
        dogmaContext: dogmaCtx,
      });
    }
  } finally {
    dogmaCtx.selfExecuteDepth -= 1;
  }
}

function makeTestCard(
  id: string,
  age: CardInstance['age'],
  color: CardColor,
  name: string,
  icons: CardInstance['icons'],
  abilities: CardInstance['abilities'] = []
): CardInstance {
  const counts = new Map<FunctionalIcon, number>();
  for (const k of ['tl', 'bl', 'bc', 'br'] as const) {
    const v = icons[k];
    if (v !== 'hexagon') counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let featuredIcon: FunctionalIcon = 'tower';
  let max = -1;
  for (const [icon, count] of counts.entries()) {
    if (count > max) {
      max = count;
      featuredIcon = icon;
    }
  }
  return {
    instanceId: id,
    defId: id,
    age,
    set: 'base',
    name,
    color,
    icons,
    featuredIcon,
    abilities,
    isPlaceholder: false,
  };
}

test('complete base card catalog contains 15 cards in Age 1 and 10 in Ages 2-11 sorted B001-B115', () => {
  assert.equal(BASE_CARD_DATABASE.filter((c) => c.age === 1).length, 15);
  for (const age of ALL_AGES) {
    if (age === 1) continue;
    assert.equal(BASE_CARD_DATABASE.filter((c) => c.age === age).length, 10, `Age ${age} should have 10 cards`);
  }
  assert.equal(BASE_CARD_DATABASE.length, 115);
  for (let i = 0; i < 115; i++) {
    const expectedId = `B${String(i + 1).padStart(3, '0')}`;
    assert.equal(BASE_CARD_DATABASE[i].id, expectedId);
    assert.equal(BASE_CARD_DATABASE[i].isPlaceholder, false);
  }
});

test('setup creates 11 decks, 10 standard achievements (ages 1-10), alphabetical first player, and 1-action turn 1', () => {
  const state0 = createGame({
    variant: '1v1',
    controlMode: 'vs_ai',
    playerNames: ['Alice', 'Bot'],
    seed: 42,
  });

  assert.equal(state0.phase, 'setup');
  assert.equal(state0.achievementTarget, 6);
  assert.equal(state0.standardAchievements.length, 10);
  assert.deepEqual(
    state0.standardAchievements.map((c) => c.age),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  );
  // Age 11 still has all 10 cards
  assert.equal(state0.decks[11].length, 10);
  // Age 1 had 15 - 1 (achievement) - 4 (2 per player) = 10 remaining
  assert.equal(state0.decks[1].length, 10);

  let state = applyAction(state0, {
    type: 'setup_meld',
    playerId: 'p1',
    cardInstanceId: state0.players[0].hand[0].instanceId,
  });
  assert.equal(state.phase, 'setup');

  state = applyAction(state, {
    type: 'setup_meld',
    playerId: 'p2',
    cardInstanceId: state.players[1].hand[0].instanceId,
  });
  assert.equal(state.phase, 'playing');
  assert.equal(state.actionsRemaining, 1);

  // Verify alphabetical first player
  const p1Top = Object.values(state.players[0].board).flatMap((s) => s.cards)[0].name;
  const p2Top = Object.values(state.players[1].board).flatMap((s) => s.cards)[0].name;
  const expectedFirstIdx = p1Top.localeCompare(p2Top) <= 0 ? 0 : 1;
  assert.equal(state.currentPlayerIndex, expectedFirstIdx);

  // Verify Setup log entries carry 'Setup' actionTag
  assert.ok(state.log.some((e) => e.actionTag === 'Setup'));

  // After 1 action on opening turn, turn advances to other player with 2 actions
  state = applyAction(state, { type: 'draw', playerId: state.players[state.currentPlayerIndex].id });
  assert.equal(state.currentPlayerIndex, expectedFirstIdx === 0 ? 1 : 0);
  assert.equal(state.actionsRemaining, 2);
  assert.equal(state.actionsTotalThisTurn, 2);

  // Perform 2 actions on Turn 2 and verify Action 1 & Action 2 grouping tags
  const secondPlayerId = state.players[state.currentPlayerIndex].id;
  state = applyAction(state, { type: 'draw', playerId: secondPlayerId });
  state = applyAction(state, { type: 'draw', playerId: secondPlayerId });
  const turn2Tags = state.log
    .filter((e) => e.turn === 2 && e.actorId === secondPlayerId)
    .map((e) => e.actionTag);
  assert.deepEqual(turn2Tags, ['Action 1', 'Action 2']);
});

test('splaying exposes exact 4th-edition icon slots (including aslant) and resets on <=1 card', () => {
  assert.deepEqual(getExposedSlots('none'), []);
  assert.deepEqual(getExposedSlots('left'), ['br']);
  assert.deepEqual(getExposedSlots('right'), ['tl', 'bl']);
  assert.deepEqual(getExposedSlots('up'), ['bl', 'bc', 'br']);
  assert.deepEqual(getExposedSlots('aslant'), ['tl', 'bl', 'bc', 'br']);

  const state = createGame({
    variant: '1v1',
    controlMode: 'pass_and_play',
    playerNames: ['P1', 'P2'],
    seed: 101,
  });
  const p1 = state.players[0];
  const bottom = makeTestCard('T_BOT', 1, 'blue', 'Bottom', {
    tl: 'tower',
    bl: 'coin',
    bc: 'leaf',
    br: 'clock',
  });
  const top = makeTestCard('T_TOP', 2, 'blue', 'Top', {
    tl: 'hexagon',
    bl: 'persona',
    bc: 'persona',
    br: 'factory',
  });

  meldCardInstance(state, p1.id, bottom);
  // Cannot splay stack of 1
  assert.equal(splayPlayerColor(state, p1.id, 'blue', 'left'), false);

  meldCardInstance(state, p1.id, top);
  // Unsplayed: only top card visible
  let icons = getVisibleIconCounts(p1.board);
  assert.equal(icons.persona, 2);
  assert.equal(icons.factory, 1);
  assert.equal(icons.clock, 0);

  // Left exposes BR (clock)
  assert.equal(splayPlayerColor(state, p1.id, 'blue', 'left'), true);
  assert.equal(splayPlayerColor(state, p1.id, 'blue', 'left'), false); // Cannot splay same direction
  icons = getVisibleIconCounts(p1.board);
  assert.equal(icons.clock, 1);
  assert.equal(icons.tower, 0);

  // Right exposes TL, BL (tower, coin)
  assert.equal(splayPlayerColor(state, p1.id, 'blue', 'right'), true);
  icons = getVisibleIconCounts(p1.board);
  assert.equal(icons.tower, 1);
  assert.equal(icons.coin, 1);
  assert.equal(icons.leaf, 0);
  assert.equal(icons.clock, 0);

  // Up exposes BL, BC, BR (coin, leaf, clock)
  assert.equal(splayPlayerColor(state, p1.id, 'blue', 'up'), true);
  icons = getVisibleIconCounts(p1.board);
  assert.equal(icons.tower, 0);
  assert.equal(icons.coin, 1);
  assert.equal(icons.leaf, 1);
  assert.equal(icons.clock, 1);

  // Aslant exposes all 4 slots (tower, coin, leaf, clock)
  assert.equal(splayPlayerColor(state, p1.id, 'blue', 'aslant'), true);
  icons = getVisibleIconCounts(p1.board);
  assert.equal(icons.tower, 1);
  assert.equal(icons.coin, 1);
  assert.equal(icons.leaf, 1);
  assert.equal(icons.clock, 1);
  assert.equal(icons.persona, 2);
  assert.equal(icons.factory, 1);

  // Reducing stack to 1 resets splay to none
  transferCard(
    state,
    { zone: 'board', playerId: p1.id, color: 'blue' },
    { zone: 'hand', playerId: p1.id },
    top.instanceId
  );
  assert.equal(p1.board.blue.splay, 'none');
});

test('draw with empty board treats level as 0 (draws Age 1), skips empty decks, and Age 12+ triggers score victory', () => {
  const state = createGame({
    variant: '1v1',
    controlMode: 'pass_and_play',
    playerNames: ['P1', 'P2'],
    seed: 7,
  });
  state.phase = 'playing';
  state.pendingPrompts = [];
  state.decks[1] = [instantiateCard(BASE_CARD_DATABASE[0], 'd1')];
  state.decks[2] = [];
  state.decks[3] = [instantiateCard(BASE_CARD_DATABASE[25], 'd3')];

  // Empty board -> draws Age 1
  const r1 = drawCardFromAge(state, 'p1', 0, 'hand');
  assert.equal(r1.drawnFromAge, 1);
  assert.equal(r1.gameEnded, false);

  // Requested Age 2 (empty) -> skips to Age 3
  const r2 = drawCardFromAge(state, 'p1', 2, 'hand');
  assert.equal(r2.drawnFromAge, 3);
  assert.equal(r2.gameEnded, false);

  // Clear ages 4..11 and give p2 higher score; drawing 11 -> skips to 12+ -> p2 wins by score
  for (const age of ALL_AGES) {
    state.decks[age] = [];
  }
  scoreCardInstance(
    state,
    'p2',
    makeTestCard('SC_9', 9, 'red', 'HighScore', { tl: 'tower', bl: 'tower', bc: 'tower', br: 'tower' })
  );
  const r3 = drawCardFromAge(state, 'p1', 11, 'hand');
  assert.equal(r3.gameEnded, true);
  assert.equal(state.phase, 'gameover');
  assert.equal(state.victory?.reason, 'score_age12');
  assert.deepEqual(state.victory?.winnerPlayerIds, ['p2']);
});

test('1v1v1 uses 5-achievement victory target and achieve does not spend score pile', () => {
  const state0 = createGame({
    variant: '1v1v1',
    controlMode: 'pass_and_play',
    playerNames: ['A', 'B', 'C'],
    seed: 9,
  });
  assert.equal(state0.achievementTarget, 5);
  state0.phase = 'playing';
  state0.pendingPrompts = [];
  state0.currentPlayerIndex = 0;
  state0.actionsRemaining = 2;

  const p1 = state0.players[0];
  meldCardInstance(
    state0,
    p1.id,
    makeTestCard('TOP3', 3, 'yellow', 'Top3', { tl: 'leaf', bl: 'leaf', bc: 'leaf', br: 'hexagon' })
  );
  scoreCardInstance(
    state0,
    p1.id,
    makeTestCard('SC10', 10, 'blue', 'TenPts', { tl: 'lightbulb', bl: 'lightbulb', bc: 'lightbulb', br: 'hexagon' })
  );

  const eligible = getEligibleAchievementAges(state0, p1.id);
  assert.deepEqual(eligible, [1, 2]); // 10 pts covers age 1 (5) and age 2 (10), top card is 3

  const afterAchieve = applyAction(state0, { type: 'achieve', playerId: 'p1', age: 2 });
  assert.equal(afterAchieve.players[0].achievements.length, 1);
  assert.equal(afterAchieve.players[0].scorePile.length, 1); // Score not spent

  // Verify 20 points with highest top card Age 2 allows ONLY Age 1 and Age 2 (not 3 or 4)
  const state20 = createGame({
    variant: '1v1',
    controlMode: 'pass_and_play',
    playerNames: ['P1', 'P2'],
    seed: 10,
  });
  state20.phase = 'playing';
  state20.pendingPrompts = [];
  meldCardInstance(
    state20,
    'p1',
    makeTestCard('TOP2_A', 2, 'red', 'Top2A', { tl: 'tower', bl: 'tower', bc: 'tower', br: 'hexagon' })
  );
  scoreCardInstance(
    state20,
    'p1',
    makeTestCard('SC10_A', 10, 'blue', 'TenA', { tl: 'lightbulb', bl: 'lightbulb', bc: 'lightbulb', br: 'hexagon' })
  );
  scoreCardInstance(
    state20,
    'p1',
    makeTestCard('SC10_B', 10, 'green', 'TenB', { tl: 'leaf', bl: 'leaf', bc: 'leaf', br: 'hexagon' })
  );
  assert.deepEqual(getEligibleAchievementAges(state20, 'p1'), [1, 2]);

  // Raising highest top card to Age 4 unlocks Ages 3 and 4 as well
  meldCardInstance(
    state20,
    'p1',
    makeTestCard('TOP4_A', 4, 'red', 'Top4A', { tl: 'factory', bl: 'factory', bc: 'factory', br: 'hexagon' })
  );
  assert.deepEqual(getEligibleAchievementAges(state20, 'p1'), [1, 2, 3, 4]);
});

test('special achievements check 4th-edition rules and resolve clockwise ties from current player left', () => {
  const state = createGame({
    variant: '1v1',
    controlMode: 'pass_and_play',
    playerNames: ['Active', 'LeftPlayer'],
    seed: 12,
  });
  state.phase = 'playing';
  state.pendingPrompts = [];
  state.currentPlayerIndex = 0; // Active

  // Give both players 4 top cards with a DEMAND effect (Monument)
  const demandAbility = [{ index: 1, icon: 'tower' as const, isDemand: true, text: 'I DEMAND...' }];
  for (const player of state.players) {
    for (const color of ['red', 'yellow', 'green', 'blue'] as CardColor[]) {
      meldCardInstance(
        state,
        player.id,
        makeTestCard(
          `${player.id}_${color}`,
          1,
          color,
          `Card_${color}`,
          { tl: 'tower', bl: 'tower', bc: 'hexagon', br: 'tower' },
          demandAbility
        )
      );
    }
  }

  checkSpecialAchievementsAtActionEnd(state);
  // LeftPlayer (clockwise from Active's left) claims Monument first
  assert.equal(state.players[1].achievements.some((a) => a.specialId === 'monument'), true);
  assert.equal(state.players[0].achievements.some((a) => a.specialId === 'monument'), false);
});

test('junk, return, tuck, exchange, and eliminatePlayer behave per 4th-edition rules', () => {
  const state = createGame({
    variant: '1v1v1',
    controlMode: 'pass_and_play',
    playerNames: ['P1', 'P2', 'P3'],
    seed: 19,
  });
  state.phase = 'playing';
  state.pendingPrompts = [];

  const age4Count = state.decks[4].length;
  const junkedCount = junkDeck(state, 4);
  assert.equal(junkedCount, age4Count);
  assert.equal(state.decks[4].length, 0);
  assert.equal(state.junk.length, age4Count);

  const std1 = junkStandardAchievementByAge(state, 1);
  assert.equal(std1?.age, 1);
  assert.equal(state.standardAchievements.some((c) => c.age === 1), false);

  const p1 = state.players[0];
  const cTop = makeTestCard('C_TOP', 2, 'red', 'TopRed', { tl: 'tower', bl: 'tower', bc: 'hexagon', br: 'tower' });
  const cBot = makeTestCard('C_BOT', 1, 'red', 'BotRed', { tl: 'tower', bl: 'hexagon', bc: 'tower', br: 'tower' });
  meldCardInstance(state, 'p1', cTop);
  tuckCardInstance(state, 'p1', cBot);
  assert.equal(p1.board.red.cards[0].instanceId, 'C_BOT');
  assert.equal(p1.board.red.cards[1].instanceId, 'C_TOP');

  // Exchange even when one side is empty
  p1.hand = [makeTestCard('H1', 3, 'green', 'H1', { tl: 'leaf', bl: 'leaf', bc: 'hexagon', br: 'leaf' })];
  p1.scorePile = [];
  exchangeCards(state, { zone: 'hand', playerId: 'p1' }, ['H1'], { zone: 'score', playerId: 'p1' }, []);
  assert.equal(p1.hand.length, 0);
  assert.equal(p1.scorePile.length, 1);

  returnCardInstance(state, p1.scorePile.pop()!);
  assert.equal(state.decks[3][state.decks[3].length - 1].instanceId, 'H1');

  // Eliminate P2 and P3 -> P1 wins immediately
  eliminatePlayer(state, 'p2');
  assert.equal(state.phase, 'playing');
  eliminatePlayer(state, 'p3');
  assert.equal(state.phase, 'gameover');
  assert.equal(state.victory?.reason, 'elimination');
  assert.deepEqual(state.victory?.winnerPlayerIds, ['p1']);
});

test('Dogma Locking In, Sharing Free Draw (excluding reveal-only), and Chain Rule work accurately', () => {
  const state = createGame({
    variant: '1v1',
    controlMode: 'pass_and_play',
    playerNames: ['P1', 'P2'],
    seed: 33,
  });
  state.phase = 'playing';
  state.pendingPrompts = [];

  const card1 = makeTestCard(
    'CARD1',
    1,
    'blue',
    'Card1',
    { tl: 'lightbulb', bl: 'lightbulb', bc: 'lightbulb', br: 'hexagon' },
    [
      { index: 1, icon: 'lightbulb', isDemand: false, text: 'Effect 1' },
      { index: 2, icon: 'lightbulb', isDemand: false, text: 'Effect 2' },
    ]
  );
  const card2 = makeTestCard(
    'CARD2',
    2,
    'purple',
    'Card2',
    { tl: 'lightbulb', bl: 'lightbulb', bc: 'lightbulb', br: 'hexagon' },
    [{ index: 1, icon: 'lightbulb', isDemand: false, text: 'Self-exec target' }]
  );
  const card3 = makeTestCard(
    'CARD3',
    3,
    'green',
    'Card3',
    { tl: 'leaf', bl: 'leaf', bc: 'leaf', br: 'hexagon' },
    [{ index: 1, icon: 'leaf', isDemand: false, text: 'Nested self-exec target' }]
  );

  meldCardInstance(state, 'p1', card1);
  meldCardInstance(state, 'p2', card2); // P2 has 3 lightbulbs -> eligible to share!

  const initialP1Hand = state.players[0].hand.length;
  const executedEffects: number[] = [];

  // Case A: Opponent only reveals (cardChanged: false) -> NO free draw
  runDogmaAction(state, 'p1', card1, ({ executingPlayerId, abilityIndex }) => {
    if (executingPlayerId === 'p1') executedEffects.push(abilityIndex);
    // Simulate card1 getting covered mid-effect 1; effect 2 must still run (Locking In)
    if (executingPlayerId === 'p1' && abilityIndex === 1) {
      meldCardInstance(state, 'p1', card3);
    }
    return { cardChanged: false };
  });
  assert.deepEqual(executedEffects, [1, 2]);
  assert.equal(state.players[0].hand.length, initialP1Hand); // No free draw on reveal-only

  // Case B: Opponent triggers card change AND nested self-execute triggers Chain Rule
  const p1AchsBefore = state.players[0].achievements.length;
  const age11Before = state.decks[11].length;
  runDogmaAction(state, 'p1', card1, ({ executingPlayerId, abilityIndex, dogmaContext }) => {
    if (executingPlayerId === 'p2' && abilityIndex === 1) {
      return { cardChanged: true };
    }
    if (executingPlayerId === 'p1' && abilityIndex === 1) {
      runSelfExecute(state, 'p1', card2, dogmaContext, ({ dogmaContext: innerCtx }) => {
        runSelfExecute(state, 'p1', card3, innerCtx, () => ({ cardChanged: true }));
        return { cardChanged: true };
      });
    }
    return { cardChanged: false };
  });

  // P1 got 1 free Draw action from sharing + 1 Chain Achievement from nested self-execute!
  assert.equal(state.players[0].hand.length, initialP1Hand + 1);
  assert.equal(state.players[0].achievements.length, p1AchsBefore + 1);
  assert.equal(state.players[0].achievements.some((a) => a.kind === 'chain' && a.age === 11), true);
  assert.equal(state.decks[11].length, age11Before - 1);
});

test('PlayerView hides all unrevealed fronts so AI cannot cheat', () => {
  const stateA = createGame({
    variant: '1v1',
    controlMode: 'vs_ai',
    playerNames: ['Human', 'AI Bot'],
    seed: 55,
  });
  const stateB = createGame({
    variant: '1v1',
    controlMode: 'vs_ai',
    playerNames: ['Human', 'AI Bot'],
    seed: 55,
  });

  // Mutate hidden opponent hand card name/color/icons while preserving age/set/instanceId
  stateB.players[0].hand[0] = {
    ...stateB.players[0].hand[0],
    name: 'SECRET_CARD_X',
    color: 'purple',
    defId: 'SECRET_X',
  };
  // Reverse hidden deck 5 order
  stateB.decks[5] = [...stateB.decks[5]].reverse();

  const viewA = projectPlayerView(stateA, 'p2');
  const viewB = projectPlayerView(stateB, 'p2');

  assert.deepEqual(viewA, viewB);
  assert.equal(JSON.stringify(viewB).includes('SECRET_CARD_X'), false);
});

test('Full 1v1 and 1v1v1 AI matches run deterministically and round-trip through save state', () => {
  for (const variant of ['1v1', '1v1v1'] as const) {
    let state = createGame({
      variant,
      controlMode: 'vs_ai',
      playerNames: variant === '1v1' ? ['AI-1', 'AI-2'] : ['AI-1', 'AI-2', 'AI-3'],
      seed: 2026,
    });

    // Resolve setup prompts using only PlayerView
    while (state.phase === 'setup') {
      const pid = state.pendingPrompts[0].playerId;
      const view = projectPlayerView(state, pid);
      const action = chooseAIAction(view);
      state = applyAction(state, action);
    }

    // Play 30 steps deterministically, testing save/load mid-match
    for (let step = 0; step < 30 && state.phase === 'playing'; step++) {
      const actorId = state.pendingPrompts[0]?.playerId ?? state.players[state.currentPlayerIndex].id;
      const view = projectPlayerView(state, actorId);
      const action = chooseAIAction(view);
      state = applyAction(state, action);
      if (step === 10) {
        const serialized = serializeGameState(state);
        state = deserializeGameState(serialized);
      }
    }

    assert.ok(state.turnNumber >= 5);
    assert.ok(state.log.length >= 15);
  }
});

test('Real Age 1 sharing Dogma and Age 3 splay Dogma obey sharing order and free draw rules', () => {
  // Test B012 Writing ("Draw a [2].") with sharing opponent (>= icons) -> opponent draws first, actor draws + gets free Draw!
  const state1 = createGame({
    variant: '1v1',
    controlMode: 'pass_and_play',
    playerNames: ['P1', 'P2'],
    seed: 500,
  });
  state1.phase = 'playing';
  state1.pendingPrompts = [];
  state1.currentPlayerIndex = 0;
  state1.actionsRemaining = 2;

  const writingDef = BASE_CARD_DATABASE.find((c) => c.id === 'B012')!;
  const p1Writing = instantiateCard(writingDef, 'test_p1');
  const p2SameIcons = makeTestCard('P2_EQ', 1, 'purple', 'P2Eq', p1Writing.icons, p1Writing.abilities);
  meldCardInstance(state1, 'p1', p1Writing);
  meldCardInstance(state1, 'p2', p2SameIcons);

  const p1HandBefore = state1.players[0].hand.length;
  const p2HandBefore = state1.players[1].hand.length;
  const afterAge1Dogma = applyAction(state1, { type: 'dogma', playerId: 'p1', color: p1Writing.color });
  // P2 shared -> +1 card; P1 executed -> +1 card + 1 free Draw -> +2 cards
  assert.equal(afterAge1Dogma.players[1].hand.length, p2HandBefore + 1);
  assert.equal(afterAge1Dogma.players[0].hand.length, p1HandBefore + 2);

  // Test Age 3 "You may splay right..." prompt order: sharing opponent decides BEFORE activating player!
  let state3 = createGame({
    variant: '1v1',
    controlMode: 'pass_and_play',
    playerNames: ['P1', 'P2'],
    seed: 700,
  });
  state3.phase = 'playing';
  state3.pendingPrompts = [];
  state3.currentPlayerIndex = 0;
  state3.actionsRemaining = 2;
  state3.actionsTotalThisTurn = 2;

  const splayRightCard = makeTestCard(
    'AGE3_SPLAY',
    3,
    'purple',
    'SplayRightDebug',
    { tl: 'lightbulb', bl: 'lightbulb', bc: 'lightbulb', br: 'hexagon' },
    [{ index: 1, icon: 'lightbulb', isDemand: false, text: 'You may splay right any color of your cards.' }]
  );
  // Give P1 2 purple cards (top = splayRightCard, 3 lightbulbs) and P2 2 blue cards (3 lightbulbs -> shares!)
  meldCardInstance(state3, 'p1', makeTestCard('P1_BOT', 1, 'purple', 'Bot', { tl: 'tower', bl: 'tower', bc: 'tower', br: 'hexagon' }));
  meldCardInstance(state3, 'p1', splayRightCard);
  meldCardInstance(state3, 'p2', makeTestCard('P2_BOT', 1, 'blue', 'P2Bot', { tl: 'tower', bl: 'tower', bc: 'tower', br: 'hexagon' }));
  meldCardInstance(state3, 'p2', makeTestCard('P2_TOP', 2, 'blue', 'P2Top', { tl: 'lightbulb', bl: 'lightbulb', bc: 'lightbulb', br: 'hexagon' }));

  const p1HandBefore3 = state3.players[0].hand.length;
  state3 = applyAction(state3, { type: 'dogma', playerId: 'p1', color: 'purple' });
  // P2 shares first!
  assert.equal(state3.pendingPrompts.length, 1);
  assert.equal(state3.pendingPrompts[0].playerId, 'p2');
  assert.equal(state3.pendingPrompts[0].kind, 'choose_color');

  // Case A: P2 declines to splay -> P1 is prompted next -> no free Draw!
  let declinedState = applyAction(state3, {
    type: 'answer_prompt',
    playerId: 'p2',
    promptId: state3.pendingPrompts[0].id,
  });
  assert.equal(declinedState.pendingPrompts[0].playerId, 'p1');
  declinedState = applyAction(declinedState, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: declinedState.pendingPrompts[0].id,
    selectedColor: 'purple',
  });
  assert.equal(declinedState.players[0].board.purple.splay, 'right');
  assert.equal(declinedState.players[1].board.blue.splay, 'none');
  assert.equal(declinedState.players[0].hand.length, p1HandBefore3); // No free Draw because P2 declined

  // Case B: P2 splays blue right -> P1 prompted next -> P1 ALSO gets 1 free Draw!
  let acceptedState = applyAction(state3, {
    type: 'answer_prompt',
    playerId: 'p2',
    promptId: state3.pendingPrompts[0].id,
    selectedColor: 'blue',
  });
  assert.equal(acceptedState.players[1].board.blue.splay, 'right');
  assert.equal(acceptedState.pendingPrompts[0].playerId, 'p1');
  acceptedState = applyAction(acceptedState, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: acceptedState.pendingPrompts[0].id,
    selectedColor: 'purple',
  });
  assert.equal(acceptedState.players[0].board.purple.splay, 'right');
  assert.equal(acceptedState.players[0].hand.length, p1HandBefore3 + 1); // Free Draw granted!

  // Verify Dogma results carry parentLogId pointing to the Action 1 Activated Dogma log
  const parentLog = acceptedState.log.find(
    (e) => e.actionTag === 'Action 1' && e.message.includes('Activated Dogma on SplayRightDebug')
  );
  assert.ok(parentLog);
  const subResults = acceptedState.log.filter((e) => e.parentLogId === parentLog.id);
  assert.equal(subResults.length, 3); // P2 Share splay, P1 Dogma splay, P1 Free Draw
});

test('splayed pile reset: reducing a splayed stack to 1 card or 0 cards loses splay across all removal paths', () => {
  const state = createGame({
    variant: '1v1',
    controlMode: 'pass_and_play',
    playerNames: ['P1', 'P2'],
    seed: 909,
  });
  const p1 = state.players[0];

  const makeBlue = (id: string) =>
    makeTestCard(id, 1, 'blue', `Blue_${id}`, {
      tl: 'lightbulb',
      bl: 'lightbulb',
      bc: 'hexagon',
      br: 'leaf',
    });

  // Path 1: removeTopCardFromBoard reduces 2 -> 1 -> 0
  meldCardInstance(state, p1.id, makeBlue('B1'));
  meldCardInstance(state, p1.id, makeBlue('B2'));
  assert.equal(splayPlayerColor(state, p1.id, 'blue', 'aslant'), true);
  assert.equal(p1.board.blue.splay, 'aslant');
  removeTopCardFromBoard(p1, 'blue');
  assert.equal(p1.board.blue.cards.length, 1);
  assert.equal(p1.board.blue.splay, 'none');
  removeTopCardFromBoard(p1, 'blue');
  assert.equal(p1.board.blue.cards.length, 0);
  assert.equal(p1.board.blue.splay, 'none');

  // Path 2: removeBottomCardFromBoard reduces 2 -> 1
  meldCardInstance(state, p1.id, makeBlue('B3'));
  meldCardInstance(state, p1.id, makeBlue('B4'));
  assert.equal(splayPlayerColor(state, p1.id, 'blue', 'up'), true);
  assert.equal(p1.board.blue.splay, 'up');
  removeBottomCardFromBoard(p1, 'blue');
  assert.equal(p1.board.blue.cards.length, 1);
  assert.equal(p1.board.blue.splay, 'none');
});

test('card database includes all 115 Base cards (Ages 1-11) with corrected icons and zero placeholders in decks', () => {
  assert.deepEqual(AVAILABLE_DATABASE_AGES, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(BASE_CARD_DATABASE.length, 115);

  const byIdMap = new Map(BASE_CARD_DATABASE.map((c) => [c.id, c]));
  // Verify corrected icons from cards_base.json on B001, B002, B004, B009, B020
  assert.deepEqual(byIdMap.get('B001')?.icons, { tl: 'tower', bl: 'lightbulb', bc: 'hexagon', br: 'tower' });
  assert.deepEqual(byIdMap.get('B002')?.icons, { tl: 'tower', bl: 'tower', bc: 'hexagon', br: 'tower' });
  assert.deepEqual(byIdMap.get('B004')?.icons, { tl: 'hexagon', bl: 'leaf', bc: 'leaf', br: 'leaf' });
  assert.deepEqual(byIdMap.get('B009')?.icons, { tl: 'hexagon', bl: 'tower', bc: 'tower', br: 'tower' });
  assert.deepEqual(byIdMap.get('B020')?.icons, { tl: 'leaf', bl: 'coin', bc: 'hexagon', br: 'coin' });

  for (const card of BASE_CARD_DATABASE) {
    assert.equal(card.isPlaceholder, false);
    assert.equal(card.set, 'base');
    assert.ok(card.abilities.length >= 1, `${card.id} should have abilities`);
    for (const slot of ['tl', 'bl', 'bc', 'br'] as const) {
      assert.ok(card.icons[slot], `Missing icon slot ${slot} on ${card.id}`);
    }
  }

  // Verify gameplay uses real cards across all 11 decks with zero placeholders
  const game = createGame({
    variant: '1v1',
    controlMode: 'vs_ai',
    playerNames: ['P1', 'AI'],
    seed: 123,
  });
  for (const age of ALL_AGES) {
    assert.ok(
      game.decks[age].every((c) => c.set === 'base' && c.isPlaceholder === false),
      `Age ${age} deck must contain only real base cards`
    );
  }
  assert.equal(game.decks[3].length, 9); // 10 - 1 standard achievement
  assert.equal(game.decks[11].length, 10);
});

test('manualEndTurn pauses human turn at 0 actions until end_turn and advances automatically if toggled off', () => {
  let state = createGame({
    variant: '1v1',
    controlMode: 'vs_ai',
    playerNames: ['Human', 'AI'],
    seed: 101,
    manualEndTurn: true,
  });

  // Resolve simultaneous setup prompts (make sure P1 goes first by giving P1 Alphabetically earlier card)
  state = applyAction(state, {
    type: 'setup_meld',
    playerId: 'p1',
    cardInstanceId: state.players[0].hand[0].instanceId,
  });
  state = applyAction(state, {
    type: 'setup_meld',
    playerId: 'p2',
    cardInstanceId: state.players[1].hand[0].instanceId,
  });

  // Force current turn onto p1 with 1 action remaining for deterministic test
  state.currentPlayerIndex = 0;
  state.actionsRemaining = 1;
  state.actionsTotalThisTurn = 1;

  state = applyAction(state, { type: 'draw', playerId: 'p1' });
  assert.equal(state.players[state.currentPlayerIndex].id, 'p1');
  assert.equal(state.actionsRemaining, 0);
  assert.equal(state.lastTurnActionsByPlayer?.p1?.[0]?.kind, 'draw');

  // Cannot draw while actionsRemaining === 0
  assert.throws(() => applyAction(state, { type: 'draw', playerId: 'p1' }));

  // Pressing end_turn advances to AI (p2)
  const afterEnd = applyAction(state, { type: 'end_turn', playerId: 'p1' });
  assert.equal(afterEnd.players[afterEnd.currentPlayerIndex].id, 'p2');
  assert.equal(afterEnd.actionsRemaining, 2);

  // Toggling autoEndTurn back ON while paused at 0 actions also advances turn cleanly
  const toggledOff = setManualEndTurn(state, false);
  assert.equal(toggledOff.players[toggledOff.currentPlayerIndex].id, 'p2');
  assert.equal(toggledOff.actionsRemaining, 2);
});

test('projectPlayerView revealHidden, AI decision trace, debugTakeAnyCard, and debugTriggerEndGame work cleanly', () => {
  let state = createGame({
    variant: '1v1',
    controlMode: 'vs_ai',
    playerNames: ['Human', 'AI'],
    seed: 777,
  });
  state.phase = 'playing';
  state.pendingPrompts = [];
  state.currentPlayerIndex = 1;
  state.actionsRemaining = 2;

  // Give AI a splayed stack of 2 blue cards so we also test splay normalization
  const b1 = instantiateCard(BASE_CARD_DATABASE.find((c) => c.id === 'B012')!, 'ai_b1');
  const b2 = instantiateCard(BASE_CARD_DATABASE.find((c) => c.id === 'B011')!, 'ai_b2');
  meldCardInstance(state, 'p2', b1);
  meldCardInstance(state, 'p2', b2);
  splayPlayerColor(state, 'p2', 'blue', 'left');
  assert.equal(state.players[1].board.blue.splay, 'left');

  // Default PlayerView hides opponent cards; revealHidden exposes them ONLY on request
  const secretView = projectPlayerView(state, 'p1');
  assert.equal(secretView.players[1].revealedHandCards, undefined);
  const debugView = projectPlayerView(state, 'p1', { revealHidden: true });
  assert.equal(debugView.players[1].revealedHandCards?.length, state.players[1].hand.length);

  // AI decision trace capture produces candidates & zero-overhead selection info
  const aiSafeView = projectPlayerView(state, 'p2');
  const trace: AIDecisionTrace = {
    id: '',
    turn: 1,
    actorId: 'p2',
    actorName: 'AI',
    actionLabel: '',
    situationSummary: '',
    chosenLabel: '',
    candidates: [],
  };
  const aiMove = chooseAIAction(aiSafeView, trace);
  assert.ok(aiMove);
  assert.ok(trace.candidates.length >= 2);
  assert.ok(trace.candidates.some((c) => c.selected));

  // Debug Take Any Card moves Writing (B012) out of AI splayed blue pile and resets splay to 'none'
  const takeRes = debugTakeAnyCard(state, 'p1', 'B012');
  state = takeRes.nextState;
  assert.equal(takeRes.mode, 'moved');
  assert.ok(state.players[0].hand.some((c) => c.defId === 'B012'));
  assert.equal(state.players[1].board.blue.cards.length, 1);
  assert.equal(state.players[1].board.blue.splay, 'none');

  // Debug End Game triggers immediate win/lose cleanly
  const winState = debugTriggerEndGame(state, 'p1', 'win');
  assert.equal(winState.phase, 'gameover');
  assert.deepEqual(winState.victory?.winnerPlayerIds, ['p1']);

  const loseState = debugTriggerEndGame(state, 'p1', 'lose');
  assert.equal(loseState.phase, 'gameover');
  assert.deepEqual(loseState.victory?.winnerPlayerIds, ['p2']);
});

test('match start log newline, junkedStandardAges, and chronologyEvents (age milestones + achievements) record accurately', () => {
  const twoP = createGame({
    variant: '1v1',
    controlMode: 'vs_ai',
    playerNames: ['Alice', 'Bob'],
    seed: 101,
  });
  assert.match(twoP.log[0].message, /\n6 achievements for victory\.$/);

  const threeP = createGame({
    variant: '1v1v1',
    controlMode: 'vs_ai',
    playerNames: ['Alice', 'Bob', 'Cara'],
    seed: 102,
  });
  assert.match(threeP.log[0].message, /\n5 achievements for victory\.$/);

  // Force playing state and verify junking a standard achievement updates junkedStandardAges & playerView
  let state = createGame({
    variant: '1v1',
    controlMode: 'vs_ai',
    playerNames: ['Alice', 'Bob'],
    seed: 303,
  });
  state = applyAction(state, {
    type: 'setup_meld',
    playerId: 'p1',
    cardInstanceId: state.players[0].hand[0].instanceId,
  });
  state = applyAction(state, {
    type: 'setup_meld',
    playerId: 'p2',
    cardInstanceId: state.players[1].hand[0].instanceId,
  });
  state.currentPlayerIndex = 0;
  state.actionsRemaining = 2;

  // Meld an Age 3 card to trigger an age_milestone chronology event & highestAgeReachedByPlayer
  const age3Def = BASE_CARD_DATABASE.find((c) => c.age === 3)!;
  const age3Card = instantiateCard(age3Def, 'test_age3_meld');
  state.players[0].hand.push(age3Card);
  state = applyAction(state, {
    type: 'meld',
    playerId: 'p1',
    cardInstanceId: age3Card.instanceId,
  });
  assert.equal(state.highestAgeReachedByPlayer?.p1, 3);
  assert.ok(
    state.chronologyEvents?.some(
      (ev) => ev.kind === 'age_milestone' && ev.playerId === 'p1' && ev.age === 3
    )
  );

  // Give p1 enough points to achieve Age 1 and claim it; verify achievement chronology event & score snapshot
  const scoreCard = instantiateCard(BASE_CARD_DATABASE.find((c) => c.age === 5)!, 'test_pts5');
  scoreCardInstance(state, 'p1', scoreCard);
  state = applyAction(state, {
    type: 'achieve',
    playerId: 'p1',
    age: 1,
  });
  const achEvent = state.chronologyEvents?.find(
    (ev) => ev.kind === 'achievement' && ev.playerId === 'p1' && ev.age === 1
  );
  assert.ok(achEvent, 'Expected achievement chronology event for Age 1');
  assert.equal(achEvent.scoresByPlayer.p1, 5);
  assert.equal(achEvent.achievementsByPlayer.p1, 1);

  // Junk an available standard achievement (Age 2) and confirm junkedStandardAges exposes it cleanly
  const junkRes = junkStandardAchievementByAge(state, 2);
  assert.ok(junkRes);
  assert.equal(junkRes.age, 2);
  assert.ok(state.junkedStandardAges?.includes(2));
  const pv = projectPlayerView(state, 'p1');
  assert.ok(pv.junkedStandardAges.includes(2));
});

test('2v2 createGame supports alternating teams, opening 1-action turns, and arbitrary playerIsAI', () => {
  const mixed = createGame({
    variant: '2v2',
    playerNames: ['North', 'East', 'South', 'West'],
    playerIsAI: [false, true, false, true],
    seed: 4242,
  });

  assert.equal(mixed.players.length, 4);
  assert.equal(mixed.achievementTarget, 6);
  assert.equal(mixed.openingSingleActionTurnsRemaining, 2);
  assert.deepEqual(
    mixed.players.map((p) => p.teamId),
    ['A', 'B', 'A', 'B']
  );
  assert.deepEqual(
    mixed.players.map((p) => p.isAI),
    [false, true, false, true]
  );

  // Complete simultaneous setup_meld so finalizeSetupIfReady transitions into Turn 1
  let s = mixed;
  for (const p of s.players) {
    s = applyAction(s, {
      type: 'setup_meld',
      playerId: p.id,
      cardInstanceId: s.players.find((pl) => pl.id === p.id)!.hand[0].instanceId,
    });
  }
  assert.equal(s.phase, 'playing');
  // Turn 1 (1 opening action) -> Turn 2 (1 opening action) -> Turn 3 (2 actions)
  assert.equal(s.actionsRemaining, 1);
  s = applyAction(s, { type: 'draw', playerId: s.players[s.currentPlayerIndex].id });
  assert.equal(s.actionsRemaining, 1);
  s = applyAction(s, { type: 'draw', playerId: s.players[s.currentPlayerIndex].id });
  assert.equal(s.actionsRemaining, 2);
});

test('2v2 Dogma: teammate is immune to I DEMAND, shares non-demand effects, and grants NO free sharing draw', () => {
  const baseState = createGame({
    variant: '2v2',
    playerNames: ['A1', 'B1', 'A2', 'B2'],
    playerIsAI: [false, true, true, true],
    seed: 777,
  });
  baseState.phase = 'playing';
  baseState.pendingPrompts = [];
  baseState.currentPlayerIndex = 0; // A1 (teamA)
  baseState.actionsRemaining = 2;

  // Give A1 Archery (B001: Red Age 1, featuredIcon tower, I DEMAND opponent draws 1 and transfers highest hand card)
  // Ensure B1 (p2, teamB) and A2 (p3, teamA) both have fewer towers than A1 (A1 has 2 towers on Archery),
  // and B2 (p4, teamB) has 0 towers. Give A2 and B1 a card in hand so transfer would happen if demanded.
  const archery = instantiateCard(BASE_CARD_DATABASE.find((c) => c.id === 'B001')!, 'a1_arch');
  meldCardInstance(baseState, 'p1', archery);
  // Give B1 & B2 a non-tower card (Writing B012 - lightbulbs only) and A2 a non-tower card too
  const writingDef = BASE_CARD_DATABASE.find((c) => c.id === 'B012')!;
  meldCardInstance(baseState, 'p2', instantiateCard(writingDef, 'b1_wr'));
  meldCardInstance(baseState, 'p3', instantiateCard(writingDef, 'a2_wr'));
  meldCardInstance(baseState, 'p4', instantiateCard(writingDef, 'b2_wr'));

  const handCardA2 = instantiateCard(BASE_CARD_DATABASE.find((c) => c.id === 'B006')!, 'a2_keep');
  baseState.players[2].hand = [handCardA2]; // A2 (teammate) should keep this!
  const b1HandStart = baseState.players[1].hand.length;
  const a1HandStart = baseState.players[0].hand.length;

  let s = applyAction(baseState, { type: 'dogma', playerId: 'p1', color: 'red' });
  // Resolve any pending transfer prompt on opponents
  let safety = 0;
  while (s.pendingPrompts.length > 0 && safety < 10) {
    const p = s.pendingPrompts[0];
    assert.notEqual(p.playerId, 'p3', 'Teammate A2 must NEVER receive an I DEMAND prompt');
    if (p.kind === 'choose_cards') {
      s = applyAction(s, {
        type: 'answer_prompt',
        playerId: p.playerId,
        promptId: p.id,
        selectedCardIds: p.candidates.slice(0, p.min).map((c) => c.instanceId),
      });
    }
    safety++;
  }
  // A2 (teammate) was NOT forced to draw & transfer by I DEMAND
  assert.equal(s.players[2].hand.length, 1);
  assert.equal(s.players[2].hand[0].instanceId, handCardA2.instanceId);
  // B1 (enemy) was hit by I DEMAND (drew [1] and transferred highest to A1)
  assert.equal(s.players[1].hand.length, b1HandStart); // +1 draw, -1 transfer
  assert.ok(s.players[0].hand.length > a1HandStart);

  // Now verify non-demand Dogma sharing:
  // A1 activates Writing (B012: blue Age 1, lightbulb, "Draw a [2].")
  // Give ONLY A2 (teammate) >= lightbulbs than A1; B1 and B2 have 0 lightbulbs.
  const sShare = createGame({
    variant: '2v2',
    playerNames: ['A1', 'B1', 'A2', 'B2'],
    playerIsAI: [false, true, true, true],
    seed: 778,
  });
  sShare.phase = 'playing';
  sShare.pendingPrompts = [];
  sShare.currentPlayerIndex = 0;
  sShare.actionsRemaining = 2;
  meldCardInstance(sShare, 'p1', instantiateCard(writingDef, 'a1_w'));
  meldCardInstance(sShare, 'p3', instantiateCard(writingDef, 'a2_w')); // Teammate shares lightbulbs!
  sShare.players[0].hand = [];
  sShare.players[2].hand = [];

  const afterShare = applyAction(sShare, { type: 'dogma', playerId: 'p1', color: 'blue' });
  // Teammate A2 executed Writing ("Draw a [2]")
  assert.equal(afterShare.players[2].hand.length, 1);
  assert.equal(afterShare.players[2].hand[0].age, 2);
  // Activating player A1 executed Writing ("Draw a [2]") -> 1 card ONLY, NO free sharing draw from teammate!
  assert.equal(afterShare.players[0].hand.length, 1, 'Sharing with teammate must NOT grant free sharing draw');

  // By contrast, if an OPPONENT (B1) also shares Writing, opponent causing a card change DOES grant the free draw (+1 -> 2 cards total for A1)
  const sOppShare = createGame({
    variant: '2v2',
    playerNames: ['A1', 'B1', 'A2', 'B2'],
    playerIsAI: [false, true, true, true],
    seed: 779,
  });
  sOppShare.phase = 'playing';
  sOppShare.pendingPrompts = [];
  sOppShare.currentPlayerIndex = 0;
  sOppShare.actionsRemaining = 2;
  meldCardInstance(sOppShare, 'p1', instantiateCard(writingDef, 'a1_w2'));
  meldCardInstance(sOppShare, 'p2', instantiateCard(writingDef, 'b1_w2')); // Opponent B1 shares!
  sOppShare.players[0].hand = [];
  sOppShare.players[1].hand = [];

  const afterOppShare = applyAction(sOppShare, { type: 'dogma', playerId: 'p1', color: 'blue' });
  assert.equal(afterOppShare.players[1].hand.length, 1);
  assert.equal(afterOppShare.players[0].hand.length, 2, 'Sharing with opponent grants the free sharing draw');

  // Use Railroad (B075): "Return all cards from your hand..." -> non-demand harmful effect!
  const railroadDef = BASE_CARD_DATABASE.find((c) => c.id === 'B075')!;
  const sHarm = createGame({
    variant: '2v2',
    playerNames: ['A1', 'B1', 'A2', 'B2'],
    playerIsAI: [false, true, true, true],
    seed: 780,
  });
  sHarm.phase = 'playing';
  sHarm.pendingPrompts = [];
  sHarm.currentPlayerIndex = 0;
  sHarm.actionsRemaining = 2;
  meldCardInstance(sHarm, 'p1', instantiateCard(railroadDef, 'a1_rr'));
  meldCardInstance(sHarm, 'p3', instantiateCard(railroadDef, 'a2_rr'));
  sHarm.players[0].hand = [instantiateCard(writingDef, 'a1_h')];
  sHarm.players[2].hand = [instantiateCard(writingDef, 'a2_h')];

  const afterHarm = applyAction(sHarm, { type: 'dogma', playerId: 'p1', color: 'purple' });
  // Railroad Ability 1 returns Writing (Age 1), Ability 2 draws three [6]
  assert.equal(
    afterHarm.players[2].hand.some((c) => c.instanceId === 'a2_h'),
    false,
    'Teammate must execute Railroad ability 1 (return all hand cards)'
  );
  assert.equal(afterHarm.players[2].hand.length, 3);
  assert.ok(
    afterHarm.players[2].hand.every((c) => c.age === 6),
    'Teammate must execute full non-demand Dogma (drew three [6] after returning hand)'
  );
});

test('2v2 win conditions: combined team achievements (6), single vs double elimination, and Age 12 team score tiebreak', () => {
  // 1. Combined 6 team achievements ends the match for both teammates
  const sAch = createGame({
    variant: '2v2',
    playerNames: ['A1', 'B1', 'A2', 'B2'],
    playerIsAI: [true, true, true, true],
    seed: 901,
  });
  sAch.phase = 'playing';
  sAch.pendingPrompts = [];
  sAch.currentPlayerIndex = 0;
  sAch.actionsRemaining = 2;

  // Give A1 3 achievements and A2 2 achievements (teamA = 5), and give A1 enough points + Age 1 card to achieve 6th
  sAch.players[0].achievements = [
    { id: 'a1', kind: 'special', specialId: 'monument' },
    { id: 'a2', kind: 'special', specialId: 'empire' },
    { id: 'a3', kind: 'special', specialId: 'world' },
  ];
  sAch.players[2].achievements = [
    { id: 'a4', kind: 'special', specialId: 'wonder' },
    { id: 'a5', kind: 'special', specialId: 'universe' },
  ];
  meldCardInstance(sAch, 'p1', instantiateCard(BASE_CARD_DATABASE.find((c) => c.id === 'B001')!, 'top1'));
  scoreCardInstance(sAch, 'p1', instantiateCard(BASE_CARD_DATABASE.find((c) => c.age === 5)!, 'sc5'));

  const sWonAch = applyAction(sAch, { type: 'achieve', playerId: 'p1', age: 1 });
  assert.equal(sWonAch.phase, 'gameover');
  assert.equal(sWonAch.victory?.winnerTeamId, 'A');
  assert.deepEqual(sWonAch.victory?.winnerPlayerIds, ['p1', 'p3']);

  // 2. Elimination: eliminating 1 opponent on team B does NOT end 2v2; eliminating both DOES award victory to team A
  const sElim = createGame({
    variant: '2v2',
    playerNames: ['A1', 'B1', 'A2', 'B2'],
    playerIsAI: [true, true, true, true],
    seed: 902,
  });
  sElim.phase = 'playing';
  sElim.pendingPrompts = [];
  eliminatePlayer(sElim, 'p2');
  assert.equal(sElim.phase, 'playing');
  eliminatePlayer(sElim, 'p4');
  assert.equal(sElim.phase, 'gameover');
  assert.equal(sElim.victory?.winnerTeamId, 'A');
  assert.deepEqual(sElim.victory?.winnerPlayerIds, ['p1', 'p3']);

  // 3. Age 12+ empty deck tiebreak uses combined team score
  const sScore = createGame({
    variant: '2v2',
    playerNames: ['A1', 'B1', 'A2', 'B2'],
    playerIsAI: [true, true, true, true],
    seed: 903,
  });
  sScore.phase = 'playing';
  sScore.pendingPrompts = [];
  sScore.currentPlayerIndex = 0;
  sScore.actionsRemaining = 2;
  // Team A combined achievements = 2, Team B = 2 (tied); Team B combined score > Team A combined score
  sScore.players[0].achievements = [{ id: 'x1', kind: 'special', specialId: 'monument' }];
  sScore.players[2].achievements = [{ id: 'x2', kind: 'special', specialId: 'empire' }];
  sScore.players[1].achievements = [{ id: 'x3', kind: 'special', specialId: 'world' }];
  sScore.players[3].achievements = [{ id: 'x4', kind: 'special', specialId: 'wonder' }];
  scoreCardInstance(sScore, 'p1', instantiateCard(BASE_CARD_DATABASE.find((c) => c.age === 5)!, 'a1_5'));
  scoreCardInstance(sScore, 'p2', instantiateCard(BASE_CARD_DATABASE.find((c) => c.age === 4)!, 'b1_4'));
  scoreCardInstance(sScore, 'p4', instantiateCard(BASE_CARD_DATABASE.find((c) => c.age === 4)!, 'b2_4')); // Team B = 8 vs Team A = 5
  sScore.decks[11] = [];
  meldCardInstance(sScore, 'p1', instantiateCard(BASE_CARD_DATABASE.find((c) => c.age === 11)!, 'a1_11'));

  const sScoreWon = applyAction(sScore, { type: 'draw', playerId: 'p1' });
  assert.equal(sScoreWon.phase, 'gameover');
  assert.equal(sScoreWon.victory?.winnerTeamId, 'B');
  assert.deepEqual(sScoreWon.victory?.winnerPlayerIds, ['p2', 'p4']);
});

test('Setup match start, starting melds, and goes-first logs group under turnNumber 0 (Setup)', () => {
  let state = createGame({
    variant: '1v1',
    playerNames: ['Human', 'AI Archivist'],
    playerIsAI: [false, true],
    seed: 616,
  });
  assert.equal(state.turnNumber, 0);

  for (const p of state.players) {
    const firstCard = p.hand[0];
    state = applyAction(state, {
      type: 'setup_meld',
      playerId: p.id,
      cardInstanceId: firstCard.instanceId,
    });
  }

  assert.equal(state.phase, 'playing');
  assert.equal(state.turnNumber, 1);

  const setupLogs = state.log.filter((entry) => entry.turn === 0);
  assert.ok(setupLogs.length >= 4, 'Match start, both starting melds, and goes-first log should have turn === 0');
  assert.ok(
    setupLogs.some((entry) => /goes first/i.test(entry.message)),
    'First-player determination log should be recorded under Setup (turn 0)'
  );
  assert.equal(state.log.filter((entry) => entry.turn === 1).length, 0, 'Turn 1 should start clean with no setup entries');
});

test('manualEndTurnForAI pauses at 0 actions on AI turn until explicit end_turn', () => {
  let state = createGame({
    variant: '1v1',
    playerNames: ['AI North', 'AI South'],
    playerIsAI: [true, true],
    manualEndTurn: true,
    manualEndTurnForAI: true,
    seed: 717,
  });
  state.phase = 'playing';
  state.pendingPrompts = [];
  state.currentPlayerIndex = 0;
  state.actionsRemaining = 1;
  state.actionsTotalThisTurn = 1;
  state.openingSingleActionTurnsRemaining = 0;
  state.turnNumber = 1;

  // Perform the single action of Turn 1 for AI North
  state = applyAction(state, { type: 'draw', playerId: 'p1' });
  assert.equal(state.currentPlayerIndex, 0, 'AI turn must wait at 0 actions when manualEndTurnForAI is enabled');
  assert.equal(state.actionsRemaining, 0);
  assert.equal(state.turnNumber, 1);

  // Explicit end_turn advances to AI South (Turn 2)
  state = applyAction(state, { type: 'end_turn', playerId: 'p1' });
  assert.equal(state.currentPlayerIndex, 1);
  assert.equal(state.turnNumber, 2);
  assert.equal(state.actionsRemaining, 2);

  // Also test toggling setManualEndTurn updates manualEndTurnForAI cleanly
  const toggled = setManualEndTurn(state, true, false);
  assert.equal(toggled.manualEndTurn, true);
  assert.equal(toggled.manualEndTurnForAI, false);
});

test('PublicPlayerView exposes opponent scoreTotal points total separately from scoreCount card count', () => {
  const state = createGame({
    variant: '1v1',
    playerNames: ['Human', 'AI'],
    playerIsAI: [false, true],
    seed: 909,
  });
  const c1 = instantiateCard(BASE_CARD_DATABASE.find((c) => c.age === 3)!, 'sc_3a');
  const c2 = instantiateCard(BASE_CARD_DATABASE.find((c) => c.age === 3)!, 'sc_3b');
  const c3 = instantiateCard(BASE_CARD_DATABASE.find((c) => c.age === 4)!, 'sc_4a');
  state.players[1].scorePile = [c1, c2, c3];

  const view = projectPlayerView(state, 'p1');
  const oppView = view.players.find((p) => p.id === 'p2')!;
  assert.equal(oppView.scoreCount, 3);
  assert.equal(oppView.scoreTotal, 10);
  assert.equal(oppView.revealedScoreCards, undefined);
});






