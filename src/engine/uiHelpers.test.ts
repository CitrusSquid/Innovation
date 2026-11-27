import assert from 'node:assert/strict';
import test from 'node:test';
import { BASE_CARD_DATABASE, instantiateCard } from '../data/cards/catalog';
import { debugTriggerEndGame } from './debug';
import { applyAction, createGame } from './engine';
import { cloneGameState } from './keywords';
import { DEFAULT_SETTINGS } from './settings';
import type { GameState, PendingPrompt, SpecialAchievementId } from './types';
import { getSortedSpecialAchievements, getZeroSelectionSkipLabels } from './uiHelpers';

function getCardDefById(id: string) {
  const def = BASE_CARD_DATABASE.find((c) => c.id === id);
  if (!def) throw new Error(`Card def not found: ${id}`);
  return def;
}

function makePlayingState(seed = 42, fastSimulation = false): GameState {
  const base = createGame({
    variant: '1v1',
    controlMode: 'vs_ai',
    playerNames: ['Alice', 'Bob'],
    seed,
  });
  const p0 = base.players[0];
  const p1 = base.players[1];
  const s1 = applyAction(base, {
    type: 'setup_meld',
    playerId: p0.id,
    cardInstanceId: p0.hand[0].instanceId,
  });
  const s2 = applyAction(s1, {
    type: 'setup_meld',
    playerId: p1.id,
    cardInstanceId: p1.hand[0].instanceId,
  });
  return {
    ...s2,
    currentPlayerIndex: 0,
    actionsRemaining: 2,
    fastSimulation,
  };
}

test('getSortedSpecialAchievements places available first and claimed/junked at bottom with alt cards', () => {
  const available: SpecialAchievementId[] = ['world', 'wonder'];
  const rows = getSortedSpecialAchievements(available, [
    {
      name: 'Alice',
      achievementBacks: [
        { id: 'a1', kind: 'special', specialId: 'monument' },
        { id: 'a2', kind: 'standard', age: 1 },
      ],
    },
    {
      name: 'Bob',
      achievementBacks: [{ id: 'a3', kind: 'special', specialId: 'empire' }],
    },
  ]);

  assert.equal(rows.length, 5);
  assert.deepEqual(
    rows.slice(0, 2).map((r) => r.def.id),
    ['world', 'wonder']
  );
  assert.equal(rows[0].available, true);
  assert.equal(rows[1].available, true);

  const unavailable = rows.slice(2);
  assert.ok(unavailable.every((r) => !r.available));
  assert.equal(unavailable.find((r) => r.def.id === 'monument')?.ownerName, 'Alice');
  assert.equal(unavailable.find((r) => r.def.id === 'empire')?.ownerName, 'Bob');
  assert.equal(unavailable.find((r) => r.def.id === 'universe')?.ownerName, null);

  for (const row of rows) {
    assert.ok(row.def.altCardName.length > 0);
    assert.ok(row.def.altCardAge >= 1 && row.def.altCardAge <= 5);
  }
});

test('getZeroSelectionSkipLabels distinguishes Choose None vs Skip based on prompt multiplicity and wording', () => {
  const multiPrompt: Extract<PendingPrompt, { kind: 'choose_cards' }> = {
    id: 'p1',
    playerId: 'p0',
    kind: 'choose_cards',
    title: 'Pottery',
    subtitle: 'You may return up to three cards from your hand.',
    sourceLabel: 'Your Hand',
    candidates: [],
    min: 0,
    max: 3,
    allowSkip: true,
  };
  assert.deepEqual(getZeroSelectionSkipLabels(multiPrompt), {
    idleLabel: 'Choose None',
    confirmLabel: 'Confirm Choose None',
  });

  const singleOptionalPrompt: Extract<PendingPrompt, { kind: 'choose_cards' }> = {
    id: 'p2',
    playerId: 'p0',
    kind: 'choose_cards',
    title: 'Agriculture',
    subtitle: 'You may return a card from your hand.',
    sourceLabel: 'Your Hand',
    candidates: [],
    min: 0,
    max: 1,
    allowSkip: true,
  };
  assert.deepEqual(getZeroSelectionSkipLabels(singleOptionalPrompt), {
    idleLabel: 'Skip',
    confirmLabel: 'Confirm Skip',
  });

  const colorPrompt: Extract<PendingPrompt, { kind: 'choose_color' }> = {
    id: 'p3',
    playerId: 'p0',
    kind: 'choose_color',
    title: 'Philosophy',
    subtitle: 'You may splay left any one color of your cards.',
    options: ['red', 'blue'],
    allowSkip: true,
  };
  assert.deepEqual(getZeroSelectionSkipLabels(colorPrompt), {
    idleLabel: 'Skip',
    confirmLabel: 'Confirm Skip',
  });
});

test('Metalworking emits sequential repeatDrawEvents per drawn card and skips during fastSimulation', () => {
  const state = makePlayingState(101, false);
  const p0 = state.players[0];
  const p1 = state.players[1];

  // Clear opponent board so Bob does not share Metalworking
  for (const c of ['red', 'yellow', 'green', 'blue', 'purple'] as const) {
    p1.board[c] = { color: c, cards: [], splay: 'none' };
  }

  // Place Metalworking (B002, red, tower) on Alice's red stack
  const metalworking = instantiateCard(getCardDefById('B002'));
  p0.board.red = { color: 'red', cards: [metalworking], splay: 'none' };

  // Stack Age 1 deck so top draw has tower (Archery B001), second draw has tower (Masonry B006), third has no tower (Writing B012)
  state.decks[1] = [
    instantiateCard(getCardDefById('B001')),
    instantiateCard(getCardDefById('B006')),
    instantiateCard(getCardDefById('B012')),
    ...state.decks[1],
  ];

  const after = applyAction(state, { type: 'dogma', playerId: p0.id, color: 'red' });
  const events = after.repeatDrawEvents ?? [];
  assert.equal(events.length, 3);
  assert.equal(events[0].sourceCardDefId, 'B002');
  assert.equal(events[0].stepNumber, 1);
  assert.equal(events[0].card.defId, 'B001');
  assert.equal(events[0].repeats, true);

  assert.equal(events[1].stepNumber, 2);
  assert.equal(events[1].card.defId, 'B006');
  assert.equal(events[1].repeats, true);

  assert.equal(events[2].stepNumber, 3);
  assert.equal(events[2].card.defId, 'B012');
  assert.equal(events[2].repeats, false);

  // Verify fastSimulation suppresses repeatDrawEvents
  const fastState = makePlayingState(101, true);
  for (const c of ['red', 'yellow', 'green', 'blue', 'purple'] as const) {
    fastState.players[1].board[c] = { color: c, cards: [], splay: 'none' };
  }
  fastState.players[0].board.red = {
    color: 'red',
    cards: [instantiateCard(getCardDefById('B002'))],
    splay: 'none',
  };
  fastState.decks[1] = [
    instantiateCard(getCardDefById('B001')),
    instantiateCard(getCardDefById('B012')),
  ];
  const fastAfter = applyAction(fastState, {
    type: 'dogma',
    playerId: fastState.players[0].id,
    color: 'red',
  });
  assert.equal(fastAfter.repeatDrawEvents?.length ?? 0, 0);
});

test('Colonialism emits sequential repeatDrawEvents for each tucked Age 3 card', () => {
  const state = makePlayingState(202, false);
  const p0 = state.players[0];
  const p1 = state.players[1];

  for (const c of ['red', 'yellow', 'green', 'blue', 'purple'] as const) {
    p1.board[c] = { color: c, cards: [], splay: 'none' };
  }

  p0.board.red = {
    color: 'red',
    cards: [instantiateCard(getCardDefById('B036'))],
    splay: 'none',
  };

  // B029 Compass has coin (repeats), B026 Alchemy has no coin (stops)
  state.decks[3] = [
    instantiateCard(getCardDefById('B029')),
    instantiateCard(getCardDefById('B026')),
    ...state.decks[3],
  ];

  const after = applyAction(state, { type: 'dogma', playerId: p0.id, color: 'red' });
  const events = after.repeatDrawEvents ?? [];
  assert.equal(events.length, 2);
  assert.equal(events[0].sourceCardDefId, 'B036');
  assert.equal(events[0].repeats, true);
  assert.equal(events[1].repeats, false);
});

test('Astronomy emits sequential repeatDrawEvents when drawing green/blue cards and stopping on other colors', () => {
  const state = makePlayingState(303, false);
  const p0 = state.players[0];
  const p1 = state.players[1];

  for (const c of ['red', 'yellow', 'green', 'blue', 'purple'] as const) {
    p1.board[c] = { color: c, cards: [], splay: 'none' };
  }

  p0.board.purple = {
    color: 'purple',
    cards: [instantiateCard(getCardDefById('B054'))],
    splay: 'none',
  };

  // Age 6: B062 Atomic Theory (blue -> repeats), B056 Industrialization (red -> stops)
  state.decks[6] = [
    instantiateCard(getCardDefById('B062')),
    instantiateCard(getCardDefById('B056')),
    ...state.decks[6],
  ];

  const after = applyAction(state, { type: 'dogma', playerId: p0.id, color: 'purple' });
  const events = after.repeatDrawEvents ?? [];
  assert.equal(events.length, 2);
  assert.equal(events[0].sourceCardDefId, 'B054');
  assert.equal(events[0].card.defId, 'B062');
  assert.equal(events[0].repeats, true);
  assert.equal(events[1].card.defId, 'B056');
  assert.equal(events[1].repeats, false);
});

test('cloneGameState keeps repeatDrawEvents immutable across consecutive Dogma actions', () => {
  const state = makePlayingState(404, false);
  const p0 = state.players[0];
  const p1 = state.players[1];

  for (const c of ['red', 'yellow', 'green', 'blue', 'purple'] as const) {
    p1.board[c] = { color: c, cards: [], splay: 'none' };
  }
  p0.board.red = {
    color: 'red',
    cards: [instantiateCard(getCardDefById('B002'))],
    splay: 'none',
  };
  state.decks[1] = [
    instantiateCard(getCardDefById('B012')),
    instantiateCard(getCardDefById('B012')),
    ...state.decks[1],
  ];

  const afterFirst = applyAction(state, { type: 'dogma', playerId: p0.id, color: 'red' });
  const firstLen = afterFirst.repeatDrawEvents?.length ?? 0;
  assert.equal(firstLen, 1);

  const snapshot = cloneGameState(afterFirst);
  const afterSecond = applyAction(afterFirst, { type: 'dogma', playerId: p0.id, color: 'red' });
  assert.equal(afterFirst.repeatDrawEvents?.length, firstLen);
  assert.equal(snapshot.repeatDrawEvents?.length, firstLen);
  assert.equal(afterSecond.repeatDrawEvents?.length, firstLen + 1);
});

test('debugTriggerEndGame handles 2v2 teams cleanly for win and lose', () => {
  const base = createGame({
    variant: '2v2',
    controlMode: 'vs_ai',
    playerNames: ['P1', 'P2', 'P3', 'P4'],
    playerIsAI: [false, true, true, true],
    seed: 77,
  });

  const won = debugTriggerEndGame(base, 'p1', 'win');
  assert.equal(won.phase, 'gameover');
  assert.equal(won.victory?.winnerTeamId, 'A');
  assert.deepEqual(won.victory?.winnerPlayerIds, ['p1', 'p3']);

  const lost = debugTriggerEndGame(base, 'p1', 'lose');
  assert.equal(lost.phase, 'gameover');
  assert.equal(lost.victory?.winnerTeamId, 'B');
  assert.deepEqual(lost.victory?.winnerPlayerIds, ['p2', 'p4']);
});

test('DEFAULT_SETTINGS locks debug tools by default', () => {
  assert.equal(DEFAULT_SETTINGS.debugUnlocked, false);
});
