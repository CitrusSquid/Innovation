import test from 'node:test';
import assert from 'node:assert/strict';

import { BASE_CARD_DATABASE, instantiateCard } from '../data/cards/catalog';
import { assessSituation, chooseAIAction, computeSplayGainScore, scoreCardForMeld } from './ai';
import { applyAction, createGame } from './engine';
import { meldCardInstance, scoreCardInstance } from './keywords';
import { projectPlayerView } from './playerView';
import type { AIDecisionTrace, Age, CardInstance, GameState } from './types';

function byId(defId: string, suffix = 't'): CardInstance {
  const def = BASE_CARD_DATABASE.find((c) => c.id === defId);
  if (!def) throw new Error(`Missing card ${defId}`);
  return instantiateCard(def, suffix);
}

function makePlayingState(seed = 2026): GameState {
  const state = createGame({
    variant: '1v1',
    controlMode: 'vs_ai',
    playerNames: ['Human', 'AI Archivist'],
    seed,
  });
  state.phase = 'playing';
  state.pendingPrompts = [];
  state.currentPlayerIndex = 1; // AI Archivist (p2) to act
  state.actionsRemaining = 2;
  state.actionsTotalThisTurn = 2;
  state.players[0].hand = [];
  state.players[1].hand = [];
  return state;
}

test('AI never activates Masonry when hand has no Tower cards and Red != 3', () => {
  const state = makePlayingState();
  meldCardInstance(state, 'p2', byId('B006', 'mas')); // Masonry on yellow
  // Hand has Agriculture (no tower)
  state.players[1].hand = [byId('B004', 'agri')];
  const view = projectPlayerView(state, 'p2');
  const action = chooseAIAction(view);

  assert.notEqual(action.type, 'dogma', 'AI must not waste an action activating useless Masonry');
  assert.ok(action.type === 'meld' || action.type === 'draw');
});

test('AI claims Monument via Masonry when holding 3 Red cards and protects 3-Red count', () => {
  const state = makePlayingState();
  meldCardInstance(state, 'p2', byId('B006', 'mas')); // Masonry on yellow
  meldCardInstance(state, 'p2', byId('B001', 'r1'));
  meldCardInstance(state, 'p2', byId('B002', 'r2'));
  meldCardInstance(state, 'p2', byId('B003', 'r3'));
  // Even with a Red card in hand, AI must activate Masonry (claiming Monument) instead of melding a 4th Red!
  state.players[1].hand = [byId('B016', 'r4')];

  const view = projectPlayerView(state, 'p2');
  const situ = assessSituation(view);
  assert.equal(situ.specialPlans.monumentByRed3, true);
  assert.ok(
    scoreCardForMeld(view, state.players[1].hand[0], situ) < 0,
    'Should penalize melding a 4th Red card while 3-Red Monument via Masonry is live'
  );

  const action = chooseAIAction(view);
  assert.deepEqual(action, { type: 'dogma', playerId: 'p2', color: 'yellow' });
});

test('AI refuses useless Dogmas (City States, Mapmaking, Calendar, Code of Laws, Tools) when preconditions fail', () => {
  // City States with opponent having < 4 towers
  const sCity = makePlayingState();
  meldCardInstance(sCity, 'p2', byId('B013', 'cs'));
  meldCardInstance(sCity, 'p1', byId('B001', 'p1_arch')); // only 2 towers (<4)
  assert.notEqual(chooseAIAction(projectPlayerView(sCity, 'p2')).type, 'dogma');

  // Mapmaking when opponent has no [1] in score pile
  const sMap = makePlayingState();
  meldCardInstance(sMap, 'p2', byId('B021', 'map')); // 2 coins
  scoreCardInstance(sMap, 'p1', byId('B016', 'p1_age2')); // age 2, not age 1
  assert.notEqual(chooseAIAction(projectPlayerView(sMap, 'p2')).type, 'dogma');

  // Calendar when score <= hand
  const sCal = makePlayingState();
  meldCardInstance(sCal, 'p2', byId('B022', 'cal'));
  sCal.players[1].hand = [byId('B004', 'h1'), byId('B008', 'h2')];
  scoreCardInstance(sCal, 'p2', byId('B001', 's1'));
  assert.notEqual(chooseAIAction(projectPlayerView(sCal, 'p2')).type, 'dogma');

  // Now enable Mapmaking ([1] in opponent score) and Calendar (score > hand): AI should activate them!
  scoreCardInstance(sMap, 'p1', byId('B001', 'p1_age1'));
  assert.equal(chooseAIAction(projectPlayerView(sMap, 'p2')).type, 'dogma');

  scoreCardInstance(sCal, 'p2', byId('B002', 's2'));
  scoreCardInstance(sCal, 'p2', byId('B003', 's3'));
  assert.equal(chooseAIAction(projectPlayerView(sCal, 'p2')).type, 'dogma');
});

test('AI obeys strict fair-play zero-hidden-info guarantee (identical PlayerView -> identical decision)', () => {
  const stateA = makePlayingState(101);
  const stateB = makePlayingState(101);

  meldCardInstance(stateA, 'p2', byId('B015', 'myst'));
  meldCardInstance(stateB, 'p2', byId('B015', 'myst'));
  stateA.players[1].hand = [byId('B004', 'h1'), byId('B008', 'h2')];
  stateB.players[1].hand = [byId('B004', 'h1'), byId('B008', 'h2')];

  // Completely alter hidden opponent hand fronts & hidden deck orders in stateB (preserving backs/counts)
  const oppCardA = byId('B001', 'o1');
  const oppCardB = byId('B012', 'o1');
  oppCardA.instanceId = 'hidden_opp_1';
  oppCardB.instanceId = 'hidden_opp_1';
  stateA.players[0].hand = [oppCardA];
  stateB.players[0].hand = [oppCardB]; // same age 1 back, different front!
  stateA.decks[1] = [byId('B001', 'd1'), byId('B002', 'd2')];
  stateB.decks[1] = [byId('B008', 'd1'), byId('B009', 'd2')];

  const viewA = projectPlayerView(stateA, 'p2');
  const viewB = projectPlayerView(stateB, 'p2');

  assert.deepEqual(viewA, viewB);
  assert.deepEqual(chooseAIAction(viewA), chooseAIAction(viewB));
});

test('Gunpowder protection: AI prioritizes covering exposed Tower top when Age 4 approaches and Gunpowder location is unknown', () => {
  const state = makePlayingState();
  // Opponent holds an Age 4 card in hand & top Age 3 on board -> Age 4 Gunpowder danger!
  meldCardInstance(state, 'p1', byId('B016', 'p1_constr'));
  const oppAge4 = byId('B016', 'p1_age4');
  oppAge4.age = 4 as Age;
  oppAge4.name = 'Placeholder 4';
  state.players[0].hand = [oppAge4];
  state.decks[4].pop(); // deck 4 touched

  // AI has an exposed Tower card on Yellow (Domestication) and two Age 2 Yellow/Green options in hand:
  // Canal Building (Yellow, NO tower) vs Mapmaking (Green, HAS tower)
  meldCardInstance(state, 'p2', byId('B005', 'p2_dom')); // Yellow with tower!
  const safeCover = byId('B018', 'safe_yellow'); // Yellow Canal Building (no tower)
  const exposedNew = byId('B021', 'green_map'); // Green Mapmaking (has tower on BR)
  state.players[1].hand = [safeCover, exposedNew];

  const viewUnknown = projectPlayerView(state, 'p2');
  const situUnknown = assessSituation(viewUnknown);
  assert.equal(situUnknown.weights.gunpowderThreat, true);

  const coverScore = scoreCardForMeld(viewUnknown, safeCover, situUnknown);
  const newTowerScore = scoreCardForMeld(viewUnknown, exposedNew, situUnknown);
  assert.ok(
    coverScore > newTowerScore,
    `Expected covering exposed Tower (${coverScore.toFixed(1)}) to outscore exposing new Tower (${newTowerScore.toFixed(1)}) under Gunpowder threat`
  );

  // If Gunpowder IS visibly accounted for (e.g. in AI's own score pile), gunpowderThreat turns false!
  const knownGunpowder = byId('B016', 'gp');
  knownGunpowder.age = 4 as Age;
  knownGunpowder.name = 'GUNPOWDER';
  scoreCardInstance(state, 'p2', knownGunpowder);

  const viewKnown = projectPlayerView(state, 'p2');
  assert.equal(assessSituation(viewKnown).weights.gunpowderThreat, false);
});

test('Extremely losing posture shifts AI toward high-age (8-10) recovery plays', () => {
  const state = makePlayingState();
  // Opponent is 1 achievement from winning (5/6), ahead in score & top age
  state.players[0].achievements = [
    { id: 'a1', kind: 'standard', age: 1 },
    { id: 'a2', kind: 'standard', age: 2 },
    { id: 'a3', kind: 'standard', age: 3 },
    { id: 'a4', kind: 'standard', age: 4 },
    { id: 'a5', kind: 'standard', age: 5 },
  ];
  scoreCardInstance(state, 'p1', byId('B016', 'p1s1'));
  scoreCardInstance(state, 'p1', byId('B016', 'p1s2'));
  scoreCardInstance(state, 'p1', byId('B016', 'p1s3'));
  scoreCardInstance(state, 'p1', byId('B016', 'p1s4'));
  scoreCardInstance(state, 'p1', byId('B016', 'p1s5'));

  const p1Top8 = byId('B022', 'p1_top8');
  p1Top8.age = 8 as Age;
  meldCardInstance(state, 'p1', p1Top8);

  // AI has 0 achievements, 0 score, top age 2, and holds an Age 8 card + an Age 2 card
  meldCardInstance(state, 'p2', byId('B022', 'p2_cal'));
  const age2Card = byId('B019', 'low_2');
  const age8Card = byId('B023', 'high_8');
  age8Card.age = 8 as Age;
  age8Card.name = 'Skyscraper Sim';
  state.players[1].hand = [age2Card, age8Card];

  const view = projectPlayerView(state, 'p2');
  const situ = assessSituation(view);
  assert.equal(situ.weights.isExtremelyLosing, true);
  assert.ok(situ.weights.techUpFocus >= 2.0);

  const action = chooseAIAction(view);
  assert.deepEqual(action, {
    type: 'meld',
    playerId: 'p2',
    cardInstanceId: age8Card.instanceId,
  });
});

test('Upgraded AI plays full 1v1 and 1v1v1 matches cleanly to victory without errors', () => {
  for (const variant of ['1v1', '1v1v1'] as const) {
    let state = createGame({
      variant,
      controlMode: 'vs_ai',
      playerNames: variant === '1v1' ? ['AI-1', 'AI-2'] : ['AI-1', 'AI-2', 'AI-3'],
      seed: variant === '1v1' ? 777 : 888,
    });
    for (const p of state.players) p.isAI = true;

    let steps = 0;
    while (state.phase !== 'gameover' && steps < 450) {
      const actorId =
        state.pendingPrompts[0]?.playerId ?? state.players[state.currentPlayerIndex].id;
      const view = projectPlayerView(state, actorId);
      const action = chooseAIAction(view);
      state = applyAction(state, action);
      steps += 1;
    }

    assert.equal(state.phase, 'gameover', `${variant} match should finish cleanly within 450 steps (stopped at ${steps})`);
    assert.ok(state.victory !== null);
  }
});

test('Splaying is valued for future melds even with 0 immediate covered icons, ordered left < right < up < aslant', () => {
  const state = makePlayingState();
  // Create a 2-card blue stack where the covered bottom card has ONLY hexagons on all 4 slots (0 immediate icon gain)
  const hexBottom = byId('B001', 'hex_bot');
  hexBottom.color = 'blue';
  hexBottom.icons = { tl: 'hexagon', bl: 'hexagon', bc: 'hexagon', br: 'hexagon' };
  const strongTop = byId('B022', 'top_cal'); // Blue with leaf, leaf, lightbulb
  meldCardInstance(state, 'p2', hexBottom);
  meldCardInstance(state, 'p2', strongTop);

  // Give AI a splay prompt (allowSkip: true) across only the 2-card blue stack
  state.pendingPrompts = [
    {
      id: 'prompt_splay_test',
      kind: 'choose_color',
      playerId: 'p2',
      title: 'You may splay left any color',
      options: ['blue'],
      allowSkip: true,
      splayDirection: 'left',
    },
  ];
  const view = projectPlayerView(state, 'p2');
  const action = chooseAIAction(view);
  assert.equal(action.type, 'answer_prompt');
  assert.equal(action.selectedColor, 'blue', 'AI should still splay for future-meld benefit even with 0 immediate icon gain');

  // Verify strict splay rank ordering: left < right < up < aslant
  const situ = assessSituation(view);
  const stack = state.players[1].board.blue;
  const sLeft = computeSplayGainScore(stack.cards, 'none', 'left', situ);
  const sRight = computeSplayGainScore(stack.cards, 'none', 'right', situ);
  const sUp = computeSplayGainScore(stack.cards, 'none', 'up', situ);
  const sAslant = computeSplayGainScore(stack.cards, 'none', 'aslant', situ);
  assert.ok(sLeft > 0 && sLeft < sRight && sRight < sUp && sUp < sAslant, `Expected 0 < left(${sLeft}) < right(${sRight}) < up(${sUp}) < aslant(${sAslant})`);
});

test('AI evaluates arbitrary Age 5+ cards generically via board delta and never makes illegal moves', () => {
  const state = makePlayingState();
  // Put an arbitrary Age 5 card with a splay effect on a 1-card stack (fizzles because 1 card cannot splay)
  const arbCard: CardInstance = {
    instanceId: 'arb_5',
    defId: 'CUSTOM_501',
    age: 5 as Age,
    set: 'base',
    name: 'ARBITRARY STEAM',
    color: 'green',
    icons: { tl: 'hexagon', bl: 'factory', bc: 'factory', br: 'clock' },
    featuredIcon: 'factory',
    abilities: [
      { index: 1, icon: 'factory', isDemand: false, text: 'You may splay right any color of your cards.' },
    ],
    isPlaceholder: false,
  };
  meldCardInstance(state, 'p2', arbCard); // Only green on board (1 card -> splay fizzles!)

  const viewNoRed = projectPlayerView(state, 'p2');
  const actFizzle = chooseAIAction(viewNoRed);
  assert.notEqual(actFizzle.type, 'dogma', 'AI calculates that arbitrary Age 5 card fizzles without needing card-specific code');

  // Now put 2 Red cards on board (bottom Archery, top Oars) + 2 weak cards in hand so arbitrary Age 5 card splays Red right!
  meldCardInstance(state, 'p2', byId('B001', 'r1'));
  meldCardInstance(state, 'p2', byId('B003', 'r2'));
  const viewWithRed = projectPlayerView(state, 'p2');
  const actGood = chooseAIAction(viewWithRed);
  assert.deepEqual(actGood, { type: 'dogma', playerId: 'p2', color: 'green' });
});

test('Opponent lookahead: AI avoids drawing a high-level card or melding an unprotected color that opponent can immediately steal', () => {
  // Case A: Opponent has Archery (more Towers); on AI's last action (actionsRemaining = 1) at topAge 3,
  // drawing [3] just feeds [3] to Archery, whereas safe board/low dogma avoids handing over a [3]!
  const sArch = makePlayingState(909);
  sArch.actionsRemaining = 1;
  sArch.actionsTotalThisTurn = 2;
  meldCardInstance(sArch, 'p1', byId('B001', 'p1_arch')); // p1 has Archery (2 towers)
  meldCardInstance(sArch, 'p2', byId('B004', 'p2_agri')); // 0 towers
  meldCardInstance(sArch, 'p2', byId('B010', 'p2_pot'));  // 0 towers
  meldCardInstance(sArch, 'p2', byId('B014', 'p2_col'));  // 0 towers
  const p2Top3 = byId('B008', 'p2_sail3'); // Sailing on Green (0 towers), bumped to Age 3
  p2Top3.age = 3 as Age;
  meldCardInstance(sArch, 'p2', p2Top3);

  const actUnderThreat = chooseAIAction(projectPlayerView(sArch, 'p2'));
  assert.equal(
    actUnderThreat.type,
    'dogma',
    'AI should avoid drawing a [3] into Archery theft on final action when safer dogma play exists'
  );

  // If opponent has NO Archery/tower theft (e.g., The Wheel with 0 towers), AI happily draws [3] to advance tech!
  const sSafe = makePlayingState(909);
  sSafe.actionsRemaining = 1;
  sSafe.actionsTotalThisTurn = 2;
  meldCardInstance(sSafe, 'p1', byId('B009', 'p1_wheel'));
  meldCardInstance(sSafe, 'p2', byId('B004', 'p2_agri_s'));
  meldCardInstance(sSafe, 'p2', byId('B010', 'p2_pot_s'));
  meldCardInstance(sSafe, 'p2', byId('B014', 'p2_col_s'));
  const p2Top3Safe = byId('B008', 'p2_sail3_safe');
  p2Top3Safe.age = 3 as Age;
  meldCardInstance(sSafe, 'p2', p2Top3Safe);

  const actSafe = chooseAIAction(projectPlayerView(sSafe, 'p2'));
  assert.equal(actSafe.type, 'draw', 'AI should value drawing [3] to advance tech when opponent cannot steal it');

  // Case B: Opponent has Monotheism (more Towers) and already has Yellow on board, NOT Blue.
  // AI on final action chooses safe Yellow meld instead of melding Blue [3] just to have Monotheism steal it!
  const sMono = makePlayingState(910);
  sMono.actionsRemaining = 1;
  sMono.actionsTotalThisTurn = 2;
  meldCardInstance(sMono, 'p1', byId('B024', 'p1_mono')); // Monotheism (4 towers on Purple)
  meldCardInstance(sMono, 'p1', byId('B005', 'p1_yel'));  // Yellow present on p1 board
  const safeYellow = byId('B018', 'p2_yel2');
  const exposedBlue3 = byId('B022', 'p2_blu3');
  exposedBlue3.age = 3 as Age;
  sMono.players[1].hand = [safeYellow, exposedBlue3];

  const actMono = chooseAIAction(projectPlayerView(sMono, 'p2'));
  assert.deepEqual(actMono, {
    type: 'meld',
    playerId: 'p2',
    cardInstanceId: safeYellow.instanceId,
  });
});

test('AI never loops Code of Laws -> Decline to Tuck (with Monotheism active or covered)', () => {
  for (const coverMonotheism of [false, true]) {
    let state = makePlayingState(404);
    // Opponent has Monotheism on Purple (either active or covered under Philosophy)
    meldCardInstance(state, 'p1', byId('B024', 'p1_mono'));
    if (coverMonotheism) {
      meldCardInstance(state, 'p1', byId('B025', 'p1_phil'));
    }

    // AI has Code of Laws (Purple) and a Purple or Red card already on board + matching card in hand
    meldCardInstance(state, 'p2', byId('B014', 'p2_col'));
    meldCardInstance(state, 'p2', byId('B001', 'p2_arch')); // Red on board
    state.players[1].hand = [byId('B003', 'p2_oars')]; // Red card matching Red on board

    const firstAction = chooseAIAction(projectPlayerView(state, 'p2'));
    if (firstAction.type === 'dogma' && firstAction.color === 'purple') {
      state = applyAction(state, firstAction);
      // Resolve any prompts from Code of Laws; AI MUST NOT decline to tuck!
      let tucked = false;
      let steps = 0;
      while (state.pendingPrompts.length > 0 && steps < 6) {
        const prompt = state.pendingPrompts[0];
        const ans = chooseAIAction(projectPlayerView(state, prompt.playerId));
        if (
          prompt.playerId === 'p2' &&
          prompt.kind === 'choose_cards' &&
          ans.type === 'answer_prompt' &&
          ans.selectedCardIds &&
          ans.selectedCardIds.length > 0
        ) {
          tucked = true;
        }
        state = applyAction(state, ans);
        steps += 1;
      }
      assert.equal(
        tucked,
        true,
        `AI activated Code of Laws (coverMonotheism=${coverMonotheism}) and must actually tuck rather than declining in a loop`
      );
    }
  }
});

test('AI decision trace populates real factor breakdown matching candidate score cleanly', () => {
  const state = makePlayingState(515);
  meldCardInstance(state, 'p2', byId('B001', 'p2_arch'));
  meldCardInstance(state, 'p1', byId('B009', 'p1_wheel'));
  state.players[1].hand = [byId('B008', 'p2_sail'), byId('B004', 'p2_agri')];
  state.players[1].scorePile = [byId('B011', 'p2_sc5')]; // 2 pts

  const view = projectPlayerView(state, 'p2');
  // Without trace: returns valid action with zero trace object
  const fastAction = chooseAIAction(view);
  assert.ok(fastAction.type);

  // With trace: populates candidate breakdowns whose numeric sum closely matches candidate.score
  const trace: AIDecisionTrace = {
    id: '',
    turn: 1,
    actorId: 'p2',
    actorName: 'AI Archivist',
    actionLabel: '',
    situationSummary: '',
    chosenLabel: '',
    candidates: [],
  };
  const tracedAction = chooseAIAction(view, trace);
  assert.deepEqual(tracedAction, fastAction, 'Traced decision must be identical to untraced decision');
  assert.ok(trace.candidates.length >= 2);
  for (const cand of trace.candidates) {
    assert.ok(Array.isArray(cand.breakdown) && cand.breakdown.length > 0, `Expected non-empty breakdown for ${cand.label}`);
    const factorSum = cand.breakdown.reduce((acc, f) => acc + f.delta, 0);
    assert.ok(
      Math.abs(factorSum - cand.score) < 0.25,
      `Breakdown factor sum (${factorSum}) should match candidate score (${cand.score}) for ${cand.label}`
    );
  }
});

test('2v2 AI evaluates team situation cleanly (avoids self-team demand confusion and completes full 2v2 AI vs AI match)', () => {
  // Verify assessSituation separates ally from enemies in 2v2
  const s2v2 = createGame({
    variant: '2v2',
    playerNames: ['North', 'East', 'South', 'West'],
    playerIsAI: [true, true, true, true],
    seed: 2029,
  });
  s2v2.phase = 'playing';
  s2v2.pendingPrompts = [];
  s2v2.currentPlayerIndex = 0;
  s2v2.actionsRemaining = 2;

  // Give Ally (p3) Archery (towers) and verify assessSituation separates ally from enemies
  meldCardInstance(s2v2, 'p3', byId('B001', 'ally_arch'));
  meldCardInstance(s2v2, 'p1', byId('B012', 'me_wr')); // Writing (lightbulb)
  scoreCardInstance(s2v2, 'p3', byId('B050', 'ally_pts')); // Age 5 card for ally

  const v1 = projectPlayerView(s2v2, 'p1');
  const situ1 = assessSituation(v1);
  // Enemy (B1, B2) has 0 towers, Ally (p3) has 2 towers -> opponents[] and maxOppIconTotal exclude ally
  assert.deepEqual(
    situ1.opponents.map((o) => o.id),
    ['p2', 'p4']
  );
  assert.equal(situ1.maxOppIconTotal, 0);
  assert.equal(situ1.weights.isLosingBoard, false, 'Teammate board must not count as opponent pressure');
  assert.equal(situ1.weights.isLosingPoints, false, 'Teammate score counts toward team points');

  // Run a full 2v2 AI vs AI simulated match until gameover (or clean safety cap)
  let sim = createGame({
    variant: '2v2',
    playerNames: ['AI North', 'AI East', 'AI South', 'AI West'],
    playerIsAI: [true, true, true, true],
    seed: 4040,
  });
  let steps = 0;
  while (sim.phase !== 'gameover' && steps < 1800) {
    if (sim.phase === 'setup') {
      const pending = sim.pendingPrompts.find((p) => p.kind === 'setup_meld');
      assert.ok(pending, 'Expected setup_meld prompt during setup');
      const action = chooseAIAction(projectPlayerView(sim, pending.playerId));
      sim = applyAction(sim, action);
    } else if (sim.pendingPrompts.length > 0) {
      const prompt = sim.pendingPrompts[0];
      const action = chooseAIAction(projectPlayerView(sim, prompt.playerId));
      sim = applyAction(sim, action);
    } else {
      const active = sim.players[sim.currentPlayerIndex];
      const action = chooseAIAction(projectPlayerView(sim, active.id));
      sim = applyAction(sim, action);
    }
    steps++;
  }
  assert.equal(sim.phase, 'gameover', `2v2 AI vs AI match should finish cleanly (reached step ${steps})`);
  assert.ok(sim.victory && sim.victory.winnerPlayerIds.length === 2, '2v2 victory should credit both teammates');
});

test('1v1v1 mixed Human/AI configuration initializes correctly and AI completes turns cleanly', () => {
  let sim = createGame({
    variant: '1v1v1',
    playerNames: ['Player 1', 'AI Rival 1', 'AI Rival 2'],
    playerIsAI: [false, true, true],
    seed: 5050,
  });
  assert.deepEqual(
    sim.players.map((p) => p.isAI),
    [false, true, true]
  );

  // Resolve setup: Player 1 picks first card manually, AI players use chooseAIAction
  for (let i = 0; i < 6 && sim.phase === 'setup'; i++) {
    const prompt = sim.pendingPrompts[0];
    if (!prompt) break;
    const p = sim.players.find((pl) => pl.id === prompt.playerId)!;
    const action = p.isAI
      ? chooseAIAction(projectPlayerView(sim, p.id))
      : { type: 'setup_meld' as const, playerId: p.id, cardInstanceId: p.hand[0].instanceId };
    sim = applyAction(sim, action);
  }
  assert.equal(sim.phase, 'playing');

  // Play 6 actions through mixed human/AI turn cycle without error
  for (let step = 0; step < 12 && sim.phase === 'playing'; step++) {
    if (sim.pendingPrompts.length > 0) {
      const prompt = sim.pendingPrompts[0];
      const p = sim.players.find((pl) => pl.id === prompt.playerId)!;
      const ans = chooseAIAction(projectPlayerView(sim, p.id));
      sim = applyAction(sim, ans);
    } else {
      const active = sim.players[sim.currentPlayerIndex];
      const act = active.isAI
        ? chooseAIAction(projectPlayerView(sim, active.id))
        : { type: 'draw' as const, playerId: active.id };
      sim = applyAction(sim, act);
    }
  }
  assert.ok(sim.turnNumber >= 2);
});

test('gunpowderThreat remains false in Age 1/2 when Age 4 achievement uses 1 card (deckCounts[4] === 9) and opponents are < Age 3', () => {
  const state = makePlayingState(818);
  // createGame places 1 Age 4 card into standardAchievements, leaving deckCounts[4] === 9
  assert.equal(state.decks[4].length, 9);

  // Even if AI itself has an Age 3 card on board/hand, opponents only have Age 1-2 cards
  meldCardInstance(state, 'p1', byId('B001', 'opp_age1'));
  meldCardInstance(state, 'p2', byId('B026', 'ai_age3')); // Compass [3]
  state.players[1].hand = [byId('B027', 'ai_hand3')];

  const situEarly = assessSituation(projectPlayerView(state, 'p2'));
  assert.equal(
    situEarly.weights.gunpowderThreat,
    false,
    'gunpowderThreat must NOT trigger early just because standardAchievements removed 1 card from Age 4 deck'
  );

  // Once an opponent reaches Age 3 top card (approaching Age 4), gunpowderThreat engages if Gunpowder is unseen
  meldCardInstance(state, 'p1', byId('B028', 'opp_age3')); // Engineering [3]
  const situMid = assessSituation(projectPlayerView(state, 'p2'));
  assert.equal(
    situMid.weights.gunpowderThreat,
    true,
    'gunpowderThreat should activate once an opponent reaches Age 3 with Gunpowder unseen'
  );
});





