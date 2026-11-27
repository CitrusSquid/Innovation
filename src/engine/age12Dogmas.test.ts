import test from 'node:test';
import assert from 'node:assert/strict';

import { BASE_CARD_DATABASE, instantiateCard } from '../data/cards/catalog';
import { chooseAIAction } from './ai';
import { applyAction, createGame } from './engine';
import { meldCardInstance, scoreCardInstance } from './keywords';
import { projectPlayerView } from './playerView';
import { getTopCard } from './splay';
import type { Age, CardInstance, GameState } from './types';

function byId(defId: string, suffix = 't'): CardInstance {
  const def = BASE_CARD_DATABASE.find((c) => c.id === defId);
  if (!def) throw new Error(`Missing card ${defId}`);
  return instantiateCard(def, suffix);
}

function makePlayingState(seed = 1001): GameState {
  const state = createGame({
    variant: '1v1',
    controlMode: 'pass_and_play',
    playerNames: ['P1', 'P2'],
    seed,
  });
  state.phase = 'playing';
  state.pendingPrompts = [];
  state.currentPlayerIndex = 0;
  state.actionsRemaining = 2;
  state.actionsTotalThisTurn = 2;
  state.players[0].hand = [];
  state.players[1].hand = [];
  return state;
}

function fillDeck(state: GameState, age: Age, defIds: string[]): void {
  state.decks[age] = defIds.map((id, i) => byId(id, `d_${age}_${i}`));
}

test('Age 1 B001 ARCHERY: demand draws 1 + transfers highest card, ability 2 junks achievement 1 or 2', () => {
  const state0 = makePlayingState();
  meldCardInstance(state0, 'p1', byId('B001', 'p1_arch')); // 2 towers
  // P2 has 0 towers -> vulnerable; has an Age 3 placeholder in hand already, then draws [1]
  const lowHand = byId('B008', 'p2_sailing'); // age 1
  const highHand = byId('B016', 'p2_constr'); // age 2
  state0.players[1].hand = [lowHand, highHand];
  fillDeck(state0, 1, ['B009']);

  let s = applyAction(state0, { type: 'dogma', playerId: 'p1', color: 'red' });
  // P2 transferred highest card (B016 age 2) to P1 hand, kept B008 and drew B009
  assert.ok(s.players[0].hand.some((c) => c.instanceId === highHand.instanceId));
  assert.equal(s.players[1].hand.length, 2);
  // Ab 2 prompts P1 to choose between Age 1 and Age 2 standard achievements
  assert.equal(s.pendingPrompts[0].kind, 'choose_value');
  assert.equal(s.pendingPrompts[0].playerId, 'p1');

  s = applyAction(s, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: s.pendingPrompts[0].id,
    selectedValue: 2,
  });
  assert.equal(s.standardAchievements.some((c) => c.age === 2), false);
  assert.ok(s.junk.some((c) => c.age === 2));
});

test('Age 1 B002 METALWORKING: repeats while drawn [1] has tower, keeps final non-tower card in hand', () => {
  const state0 = makePlayingState();
  meldCardInstance(state0, 'p1', byId('B002', 'p1_metal'));
  // Deck 1 order: B001 (has tower) -> B005 (has tower) -> B008 (Sailing: coin/coin/leaf, NO tower)
  fillDeck(state0, 1, ['B001', 'B005', 'B008']);

  const s = applyAction(state0, { type: 'dogma', playerId: 'p1', color: 'red' });
  assert.equal(s.players[0].scorePile.length, 2);
  assert.equal(s.players[0].hand.length, 1);
  assert.equal(s.players[0].hand[0].defId, 'B008');
  assert.equal(s.pendingPrompts.length, 0);
});

test('Age 1 B003 OARS: demand loops transfers with coin, ability 2 draws [1] only when 0 transferred', () => {
  // Case A: P2 has 2 coin cards -> transfers 1, draws [1], repeats, transfers 2nd, draws [1], Ab 2 skipped
  const stateA = makePlayingState();
  meldCardInstance(stateA, 'p1', byId('B003', 'p1_oars')); // 2 towers
  const cCoin1 = byId('B008', 'p2_c1'); // coin
  const cCoin2 = byId('B012', 'p2_c2'); // coin
  stateA.players[1].hand = [cCoin1, cCoin2];
  fillDeck(stateA, 1, ['B004', 'B004', 'B004']); // Agriculture has NO coin

  let sA = applyAction(stateA, { type: 'dogma', playerId: 'p1', color: 'red' });
  assert.equal(sA.pendingPrompts[0].kind, 'choose_cards');
  assert.equal(sA.pendingPrompts[0].playerId, 'p2');
  sA = applyAction(sA, {
    type: 'answer_prompt',
    playerId: 'p2',
    promptId: sA.pendingPrompts[0].id,
    selectedCardIds: [cCoin1.instanceId],
  });
  // After transferring cCoin1 & drawing non-coin B004, only cCoin2 remains -> auto-transfers & draws B004 -> stops!
  assert.equal(sA.pendingPrompts.length, 0);
  assert.equal(sA.players[0].scorePile.length, 2);
  assert.equal(sA.players[0].hand.length, 0); // Ab 2 skipped!
  assert.equal(sA.players[1].hand.length, 2);

  // Case B: P2 has 0 coin cards -> Ab 2 draws [1] for P1
  const stateB = makePlayingState();
  meldCardInstance(stateB, 'p1', byId('B003', 'p1_oars'));
  stateB.players[1].hand = [byId('B004', 'p2_agri')]; // no coin
  fillDeck(stateB, 1, ['B009']);
  const sB = applyAction(stateB, { type: 'dogma', playerId: 'p1', color: 'red' });
  assert.equal(sB.players[0].scorePile.length, 0);
  assert.equal(sB.players[0].hand.length, 1);
});

test('Age 1 B004 AGRICULTURE, B005 DOMESTICATION, B006 MASONRY (Monument claim)', () => {
  // B004 Agriculture
  const sAgri0 = makePlayingState();
  meldCardInstance(sAgri0, 'p1', byId('B004', 'p1_agri'));
  const ret1 = byId('B009', 'h1');
  sAgri0.players[0].hand = [ret1];
  fillDeck(sAgri0, 2, ['B016']);
  let sAgri = applyAction(sAgri0, { type: 'dogma', playerId: 'p1', color: 'yellow' });
  sAgri = applyAction(sAgri, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: sAgri.pendingPrompts[0].id,
    selectedCardIds: [ret1.instanceId],
  });
  assert.equal(sAgri.players[0].hand.length, 0);
  assert.equal(sAgri.players[0].scorePile[0].age, 2);

  // B005 Domestication (ties on lowest + draw [1])
  const sDom0 = makePlayingState();
  meldCardInstance(sDom0, 'p1', byId('B005', 'p1_dom'));
  const lowA = byId('B008', 'low_a');
  const lowB = byId('B012', 'low_b');
  const highC = byId('B022', 'high_c');
  sDom0.players[0].hand = [lowA, lowB, highC];
  fillDeck(sDom0, 1, ['B009']);
  let sDom = applyAction(sDom0, { type: 'dogma', playerId: 'p1', color: 'yellow' });
  assert.equal(sDom.pendingPrompts[0].kind, 'choose_cards');
  sDom = applyAction(sDom, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: sDom.pendingPrompts[0].id,
    selectedCardIds: [lowA.instanceId],
  });
  assert.equal(getTopCard(sDom.players[0].board.green)?.instanceId, lowA.instanceId);
  assert.equal(sDom.players[0].hand.length, 3); // lowB, highC + drawn [1]

  // B006 Masonry (meld tower cards + claim Monument with 3 red cards)
  const sMas0 = makePlayingState();
  meldCardInstance(sMas0, 'p1', byId('B006', 'p1_mas'));
  const r1 = byId('B001', 'r1');
  const r2 = byId('B002', 'r2');
  const r3 = byId('B003', 'r3');
  const noTower = byId('B004', 'nt');
  sMas0.players[0].hand = [r1, r2, r3, noTower];
  let sMas = applyAction(sMas0, { type: 'dogma', playerId: 'p1', color: 'yellow' });
  assert.equal(sMas.pendingPrompts[0].kind, 'choose_cards');
  sMas = applyAction(sMas, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: sMas.pendingPrompts[0].id,
    selectedCardIds: [r1.instanceId, r2.instanceId, r3.instanceId],
  });
  assert.equal(sMas.players[0].board.red.cards.length, 3);
  assert.ok(sMas.players[0].achievements.some((a) => a.specialId === 'monument'));
});

test('Age 1 B007 CLOTHING, B008 SAILING, B009 THE WHEEL', () => {
  // B007 Clothing
  const sCloth0 = makePlayingState();
  meldCardInstance(sCloth0, 'p1', byId('B007', 'p1_cloth')); // green on P1
  meldCardInstance(sCloth0, 'p2', byId('B008', 'p2_green')); // green on P2 too
  const p1Blue = byId('B010', 'h_blue');
  sCloth0.players[0].hand = [p1Blue, byId('B009', 'h_green')]; // only blue is not on board
  fillDeck(sCloth0, 1, ['B001', 'B002']);
  const sCloth = applyAction(sCloth0, { type: 'dogma', playerId: 'p1', color: 'green' });
  assert.equal(getTopCard(sCloth.players[0].board.blue)?.instanceId, p1Blue.instanceId);
  // P1 has green (shared with P2) + blue (exclusive!) -> scores 1 card
  assert.equal(sCloth.players[0].scorePile.length, 1);

  // B008 Sailing & B009 The Wheel
  const sSail0 = makePlayingState();
  meldCardInstance(sSail0, 'p1', byId('B008', 'p1_sail'));
  fillDeck(sSail0, 1, ['B004', 'B009', 'B001']);
  let sSail = applyAction(sSail0, { type: 'dogma', playerId: 'p1', color: 'green' });
  assert.equal(getTopCard(sSail.players[0].board.yellow)?.defId, 'B004');

  meldCardInstance(sSail, 'p1', byId('B009', 'p1_wheel'));
  sSail = applyAction(sSail, { type: 'dogma', playerId: 'p1', color: 'green' });
  assert.equal(sSail.players[0].hand.length, 2);
});

test('Age 1 B010 POTTERY, B011 TOOLS, B012 WRITING', () => {
  // B010 Pottery: return 2 cards -> draw & score [2], then draw [1]
  const sPot0 = makePlayingState();
  meldCardInstance(sPot0, 'p1', byId('B010', 'p1_pot'));
  const h1 = byId('B001', 'h1');
  const h2 = byId('B002', 'h2');
  sPot0.players[0].hand = [h1, h2];
  fillDeck(sPot0, 1, ['B004']);
  fillDeck(sPot0, 2, ['B016']);
  let sPot = applyAction(sPot0, { type: 'dogma', playerId: 'p1', color: 'blue' });
  sPot = applyAction(sPot, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: sPot.pendingPrompts[0].id,
    selectedCardIds: [h1.instanceId, h2.instanceId],
  });
  assert.equal(sPot.players[0].scorePile[0].age, 2);
  assert.equal(sPot.players[0].hand.length, 1);

  // B011 Tools: return 3 -> draw & meld [3], then return [3] -> draw three [1]
  const sTools0 = makePlayingState();
  meldCardInstance(sTools0, 'p1', byId('B011', 'p1_tools'));
  const c1 = byId('B001', 't1');
  const c2 = byId('B002', 't2');
  const c3 = byId('B003', 't3');
  const threeInHand = byId('B016', 't4');
  threeInHand.age = 3;
  sTools0.players[0].hand = [c1, c2, c3, threeInHand];
  fillDeck(sTools0, 1, ['B004', 'B005', 'B006']);
  let sTools = applyAction(sTools0, { type: 'dogma', playerId: 'p1', color: 'blue' });
  sTools = applyAction(sTools, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: sTools.pendingPrompts[0].id,
    selectedCardIds: [c1.instanceId, c2.instanceId, c3.instanceId],
  });
  // Second ability prompts to return a [3]
  assert.equal(sTools.pendingPrompts[0].kind, 'choose_cards');
  sTools = applyAction(sTools, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: sTools.pendingPrompts[0].id,
    selectedCardIds: [threeInHand.instanceId],
  });
  assert.equal(sTools.players[0].hand.length, 3);

  // B012 Writing: draw [2]
  const sWri0 = makePlayingState();
  meldCardInstance(sWri0, 'p1', byId('B012', 'p1_wri'));
  fillDeck(sWri0, 2, ['B020']);
  const sWri = applyAction(sWri0, { type: 'dogma', playerId: 'p1', color: 'blue' });
  assert.equal(sWri.players[0].hand[0].defId, 'B020');
});

test('Age 1 B013 CITY STATES, B014 CODE OF LAWS, B015 MYSTICISM', () => {
  // B013 City States: demand transfers top card with tower if opponent has >= 4 tower, then opponent draws [1]
  const sCity0 = makePlayingState();
  meldCardInstance(sCity0, 'p1', byId('B013', 'p1_city')); // 1 coin -> needs >=1 coin > P2's 0 coin! Wait City States icon is coin (bl/bc = 2 coins)
  meldCardInstance(sCity0, 'p2', byId('B006', 'p2_masonry')); // 3 towers
  meldCardInstance(sCity0, 'p2', byId('B001', 'p2_arch')); // +2 towers = 5 towers total, 2 top cards with tower
  fillDeck(sCity0, 1, ['B008']);
  let sCity = applyAction(sCity0, { type: 'dogma', playerId: 'p1', color: 'purple' });
  assert.equal(sCity.pendingPrompts[0].playerId, 'p2');
  sCity = applyAction(sCity, {
    type: 'answer_prompt',
    playerId: 'p2',
    promptId: sCity.pendingPrompts[0].id,
    selectedCardIds: [sCity.players[1].board.red.cards[0].instanceId],
  });
  assert.equal(sCity.players[0].board.red.cards.length, 1);
  assert.equal(sCity.players[1].hand.length, 1);

  // B014 Code of Laws: tuck matching color then confirm splay left
  const sLaw0 = makePlayingState();
  meldCardInstance(sLaw0, 'p1', byId('B014', 'p1_law')); // purple
  const extraPurple = byId('B015', 'p1_myst');
  sLaw0.players[0].hand = [extraPurple];
  let sLaw = applyAction(sLaw0, { type: 'dogma', playerId: 'p1', color: 'purple' });
  sLaw = applyAction(sLaw, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: sLaw.pendingPrompts[0].id,
    selectedCardIds: [extraPurple.instanceId],
  });
  assert.equal(sLaw.players[0].board.purple.cards[0].instanceId, extraPurple.instanceId);
  assert.equal(sLaw.pendingPrompts[0].kind, 'choose_yes_no');
  sLaw = applyAction(sLaw, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: sLaw.pendingPrompts[0].id,
    confirmed: true,
  });
  assert.equal(sLaw.players[0].board.purple.splay, 'left');

  // B015 Mysticism: draws [1], if color on board melds it & draws another [1]
  const sMys0 = makePlayingState();
  meldCardInstance(sMys0, 'p1', byId('B015', 'p1_mys')); // purple on board
  fillDeck(sMys0, 1, ['B014', 'B009']);
  const sMys = applyAction(sMys0, { type: 'dogma', playerId: 'p1', color: 'purple' });
  assert.equal(getTopCard(sMys.players[0].board.purple)?.defId, 'B014');
  assert.equal(sMys.players[0].hand[0].defId, 'B009');
});

test('Age 2 B016 CONSTRUCTION, B017 ROAD BUILDING, B018 CANAL BUILDING', () => {
  // B016 Construction: Demand steals up to 2 cards & opponent draws [2]; Ab 2 claims Empire if only player with 5 top cards
  const sCon0 = makePlayingState();
  meldCardInstance(sCon0, 'p1', byId('B016', 'p1_con'));
  meldCardInstance(sCon0, 'p1', byId('B004', 'p1_y'));
  meldCardInstance(sCon0, 'p1', byId('B008', 'p1_g'));
  meldCardInstance(sCon0, 'p1', byId('B012', 'p1_b'));
  meldCardInstance(sCon0, 'p1', byId('B014', 'p1_p'));
  const p2h1 = byId('B001', 'h1');
  const p2h2 = byId('B002', 'h2');
  const p2h3 = byId('B003', 'h3');
  sCon0.players[1].hand = [p2h1, p2h2, p2h3];
  fillDeck(sCon0, 2, ['B021']);

  let sCon = applyAction(sCon0, { type: 'dogma', playerId: 'p1', color: 'red' });
  sCon = applyAction(sCon, {
    type: 'answer_prompt',
    playerId: 'p2',
    promptId: sCon.pendingPrompts[0].id,
    selectedCardIds: [p2h1.instanceId, p2h2.instanceId],
  });
  assert.equal(sCon.players[0].hand.length, 2);
  assert.equal(sCon.players[1].hand.length, 2); // p2h3 + drawn [2]
  assert.ok(sCon.players[0].achievements.some((a) => a.specialId === 'empire'));

  // B017 Road Building: meld 2 -> transfer top red -> meld opponent's top green
  const sRoad0 = makePlayingState();
  const roadRed = byId('B017', 'p1_road');
  meldCardInstance(sRoad0, 'p1', roadRed);
  const p2Green = byId('B021', 'p2_map');
  meldCardInstance(sRoad0, 'p2', p2Green);
  const m1 = byId('B004', 'm1');
  const m2 = byId('B012', 'm2');
  sRoad0.players[0].hand = [m1, m2];

  let sRoad = applyAction(sRoad0, { type: 'dogma', playerId: 'p1', color: 'red' });
  sRoad = applyAction(sRoad, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: sRoad.pendingPrompts[0].id,
    selectedCardIds: [m1.instanceId, m2.instanceId],
  });
  assert.equal(sRoad.pendingPrompts[0].kind, 'choose_option');
  sRoad = applyAction(sRoad, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: sRoad.pendingPrompts[0].id,
    selectedOptionId: 'target_p2',
  });
  assert.equal(getTopCard(sRoad.players[1].board.red)?.instanceId, roadRed.instanceId);
  assert.equal(getTopCard(sRoad.players[0].board.green)?.instanceId, p2Green.instanceId);

  // B018 Canal Building: exchange highest hand & score cards
  const sCanal0 = makePlayingState();
  meldCardInstance(sCanal0, 'p1', byId('B018', 'p1_canal'));
  const handHigh1 = byId('B022', 'hh1');
  const handLow = byId('B001', 'hl');
  const scoreHigh = byId('B019', 'sh1');
  sCanal0.players[0].hand = [handHigh1, handLow];
  scoreCardInstance(sCanal0, 'p1', scoreHigh);
  let sCanal = applyAction(sCanal0, { type: 'dogma', playerId: 'p1', color: 'yellow' });
  sCanal = applyAction(sCanal, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: sCanal.pendingPrompts[0].id,
    selectedOptionId: 'exchange',
  });
  assert.equal(sCanal.players[0].scorePile[0].instanceId, handHigh1.instanceId);
  assert.ok(sCanal.players[0].hand.some((c) => c.instanceId === scoreHigh.instanceId));
});

test('Age 2 B019 FERMENTING, B020 CURRENCY, B021 MAPMAKING', () => {
  // B019 Fermenting: Ab 1 draws [2] per color with leaf; Ab 2 without green (or declining) junks [2] deck & top Fermenting
  const sFerm0 = makePlayingState();
  meldCardInstance(sFerm0, 'p1', byId('B019', 'p1_ferm')); // yellow with leaf
  meldCardInstance(sFerm0, 'p1', byId('B008', 'p1_sail')); // green with leaf
  // Put non-green [2]s (B016 Red, B017 Red) followed by B018, B022 in deck 2 -> no green drawn!
  fillDeck(sFerm0, 2, ['B016', 'B017', 'B018', 'B022']);
  const sFerm = applyAction(sFerm0, { type: 'dogma', playerId: 'p1', color: 'yellow' });
  assert.equal(sFerm.players[0].hand.length, 2);
  assert.equal(sFerm.decks[2].length, 0);
  assert.equal(sFerm.players[0].board.yellow.cards.length, 0); // Fermenting itself junked!
  assert.ok(sFerm.junk.some((c) => c.defId === 'B019'));

  // Also test Fermenting when player draws a Green [2] (B020) in Ab 1 and chooses to tuck it in Ab 2!
  const sFermTuck0 = makePlayingState();
  meldCardInstance(sFermTuck0, 'p1', byId('B019', 'p1_ferm_t'));
  fillDeck(sFermTuck0, 2, ['B020', 'B022']);
  let sFermTuck = applyAction(sFermTuck0, { type: 'dogma', playerId: 'p1', color: 'yellow' });
  assert.equal(sFermTuck.pendingPrompts[0].kind, 'choose_cards');
  sFermTuck = applyAction(sFermTuck, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: sFermTuck.pendingPrompts[0].id,
    selectedCardIds: [sFermTuck.players[0].hand[0].instanceId],
  });
  assert.equal(sFermTuck.decks[2].length, 1); // B022 preserved
  assert.equal(getTopCard(sFermTuck.players[0].board.yellow)?.defId, 'B019'); // Fermenting stays on board!
  assert.equal(sFermTuck.players[0].board.green.cards[0].defId, 'B020'); // Green card tucked!

  // B020 Currency: return cards of 2 distinct values -> draws & scores two [2]
  const sCur0 = makePlayingState();
  meldCardInstance(sCur0, 'p1', byId('B020', 'p1_cur'));
  const v1a = byId('B001', 'v1a');
  const v1b = byId('B002', 'v1b');
  const v2 = byId('B016', 'v2');
  sCur0.players[0].hand = [v1a, v1b, v2];
  fillDeck(sCur0, 2, ['B017', 'B018']);
  let sCur = applyAction(sCur0, { type: 'dogma', playerId: 'p1', color: 'green' });
  sCur = applyAction(sCur, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: sCur.pendingPrompts[0].id,
    selectedCardIds: [v1a.instanceId, v1b.instanceId, v2.instanceId],
  });
  assert.equal(sCur.players[0].scorePile.length, 2);

  // B021 Mapmaking: demand transfers [1] from opponent score pile -> Ab 2 draws & scores [1]
  const sMap0 = makePlayingState();
  meldCardInstance(sMap0, 'p1', byId('B021', 'p1_map')); // 2 coins
  scoreCardInstance(sMap0, 'p2', byId('B001', 'p2_s1'));
  fillDeck(sMap0, 1, ['B004']);
  const sMap = applyAction(sMap0, { type: 'dogma', playerId: 'p1', color: 'green' });
  assert.equal(sMap.players[1].scorePile.length, 0);
  assert.equal(sMap.players[0].scorePile.length, 2); // stolen [1] + drawn [1]
});

test('Age 2 B022 CALENDAR, B023 MATHEMATICS, B024 MONOTHEISM, B025 PHILOSOPHY', () => {
  // B022 Calendar
  const sCal0 = makePlayingState();
  meldCardInstance(sCal0, 'p1', byId('B022', 'p1_cal'));
  scoreCardInstance(sCal0, 'p1', byId('B001', 's1'));
  scoreCardInstance(sCal0, 'p1', byId('B002', 's2'));
  sCal0.players[0].hand = [byId('B003', 'h1')];
  const sCal = applyAction(sCal0, { type: 'dogma', playerId: 'p1', color: 'blue' });
  assert.equal(sCal.players[0].hand.length, 3); // +2 age 3 cards

  // B023 Mathematics
  const sMath0 = makePlayingState();
  meldCardInstance(sMath0, 'p1', byId('B023', 'p1_math'));
  const mRet = byId('B016', 'mret'); // age 2 -> draws & melds [3]
  sMath0.players[0].hand = [mRet];
  let sMath = applyAction(sMath0, { type: 'dogma', playerId: 'p1', color: 'blue' });
  sMath = applyAction(sMath, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: sMath.pendingPrompts[0].id,
    selectedCardIds: [mRet.instanceId],
  });
  assert.equal(sMath.players[0].hand.length, 0);
  const totalTop = Object.values(sMath.players[0].board)
    .flatMap((st) => st.cards)
    .filter((c) => c.age === 3);
  assert.equal(totalTop.length, 1);

  // B024 Monotheism: demand transfers top card of color not on P1 board + P2 tucks [1], then P1 tucks [1]
  const sMono0 = makePlayingState();
  meldCardInstance(sMono0, 'p1', byId('B024', 'p1_mono')); // P1 only has purple (3 towers)
  const p2Red = byId('B001', 'p2_red');
  meldCardInstance(sMono0, 'p2', p2Red); // P2 has red (0 towers? actually 2 towers < 3 towers, and red not on P1 board)
  fillDeck(sMono0, 1, ['B004', 'B008']);
  const sMono = applyAction(sMono0, { type: 'dogma', playerId: 'p1', color: 'purple' });
  assert.equal(sMono.players[0].scorePile[0].instanceId, p2Red.instanceId);
  assert.equal(sMono.players[1].board.yellow.cards[0].defId, 'B004');
  assert.equal(sMono.players[0].board.green.cards[0].defId, 'B008');

  // B025 Philosophy: Ab 1 splay left, Ab 2 score from hand
  const sPhil0 = makePlayingState();
  meldCardInstance(sPhil0, 'p1', byId('B014', 'p1_bot'));
  meldCardInstance(sPhil0, 'p1', byId('B025', 'p1_phil'));
  const sc = byId('B016', 'sc');
  sPhil0.players[0].hand = [sc];
  let sPhil = applyAction(sPhil0, { type: 'dogma', playerId: 'p1', color: 'purple' });
  sPhil = applyAction(sPhil, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: sPhil.pendingPrompts[0].id,
    selectedColor: 'purple',
  });
  assert.equal(sPhil.players[0].board.purple.splay, 'left');
  sPhil = applyAction(sPhil, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: sPhil.pendingPrompts[0].id,
    selectedCardIds: [sc.instanceId],
  });
  assert.equal(sPhil.players[0].scorePile[0].instanceId, sc.instanceId);
});

test('Sharing free draw applies accurately on Age 1/2 conditionals (Calendar no-op vs Sailing share)', () => {
  // Calendar shared by P2 when P2 has score <= hand -> NO card change -> NO free draw!
  const s1 = makePlayingState();
  meldCardInstance(s1, 'p1', byId('B022', 'p1_cal')); // 2 leaves
  meldCardInstance(s1, 'p2', byId('B004', 'p2_agri')); // 2 leaves -> shares!
  s1.players[1].hand = [byId('B001', 'p2_h1')]; // score=0 <= hand=1 -> condition fails!
  s1.players[0].hand = [byId('B002', 'p1_h1')]; // score=0 <= hand=1 -> condition fails!
  const afterCal = applyAction(s1, { type: 'dogma', playerId: 'p1', color: 'blue' });
  assert.equal(afterCal.players[0].hand.length, 1); // No free Draw granted!

  // Now Sailing shared by P2 -> P2 melds [1] -> P1 melds [1] AND gets 1 free Draw!
  const s2 = makePlayingState();
  meldCardInstance(s2, 'p1', byId('B008', 'p1_sail')); // 2 coins
  meldCardInstance(s2, 'p2', byId('B012', 'p2_wri')); // Writing has 1 coin -> let's add 1 more coin
  meldCardInstance(s2, 'p2', byId('B014', 'p2_law')); // 2 coins total -> shares!
  fillDeck(s2, 1, ['B004', 'B009', 'B001']);
  const afterSail = applyAction(s2, { type: 'dogma', playerId: 'p1', color: 'green' });
  assert.equal(afterSail.players[1].board.yellow.cards[0].defId, 'B004');
  assert.equal(getTopCard(afterSail.players[0].board.green)?.defId, 'B009');
  assert.equal(afterSail.players[0].hand.length, 1); // Free Draw received!
});

test('Full AI vs AI matches complete cleanly with real Age 1 & Age 2 Dogma effects across multiple seeds', () => {
  for (const variant of ['1v1', '1v1v1'] as const) {
    for (const seed of [101, 202, 777]) {
      let state = createGame({
        variant,
        controlMode: 'vs_ai',
        playerNames: variant === '1v1' ? ['AI-1', 'AI-2'] : ['AI-1', 'AI-2', 'AI-3'],
        seed,
      });

      let steps = 0;
      while (state.phase !== 'gameover' && steps < 120) {
        const actorId =
          state.pendingPrompts[0]?.playerId ?? state.players[state.currentPlayerIndex].id;
        const view = projectPlayerView(state, actorId);
        const action = chooseAIAction(view);
        state = applyAction(state, action);
        steps += 1;
      }

      assert.ok(state.turnNumber >= 4, `Expected game to progress cleanly for ${variant} seed ${seed}`);
      assert.ok(state.log.length >= 20);
    }
  }
});

test('Edge cases: mid-Dogma waitingOnPlayerId, Canal Building empty-pile exchange, and 1v1v1 Oars loop', () => {
  // 1. Mid-Dogma opponent prompt exposes waitingOnPlayerId to activating player
  const sWait = makePlayingState();
  meldCardInstance(sWait, 'p1', byId('B001', 'p1_arch')); // 2 towers
  sWait.players[1].hand = [byId('B002', 'p2_a'), byId('B003', 'p2_b')]; // tied highest -> prompts p2
  fillDeck(sWait, 1, ['B004']);
  const afterArch = applyAction(sWait, { type: 'dogma', playerId: 'p1', color: 'red' });
  const p1View = projectPlayerView(afterArch, 'p1');
  const p2View = projectPlayerView(afterArch, 'p2');
  assert.equal(p1View.waitingOnPlayerId, 'p2');
  assert.equal(p1View.pendingPromptForViewer, null);
  assert.ok(p2View.pendingPromptForViewer?.kind === 'choose_cards');

  // 2. Canal Building exchange when scorePile is empty still moves highest hand card to scorePile
  const sCan0 = makePlayingState();
  meldCardInstance(sCan0, 'p1', byId('B018', 'p1_can'));
  const h2 = byId('B016', 'h2');
  sCan0.players[0].hand = [byId('B001', 'h1'), h2];
  let sCan = applyAction(sCan0, { type: 'dogma', playerId: 'p1', color: 'yellow' });
  sCan = applyAction(sCan, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: sCan.pendingPrompts[0].id,
    selectedOptionId: 'exchange',
  });
  assert.equal(sCan.players[0].hand.length, 1);
  assert.equal(sCan.players[0].scorePile.length, 1);
  assert.equal(sCan.players[0].scorePile[0].instanceId, h2.instanceId);

  // 3. 1v1v1 Oars: P2 has 0 coin, P3 has 1 coin and draws another coin -> transfers 2, Ab 2 draws 0
  const sOar3 = createGame({
    variant: '1v1v1',
    controlMode: 'vs_ai',
    playerNames: ['P1', 'P2', 'P3'],
    seed: 9,
  });
  sOar3.phase = 'playing';
  sOar3.pendingPrompts = [];
  sOar3.currentPlayerIndex = 0;
  sOar3.players.forEach((p) => {
    p.hand = [];
    p.scorePile = [];
  });
  meldCardInstance(sOar3, 'p1', byId('B003', 'p1_oars')); // 2 towers
  sOar3.players[1].hand = [byId('B002', 'p2_no')]; // no coin
  sOar3.players[2].hand = [byId('B005', 'p3_coin1')]; // coin!
  fillDeck(sOar3, 1, ['B008', 'B002']); // P3 draws Sailing (has coin!), transfers it, draws Metalworking (no coin!)
  const afterOars3 = applyAction(sOar3, { type: 'dogma', playerId: 'p1', color: 'red' });
  assert.equal(afterOars3.players[0].scorePile.length, 2);
  assert.equal(afterOars3.players[2].hand.length, 1);
  assert.equal(afterOars3.players[0].hand.length, 0); // Ab 2 skipped!
});

test('May vs mandatory Dogma enforcement: Philosophy optional vs non-may splay & Road Building mandatory meld', () => {
  // 1. Optional 'may' splay (Philosophy) allows skipping both splay and score
  const sMay = makePlayingState();
  meldCardInstance(sMay, 'p1', byId('B014', 'p1_bot'));
  meldCardInstance(sMay, 'p1', byId('B025', 'p1_phil'));
  sMay.players[0].hand = [byId('B001', 'h1')];
  let resMay = applyAction(sMay, { type: 'dogma', playerId: 'p1', color: 'purple' });
  assert.equal(resMay.pendingPrompts[0]?.kind, 'choose_color');
  assert.equal((resMay.pendingPrompts[0] as { allowSkip: boolean }).allowSkip, true);
  resMay = applyAction(resMay, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: resMay.pendingPrompts[0].id,
  });
  assert.equal(resMay.players[0].board.purple.splay, 'none');
  assert.equal(resMay.pendingPrompts[0]?.kind, 'choose_cards');
  resMay = applyAction(resMay, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: resMay.pendingPrompts[0].id,
    selectedCardIds: [],
  });
  assert.equal(resMay.players[0].scorePile.length, 0);

  // 2. Mandatory non-'may' splay fallback (e.g., future card without 'may') strictly disallows skip
  const sMand = makePlayingState();
  meldCardInstance(sMand, 'p1', byId('B001', 'r1'));
  meldCardInstance(sMand, 'p1', byId('B002', 'r2'));
  meldCardInstance(sMand, 'p1', byId('B004', 'y1'));
  meldCardInstance(sMand, 'p1', {
    instanceId: 'custom_mand_splay',
    defId: 'CUSTOM_MAND',
    age: 3,
    set: 'base',
    name: 'CUSTOM MANDATORY',
    color: 'yellow',
    icons: { tl: 'hexagon', bl: 'coin', bc: 'coin', br: 'coin' },
    featuredIcon: 'coin',
    abilities: [{ index: 1, icon: 'coin', isDemand: false, text: 'Splay right any one color of your cards.' }],
    isPlaceholder: false,
  });
  const resMand = applyAction(sMand, { type: 'dogma', playerId: 'p1', color: 'yellow' });
  assert.equal(resMand.pendingPrompts[0]?.kind, 'choose_color');
  assert.equal((resMand.pendingPrompts[0] as { allowSkip: boolean }).allowSkip, false);
  assert.throws(() =>
    applyAction(resMand, {
      type: 'answer_prompt',
      playerId: 'p1',
      promptId: resMand.pendingPrompts[0].id,
    })
  );
  const aiAnswer = chooseAIAction(projectPlayerView(resMand, 'p1'));
  const resolvedMand = applyAction(resMand, aiAnswer);
  assert.ok(
    resolvedMand.players[0].board.red.splay === 'right' ||
      resolvedMand.players[0].board.yellow.splay === 'right'
  );
});


