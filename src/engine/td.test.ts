import assert from 'node:assert/strict';
import test from 'node:test';
import { formatAgeCountsCompact, groupCountByAge } from '../components/CardView';
import { BASE_CARD_DATABASE, instantiateCard } from '../data/cards/catalog';
import { applyAction, createGame } from './engine';
import { projectPlayerView } from './playerView';
import {
  extractTDFeatures,
  extractTDFeaturesFromState,
  TD_BASE_FEATURE_SIZE,
  TD_CARD_COUNT,
  TD_FEATURE_VERSION,
  TD_INPUT_SIZE,
} from './tdFeatures';
import {
  createForwardWorkspace,
  createRandomFunnelModel,
  createTrainWorkspace,
  forwardTDFunnel,
  hydrateTDModel,
  serializeTDModel,
  TD_DEFAULT_BATCH_SIZE,
  TD_HIDDEN_1,
  TD_HIDDEN_2,
  trainTDPairsMiniBatch,
  updateEpisodeTrajectoryTDLambda,
  validateTDModelBundle,
} from './tdNetwork';
import { chooseTDActionWithModel } from './tdPlanner';
import {
  buildModelBundleFromMap,
  computeHeuristicDistillTarget,
  getMixedHeuristicSeatSet,
  TD_DEFAULT_DISTILL_WEIGHT,
  trainVariantModel,
} from './tdTrainer';
import {
  computeArenaStats,
  extractVictoryCardName,
  formatBenchmarkLogText,
  formatVictoryDetailLabel,
  runHeadlessBenchmarkMatch,
  sortHandCards,
  type BenchmarkMatchResult,
} from './tdBenchmark';
import {
  getActiveTDModel,
  getAIDifficultyProfile,
  hasTrainedTDWeights,
  importTDWeightBundleJson,
  normalizeAIBackend,
  resetTDWeights,
} from './tdWeights';
import { generateRandomSeed } from './rng';
import { computeIsHorizontalView, DEFAULT_SETTINGS } from './settings';
import type { AIDecisionTrace, CardDefinition, GameState } from './types';

function findDef(id: string): CardDefinition {
  const def = BASE_CARD_DATABASE.find((c) => c.id === id);
  if (!def) throw new Error(`Missing card ${id}`);
  return def;
}

test('fastSimulation skips log/chronology allocations and matches core rules', () => {
  const normal = createGame({
    variant: '1v1',
    playerNames: ['P1', 'P2'],
    playerIsAI: [true, true],
    seed: 12345,
  });
  const fast = createGame({
    variant: '1v1',
    playerNames: ['P1', 'P2'],
    playerIsAI: [true, true],
    seed: 12345,
    fastSimulation: true,
  });

  assert.equal(fast.log.length, 0);
  assert.equal(fast.chronologyEvents, undefined);
  assert.ok(normal.log.length > 0);

  const act1 = { type: 'setup_meld' as const, playerId: 'p1', cardInstanceId: normal.players[0].hand[0].instanceId };
  const act2 = { type: 'setup_meld' as const, playerId: 'p2', cardInstanceId: normal.players[1].hand[0].instanceId };

  const nNext = applyAction(applyAction(normal, act1), act2);
  const fNext = applyAction(applyAction(fast, act1, { mutateInPlace: true }), act2, {
    mutateInPlace: true,
  });

  assert.equal(fNext.phase, nNext.phase);
  assert.equal(fNext.currentPlayerIndex, nNext.currentPlayerIndex);
  assert.equal(fNext.players[0].board.red.cards.length, nNext.players[0].board.red.cards.length);
  assert.equal(fNext.log.length, 0);
});

test('extractTDFeatures outputs 1229 v3 features, encodes turn-ownership & 2v2 synergy, and differentiates top/splayed/hand card IDs', () => {
  const state = createGame({
    variant: '2v2',
    playerNames: ['A1', 'B1', 'A2', 'B2'],
    playerIsAI: [true, true, true, true],
    playerAIBackends: ['td', 'heuristic', 'td', 'heuristic'],
    seed: 99,
  });
  // Resolve setup
  let cur = applyAction(state, {
    type: 'setup_meld',
    playerId: 'p1',
    cardInstanceId: state.players[0].hand[0].instanceId,
  });
  cur = applyAction(cur, {
    type: 'setup_meld',
    playerId: 'p2',
    cardInstanceId: cur.players[1].hand[0].instanceId,
  });
  cur = applyAction(cur, {
    type: 'setup_meld',
    playerId: 'p3',
    cardInstanceId: cur.players[2].hand[0].instanceId,
  });
  cur = applyAction(cur, {
    type: 'setup_meld',
    playerId: 'p4',
    cardInstanceId: cur.players[3].hand[0].instanceId,
  });

  // Craft explicit 2v2 state for team achievements, ally score proximity, and ally Dogma alignment
  const p1 = cur.players[0]; // Team A
  const p2 = cur.players[1]; // Team B
  const p3 = cur.players[2]; // Team A ally
  const p4 = cur.players[3]; // Team B

  // Clear boards to set exact icons
  for (const pl of cur.players) {
    pl.board.red.cards = [];
    pl.board.yellow.cards = [];
    pl.board.green.cards = [];
    pl.board.blue.cards = [];
    pl.board.purple.cards = [];
    pl.scorePile = [];
    pl.achievements = [];
  }

  // Put Age 1 Writing (B014: blue, lightbulb icons) on p1 & p3; weaker on opps
  const writing1 = instantiateCard(findDef('B014'), 'test_w1');
  const writing2 = instantiateCard(findDef('B014'), 'test_w2');
  const writing3 = instantiateCard(findDef('B014'), 'test_w3');
  p1.board.blue.cards.push(writing1);
  // p3 gets extra lightbulb cards so allyIcons[lightbulb] >= selfIcons[lightbulb]
  p3.board.blue.cards.push(writing2, writing3);
  p3.board.blue.splay = 'left';
  // Opponents have zero lightbulbs (no opponent majority)

  // Combined team achievements: p1 has 1, p3 has 1 => 2/4 = 0.5
  p1.achievements.push({ id: 'ach1', kind: 'standard', age: 1 });
  p3.achievements.push({ id: 'ach2', kind: 'standard', age: 2 });
  // Ally score = 10; lowest unclaimed standard ach = Age 1 (cost 5 => capped 1.5 or higher)
  p3.scorePile.push(instantiateCard(findDef('B015'), 's1'), instantiateCard(findDef('B001'), 's2'));

  const viewHidden = projectPlayerView(cur, 'p1');
  const viewRevealed = projectPlayerView(cur, 'p1', { revealHidden: true });

  const featsA = extractTDFeatures(viewHidden);
  const featsB = extractTDFeatures(viewRevealed);

  assert.equal(featsA.length, TD_INPUT_SIZE);
  for (let i = 0; i < featsA.length; i++) {
    assert.ok(Number.isFinite(featsA[i]), `Feature ${i} should be finite`);
    assert.equal(featsA[i], featsB[i], `Feature ${i} must ignore revealHidden`);
  }

  // Block C begins at index 284:
  // 284: combined team ach / 4 => 2 / 4 = 0.5
  assert.equal(featsA[284], 0.5);
  // 289: ally score proximity to next achievement (> 0)
  assert.ok(featsA[289] > 0);
  // Blue is color index 3 => per-color alignment offset = 284 + 10 + 3*2 = 300
  assert.equal(featsA[300], 1, 'Blue ally sharing alignment should be 1');

  // Verify extractTDFeaturesFromState matches extractTDFeatures(projectPlayerView) bit-for-bit
  const featsState2v2 = extractTDFeaturesFromState(cur, 'p1');
  assert.deepEqual(featsState2v2, featsA);

  // Verify Block E card-identity channels distinguish top card vs splay-exposed stack card vs hand card
  assert.equal(TD_FEATURE_VERSION, 3);
  assert.equal(TD_BASE_FEATURE_SIZE, 424);
  assert.equal(TD_CARD_COUNT, 115);
  assert.equal(TD_INPUT_SIZE, TD_BASE_FEATURE_SIZE + 7 * 115);
  assert.equal(TD_INPUT_SIZE, 1229);

  // Verify D5 turn-ownership features (indices 420..423) differentiate my turn vs opponent turn
  cur.currentPlayerIndex = 0; // p1's turn
  cur.actionsRemaining = 2;
  const featsMyTurn = extractTDFeatures(projectPlayerView(cur, 'p1'));
  assert.equal(featsMyTurn[420], 1, 'isViewerTurn should be 1 when viewer is active');
  assert.equal(featsMyTurn[421], 0, 'isAllyTurn should be 0 when viewer is active');
  assert.equal(featsMyTurn[422], 1, 'selfActionsRemaining should be 1 with 2 actions');
  assert.equal(featsMyTurn[423], 0, 'otherActionsRemaining should be 0 on viewer turn');

  cur.currentPlayerIndex = 2; // p3 (2v2 ally)'s turn
  cur.actionsRemaining = 1;
  const featsAllyTurn = extractTDFeatures(projectPlayerView(cur, 'p1'));
  assert.equal(featsAllyTurn[420], 0);
  assert.equal(featsAllyTurn[421], 1);
  assert.equal(featsAllyTurn[422], 0);
  assert.equal(featsAllyTurn[423], 0.5);

  const b014Idx = BASE_CARD_DATABASE.findIndex((c) => c.id === 'B014');
  const b015Idx = BASE_CARD_DATABASE.findIndex((c) => c.id === 'B015');
  assert.ok(b014Idx >= 0 && b015Idx >= 0);
  // p1 has Writing (B014) on top -> Channel 0 (Self Top)
  assert.equal(featsA[TD_BASE_FEATURE_SIZE + b014Idx], 1);
  // p3 is 2v2 ally with Writing (B014) on top + splayed -> Channel 6 (Ally Board)
  assert.equal(featsA[TD_BASE_FEATURE_SIZE + 6 * TD_CARD_COUNT + b014Idx], 1);

  for (const variant of ['1v1', '1v1v1'] as const) {
    const g = createGame({
      variant,
      playerNames: variant === '1v1' ? ['P1', 'P2'] : ['P1', 'P2', 'P3'],
      seed: 321,
    });
    const fState = extractTDFeaturesFromState(g, 'p1');
    const fView = extractTDFeatures(projectPlayerView(g, 'p1'));
    assert.deepEqual(fState, fView, `extractTDFeaturesFromState must match PlayerView in ${variant}`);
  }
});

test('Block E distinguishes top vs splayed vs unsplayed stack cards and exact hand card IDs in 1v1', () => {
  const g = createGame({
    variant: '1v1',
    playerNames: ['P1', 'P2'],
    seed: 777,
  });
  let s = applyAction(g, {
    type: 'setup_meld',
    playerId: 'p1',
    cardInstanceId: g.players[0].hand[0].instanceId,
  });
  s = applyAction(s, {
    type: 'setup_meld',
    playerId: 'p2',
    cardInstanceId: s.players[1].hand[0].instanceId,
  });

  const p1 = s.players[0];
  const p2 = s.players[1];
  p1.board.red.cards = [
    instantiateCard(findDef('B001'), 'arch_stack'), // buried / splayed
    instantiateCard(findDef('B007'), 'oars_top'),   // top
  ];
  p1.board.red.splay = 'none';
  p1.hand = [instantiateCard(findDef('B014'), 'writing_hand')];
  p2.board.blue.cards = [instantiateCard(findDef('B013'), 'tools_opp')];

  const vUnsplayed = extractTDFeatures(projectPlayerView(s, 'p1'));
  const archIdx = BASE_CARD_DATABASE.findIndex((c) => c.id === 'B001');
  const oarsIdx = BASE_CARD_DATABASE.findIndex((c) => c.id === 'B007');
  const writingIdx = BASE_CARD_DATABASE.findIndex((c) => c.id === 'B014');
  const toolsIdx = BASE_CARD_DATABASE.findIndex((c) => c.id === 'B013');

  // Channel 0: Self Top (Oars = 1, Archery = 0)
  assert.equal(vUnsplayed[TD_BASE_FEATURE_SIZE + oarsIdx], 1);
  assert.equal(vUnsplayed[TD_BASE_FEATURE_SIZE + archIdx], 0);
  // Channel 1: Self Stack (Archery = 0.35 when unsplayed)
  assert.ok(Math.abs(vUnsplayed[TD_BASE_FEATURE_SIZE + TD_CARD_COUNT + archIdx] - 0.35) < 1e-6);
  // Channel 2: Self Hand (Writing = 1)
  assert.equal(vUnsplayed[TD_BASE_FEATURE_SIZE + 2 * TD_CARD_COUNT + writingIdx], 1);
  // Channel 3: Primary Opp Top (Tools = 1)
  assert.equal(vUnsplayed[TD_BASE_FEATURE_SIZE + 3 * TD_CARD_COUNT + toolsIdx], 1);

  // Splaying red right promotes buried Archery weight from 0.35 to 1.0 in Channel 1
  p1.board.red.splay = 'right';
  const vSplayed = extractTDFeatures(projectPlayerView(s, 'p1'));
  assert.equal(vSplayed[TD_BASE_FEATURE_SIZE + TD_CARD_COUNT + archIdx], 1);

  // Check alternating mixed-league Heuristic seats across P1 and P2 in 1v1
  assert.equal(getMixedHeuristicSeatSet('1v1', 0).size, 0);
  assert.deepEqual([...getMixedHeuristicSeatSet('1v1', 2)], ['p2']);
  assert.deepEqual([...getMixedHeuristicSeatSet('1v1', 5)], ['p1']);
});

test('2-layer funnel MLP (1229 -> 192 -> 80 -> out) supports mini-batch Adam (32), zero pruning, TD(lambda), and bundle validation', () => {
  const model2v2 = createRandomFunnelModel('2v2', 'tanh', 42);
  assert.equal(model2v2.inputSize, TD_INPUT_SIZE);
  assert.equal(model2v2.hidden1Size, TD_HIDDEN_1);
  assert.equal(model2v2.hidden2Size, TD_HIDDEN_2);
  assert.equal(model2v2.outputSize, 2);
  assert.equal(TD_DEFAULT_BATCH_SIZE, 32);

  const model3p = createRandomFunnelModel('1v1v1', 'leaky_relu', 77);
  assert.equal(model3p.outputSize, 3);

  const x = new Float32Array(TD_INPUT_SIZE);
  x[0] = 1;
  x[5] = 0.8;
  x[284] = 0.75;

  const p2 = forwardTDFunnel(model2v2, x, createForwardWorkspace(2));
  assert.ok(Math.abs(p2[0] + p2[1] - 1) < 1e-5);

  const p3 = forwardTDFunnel(model3p, x, createForwardWorkspace(3));
  assert.ok(Math.abs(p3[0] + p3[1] + p3[2] - 1) < 1e-5);

  // Backward TD(lambda) update moves prediction toward win [1, 0]
  const ws = createTrainWorkspace(model2v2);
  const before = p2[0];
  const traj = [Float32Array.from(x), Float32Array.from(x)];
  const target = new Float32Array([1, 0]);
  for (let iter = 0; iter < 15; iter++) {
    updateEpisodeTrajectoryTDLambda(model2v2, traj, target, 0.7, 0.02, ws);
  }
  const after = forwardTDFunnel(model2v2, x, ws)[0];
  assert.ok(after > before, `Expected win prob to rise (${before} -> ${after})`);

  // Verify mini-batch Adam (batchSize=32) steadily decreases loss across repeated batches
  const mbModel = createRandomFunnelModel('1v1', 'tanh', 101);
  const mbWs = createTrainWorkspace(mbModel);
  const xs = Array.from({ length: 32 }, (_, i) => {
    const v = new Float32Array(TD_INPUT_SIZE);
    v[0] = 1;
    v[5] = (i % 5) * 0.2;
    return v;
  });
  const ys = Array.from({ length: 32 }, () => new Float32Array([0.85, 0.15]));
  const firstRes = trainTDPairsMiniBatch(mbModel, xs, ys, 32, 0.004, mbWs, 3e-5);
  let lastRes = firstRes;
  for (let step = 0; step < 12; step++) {
    lastRes = trainTDPairsMiniBatch(mbModel, xs, ys, 32, 0.004, mbWs, 3e-5);
  }
  assert.ok(
    lastRes.lossSum < firstRes.lossSum,
    `Expected mini-batch Adam loss to decrease (${firstRes.lossSum} -> ${lastRes.lossSum})`
  );

  // Verify zero pruning in serializeTDModel: small weights like 0.005 must NOT be pruned to 0
  model2v2.w1[0] = 0.005;
  model2v2.w1[1] = 0.45;
  const bundle = buildModelBundleFromMap({ '2v2': model2v2, '1v1v1': model3p });
  const jsonText = JSON.stringify(bundle);
  const checked = validateTDModelBundle(JSON.parse(jsonText));
  assert.equal(checked.valid, true);
  assert.equal(checked.bundle?.featureVersion, TD_FEATURE_VERSION);
  assert.equal(checked.bundle?.variants['2v2']?.w2.length, TD_HIDDEN_1 * TD_HIDDEN_2);
  assert.equal(checked.bundle?.variants['2v2']?.w1[0], 0.005, 'Small weights must be preserved (zero pruning)');

  const rehydrated = hydrateTDModel(checked.bundle!.variants['2v2']!);
  assert.deepEqual(rehydrated.w3.length, model2v2.w3.length);

  // Reject v2 or mismatched bundle
  const bad = validateTDModelBundle({ schemaVersion: 1, featureVersion: 2, variants: {} });
  assert.equal(bad.valid, false);
});

test('TD Expectiminimax AI plays full 1v1 and 2v2 matches cleanly and emits win% decision trace', () => {
  for (const variant of ['1v1', '2v2'] as const) {
    const model = getActiveTDModel(variant);
    const n = variant === '1v1' ? 2 : 4;
    let state: GameState = createGame({
      variant,
      playerNames: Array.from({ length: n }, (_, i) => `TD_${i + 1}`),
      playerIsAI: Array.from({ length: n }, () => true),
      playerAIBackends: Array.from({ length: n }, () => 'td'),
      seed: variant === '1v1' ? 888 : 999,
      fastSimulation: true,
    });

    let capturedTrace = false;
    let steps = 0;
    while (state.phase !== 'gameover' && steps < 400) {
      steps += 1;
      const actorId =
        state.pendingPrompts[0]?.playerId ?? state.players[state.currentPlayerIndex].id;
      const pv = projectPlayerView(state, actorId);
      const trace: AIDecisionTrace | undefined =
        !capturedTrace && state.phase === 'playing' && !pv.pendingPromptForViewer
          ? {
              id: '',
              turn: state.turnNumber,
              actorId,
              actorName: actorId,
              actionLabel: '',
              situationSummary: '',
              chosenLabel: '',
              candidates: [],
            }
          : undefined;
      const action = chooseTDActionWithModel(pv, model, trace, {
        drawSamples: 3,
        dogmaSamples: 1,
        enableOpponentReply: false,
      });
      if (trace && trace.candidates.length > 0) {
        capturedTrace = true;
        assert.ok(trace.actionLabel.startsWith('TD AI'));
        assert.ok(trace.situationSummary.includes('Est Win'));
      }
      state = applyAction(state, action, { mutateInPlace: true });
    }
    assert.ok(capturedTrace, `Should emit TD decision trace in ${variant}`);
  }
});

test('chooseTDActionWithModel simulates direct prompts and responds to TD weights without Heuristic delegation', () => {
  const g = createGame({
    variant: '1v1',
    playerNames: ['P1', 'P2'],
    playerIsAI: [true, true],
    seed: 2026,
  });
  let s = applyAction(g, {
    type: 'setup_meld',
    playerId: 'p1',
    cardInstanceId: g.players[0].hand[0].instanceId,
  });
  s = applyAction(s, {
    type: 'setup_meld',
    playerId: 'p2',
    cardInstanceId: s.players[1].hand[0].instanceId,
  });

  // Put two green cards on p1 board (B008 Sailing has br=leaf) and set a direct choose_color splay prompt
  s.players[0].board.green.cards = [
    instantiateCard(findDef('B008'), 'g1'), // Sailing (br: leaf)
    instantiateCard(findDef('B009'), 'g2'), // The Wheel
  ];
  s.players[0].board.green.splay = 'none';
  s.players[0].board.red.cards = [
    instantiateCard(findDef('B001'), 'r1'), // Archery (br: tower)
    instantiateCard(findDef('B003'), 'r2'), // Oars
  ];
  s.players[0].board.red.splay = 'none';
  s.pendingPrompts = [
    {
      id: 'test_splay_prompt',
      playerId: 'p1',
      kind: 'choose_color',
      title: 'Splay a color left',
      options: ['red', 'green'],
      splayDirection: 'left',
      allowSkip: true,
    },
  ];

  // Craft two small deterministic TD models: one valuing leaf icons (idx 12), one valuing tower icons (idx 10)
  const leafModel = createRandomFunnelModel('1v1', 'tanh', 1);
  leafModel.w1.fill(0);
  leafModel.b1.fill(0);
  leafModel.w2.fill(0);
  leafModel.b2.fill(0);
  leafModel.w3.fill(0);
  leafModel.b3.fill(0);
  leafModel.w1[0 * TD_INPUT_SIZE + 12] = 2.0; // leaf icon count feature
  leafModel.w2[0] = 2.0;
  leafModel.w3[0] = 3.0; // class 0 win logit

  const pv = projectPlayerView(s, 'p1');
  const leafPick = chooseTDActionWithModel(pv, leafModel, undefined, {
    drawSamples: 2,
    dogmaSamples: 1,
    enableOpponentReply: false,
  });
  assert.equal(leafPick.type, 'answer_prompt');
  assert.equal(
    leafPick.type === 'answer_prompt' ? leafPick.selectedColor : undefined,
    'green',
    'Model valuing leaf icons must simulate splaying green left and pick green over red/skip'
  );

  // Flip sign so model prefers fewer visible leaf & tower icons -> should decline (skip) instead of blind options[0]
  const antiSplayModel = createRandomFunnelModel('1v1', 'tanh', 1);
  antiSplayModel.w1.fill(0);
  antiSplayModel.b1.fill(0);
  antiSplayModel.w2.fill(0);
  antiSplayModel.b2.fill(0);
  antiSplayModel.w3.fill(0);
  antiSplayModel.b3.fill(0);
  antiSplayModel.w1[0 * TD_INPUT_SIZE + 10] = -2.0; // penalize tower (exposed by red)
  antiSplayModel.w1[0 * TD_INPUT_SIZE + 12] = -2.0; // penalize leaf (exposed by green)
  antiSplayModel.w2[0] = 2.0;
  antiSplayModel.w3[0] = 3.0;
  const skipPick = chooseTDActionWithModel(pv, antiSplayModel, undefined, {
    drawSamples: 2,
    dogmaSamples: 1,
    enableOpponentReply: false,
  });
  assert.equal(skipPick.type, 'answer_prompt');
  assert.equal(
    skipPick.type === 'answer_prompt' ? skipPick.selectedColor : 'unexpected',
    undefined,
    'Anti-splay model should skip optional splay prompt after simulating'
  );
});

test('Offline trainer executes mini warmstart with Heuristic distillation + mini-batch Adam + TD(lambda) self-play cleanly', () => {
  const { model, arena } = trainVariantModel({
    variant: '1v1',
    activation: 'tanh',
    warmstartGames: 2,
    tdGames: 2,
    lambda: 0.7,
    warmstartAlpha: 0.002,
    alpha: 0.001,
    batchSize: TD_DEFAULT_BATCH_SIZE,
    distillWeight: TD_DEFAULT_DISTILL_WEIGHT,
    evalGames: 2,
    seed: 555,
  });
  assert.equal(model.warmstartGames, 2);
  assert.equal(model.trainedGames, 2);
  assert.ok(arena && arena.games === 2);
  assert.ok(Number.isFinite(arena!.tdWinRate));

  // Verify computeHeuristicDistillTarget produces valid normalized probabilities
  const st = createGame({
    variant: '1v1',
    playerNames: ['P1', 'P2'],
    playerIsAI: [true, true],
    seed: 101,
    fastSimulation: true,
  });
  const dTarget = computeHeuristicDistillTarget(st, 0);
  assert.equal(dTarget.length, 2);
  assert.ok(Math.abs(dTarget[0] + dTarget[1] - 1) < 1e-5);
});

test('Weight registry importTDWeightBundleJson and resetTDWeights handle JSON validation cleanly', () => {
  // Outside browser localStorage is unavailable, verify validation behavior cleanly
  const badRes = importTDWeightBundleJson('{ not json');
  assert.equal(badRes.ok, false);
  const m = createRandomFunnelModel('1v1', 'tanh', 12);
  const goodJson = JSON.stringify(buildModelBundleFromMap({ '1v1': m }));
  const goodRes = importTDWeightBundleJson(goodJson);
  assert.equal(goodRes.ok, true);
  assert.deepEqual(goodRes.updatedVariants, ['1v1']);
  resetTDWeights();
});

test('AI difficulty profiles normalize legacy td, toggle lookahead/softmax, and detect placeholder weights', () => {
  assert.equal(normalizeAIBackend(undefined), 'heuristic');
  assert.equal(normalizeAIBackend('td'), 'td_full');
  assert.equal(normalizeAIBackend('td_easy'), 'td_easy');

  const easy = getAIDifficultyProfile('td_easy');
  const med = getAIDifficultyProfile('td_medium');
  const hard = getAIDifficultyProfile('td_hard');
  const full = getAIDifficultyProfile('td_full');

  assert.equal(easy.canLookAhead, false);
  assert.equal(easy.plannerOptions?.enableLookahead, false);
  assert.equal(easy.plannerOptions?.enableOpponentReply, false);
  assert.ok((easy.plannerOptions?.temperature ?? 0) > (med.plannerOptions?.temperature ?? 0));

  assert.equal(med.canLookAhead, false);
  assert.equal(med.plannerOptions?.enableLookahead, false);

  assert.equal(hard.canLookAhead, true);
  assert.equal(hard.plannerOptions?.enableLookahead, true);
  assert.equal(hard.plannerOptions?.enableOpponentReply, true);
  assert.ok((hard.plannerOptions?.temperature ?? 0) > 0);

  assert.equal(full.canLookAhead, true);
  assert.equal(full.plannerOptions?.temperature, 0);
  assert.equal(full.plannerOptions?.epsilon, 0);

  // Bundled trained tdWeights.*.json files provide active weights for all 3 variants
  assert.equal(hasTrainedTDWeights('1v1'), true);
  assert.equal(hasTrainedTDWeights('1v1v1'), true);
  assert.equal(hasTrainedTDWeights('2v2'), true);
});

test('sortHandCards orders newest-first by default and sorts by age desc, color, then name', () => {
  const wheel = instantiateCard(findDef('B009'), 'c1');     // Age 1, green
  const writing = instantiateCard(findDef('B014'), 'c2');   // Age 1, blue
  const archery = instantiateCard(findDef('B001'), 'c3');   // Age 1, red
  const optics = instantiateCard(findDef('B031'), 'c4');    // Age 3, red (check actual color/age)
  const newestOrder = sortHandCards([wheel, writing, archery, optics], 'newest');
  assert.deepEqual(
    newestOrder.map((c) => c.instanceId),
    ['B031_c4', 'B001_c3', 'B014_c2', 'B009_c1']
  );

  const age1 = [
    instantiateCard(findDef('B014'), 'a_purple'), // Age 1 purple
    instantiateCard(findDef('B012'), 'a_blue'),   // Age 1 blue (Tools)
    instantiateCard(findDef('B001'), 'a_red2'),   // Age 1 red (Archery)
    instantiateCard(findDef('B002'), 'a_red1'),   // Age 1 red (Metalworking)
    instantiateCard(findDef('B017'), 'a_age2'),   // Age 2
  ];
  const sorted = sortHandCards(age1, 'sorted');
  assert.equal(sorted[0].age, 2, 'Highest age comes first');
  assert.equal(sorted[1].color, 'red', 'Red comes first among Age 1');
  assert.equal(sorted[2].color, 'red');
  assert.ok(sorted[1].name.localeCompare(sorted[2].name) <= 0, 'Same age & color sorted alphabetically');
  assert.equal(sorted[3].color, age1[1].color, 'Blue comes before purple');
  assert.equal(sorted[4].color, age1[0].color, 'Purple comes last');
});

test('runHeadlessBenchmarkMatch completes 1v1 and 2v2 matches cleanly with mixed AI difficulties', () => {
  const res1v1 = runHeadlessBenchmarkMatch({
    matchIndex: 1,
    variant: '1v1',
    playerNames: ['Easy Bot', 'Heuristic Bot'],
    playerAIBackends: ['td_easy', 'heuristic'],
    seed: 10101,
    maxTurns: 300,
  });
  assert.equal(res1v1.variant, '1v1');
  assert.equal(res1v1.players.length, 2);
  assert.ok(res1v1.turns >= 1);
  assert.ok(res1v1.summary.length > 0);

  const res2v2 = runHeadlessBenchmarkMatch({
    matchIndex: 2,
    variant: '2v2',
    playerNames: ['Full A1', 'Heu B1', 'Med A2', 'Easy B2'],
    playerAIBackends: ['td_full', 'heuristic', 'td_medium', 'td_easy'],
    seed: 20202,
    maxTurns: 300,
  });
  assert.equal(res2v2.variant, '2v2');
  assert.equal(res2v2.players.length, 4);
  assert.ok(res2v2.turns >= 1);
});

test('computeIsHorizontalView switches Horizontal/Desktop vs Vertical/Mobile by aspect ratio, minimum width, and override', () => {
  // Auto mode defaults to Vertical unless landscape (aspect >= 1.25) AND wide enough (>= 900px)
  assert.equal(computeIsHorizontalView('auto', 1440, 900), true);   // Desktop (wide + landscape)
  assert.equal(computeIsHorizontalView('auto', 1024, 768), true);   // Tablet landscape (1024px, 1.33 ratio)
  assert.equal(computeIsHorizontalView('auto', 1000, 900), false);  // Wide enough, but aspect 1.11 < 1.25 -> Vertical
  assert.equal(computeIsHorizontalView('auto', 844, 390), false);   // Mobile phone landscape (narrow < 900px -> Vertical)
  assert.equal(computeIsHorizontalView('auto', 667, 375), false);   // Small phone landscape (< 900px -> Vertical)
  assert.equal(computeIsHorizontalView('auto', 390, 844), false);   // Mobile phone portrait
  assert.equal(computeIsHorizontalView('auto', 768, 1024), false);  // Tablet portrait
  assert.equal(computeIsHorizontalView('auto', 1024, 1366), false); // Large tablet portrait

  // Explicit overrides ignore viewport dimensions
  assert.equal(computeIsHorizontalView('landscape', 390, 844), true);
  assert.equal(computeIsHorizontalView('portrait', 1440, 900), false);
});

test('computeArenaStats and formatBenchmarkLogText track Ach, Special, and Score wins cleanly', () => {
  const mkPlayer = (id: string, name: string, isWinner: boolean, ach: number, score: number) => ({
    id,
    name,
    teamId: id === 'p1' ? 'A' : 'B',
    aiBackend: 'heuristic' as const,
    score,
    achievements: ach,
    highestTopAge: 9,
    isWinner,
  });

  const sampleResults: BenchmarkMatchResult[] = [
    {
      matchIndex: 1,
      seed: 1,
      variant: '1v1',
      winnerPlayerIds: ['p1'],
      winnerTeamId: 'A',
      reason: 'achievements',
      summary: 'AI Alpha wins with 6 achievements!',
      turns: 24,
      players: [mkPlayer('p1', 'AI Alpha', true, 6, 40), mkPlayer('p2', 'AI Beta', false, 3, 25)],
    },
    {
      matchIndex: 2,
      seed: 2,
      variant: '1v1',
      winnerPlayerIds: ['p2'],
      winnerTeamId: 'B',
      reason: 'card_effect',
      summary: 'AI Beta wins via Bioengineering!',
      turns: 30,
      players: [mkPlayer('p1', 'AI Alpha', false, 4, 30), mkPlayer('p2', 'AI Beta', true, 4, 32)],
    },
    {
      matchIndex: 3,
      seed: 3,
      variant: '1v1',
      winnerPlayerIds: ['p1'],
      winnerTeamId: 'A',
      reason: 'score_age12',
      summary: 'AI Alpha wins on score (Age 12+ draw)!',
      turns: 36,
      players: [mkPlayer('p1', 'AI Alpha', true, 5, 55), mkPlayer('p2', 'AI Beta', false, 5, 42)],
    },
    {
      matchIndex: 4,
      seed: 4,
      variant: '1v1',
      winnerPlayerIds: [],
      winnerTeamId: null,
      reason: 'turn_cap',
      summary: 'Draw (Turn limit reached)',
      turns: 450,
      players: [mkPlayer('p1', 'AI Alpha', false, 4, 20), mkPlayer('p2', 'AI Beta', false, 4, 20)],
    },
  ];

  const stats = computeArenaStats(sampleResults, 2, '1v1');
  assert.deepEqual(stats.winsBySeat, [2, 1]);
  assert.equal(stats.draws, 1);
  assert.equal(stats.achWins, 1);
  assert.equal(stats.specialWins, 1);
  assert.equal(stats.scoreWins, 1);
  assert.equal(stats.eliminationWins, 0);
  assert.equal(stats.avgTurns, 135);

  const logText = formatBenchmarkLogText({
    variant: '1v1',
    statusLabel: 'Complete (4/4)',
    seatLabels: ['AI Alpha (Heur)', 'AI Beta (Heur)'],
    results: sampleResults,
    stats,
  });
  assert.match(logText, /AI Arena Log \(1v1\)/);
  assert.match(logText, /Ach wins: 1 \| Special wins: 1 \| Score wins: 1/);
  assert.match(logText, /AI Beta wins via Bioengineering!/);
  assert.match(logText, /Card Effect \(Bioengineering\)/);
});

test('extractVictoryCardName and formatVictoryDetailLabel parse card-effect victories accurately', () => {
  assert.equal(extractVictoryCardName('card_effect', 'Player 1 wins via Bioengineering!'), 'Bioengineering');
  assert.equal(extractVictoryCardName('card_effect', 'Team A wins via Self Service (Red)!'), 'Self Service');
  assert.equal(extractVictoryCardName('card_effect', 'Bot wins via A.I.!'), 'A.I.');
  assert.equal(extractVictoryCardName('achievements', 'Player 1 wins with 6 achievements!'), null);

  assert.equal(
    formatVictoryDetailLabel('card_effect', 'Player 1 wins via Globalization!'),
    'Card Effect (Globalization)'
  );
  assert.equal(formatVictoryDetailLabel('achievements', 'Player 1 wins'), 'Achievements');
});

test('DEFAULT_SETTINGS defaults mobileViewMode to compact and mobileNavBar to false', () => {
  assert.equal(DEFAULT_SETTINGS.mobileViewMode, 'compact');
  assert.equal(DEFAULT_SETTINGS.mobileNavBar, false);
});

test('groupCountByAge and formatAgeCountsCompact order highest age on the left to lowest on the right', () => {
  const sample = [
    { age: 1 as const },
    { age: 5 as const },
    { age: 3 as const },
    { age: 1 as const },
    { age: 5 as const },
  ];
  assert.deepEqual(groupCountByAge(sample), [
    { age: 5, count: 2 },
    { age: 3, count: 1 },
    { age: 1, count: 2 },
  ]);
  assert.equal(formatAgeCountsCompact(sample), '[5]×2 · [3]×1 · [1]×2');
});

test('generateRandomSeed and unseeded createGame generate distinct non-zero seeds and hands even when called within the same millisecond', () => {
  const seeds = new Set<number>();
  for (let i = 0; i < 25; i++) {
    const s = generateRandomSeed();
    assert.ok(s >= 1 && Number.isInteger(s), 'Seed must be a positive 32-bit integer');
    seeds.add(s);
  }
  assert.equal(seeds.size, 25, 'Rapid consecutive generateRandomSeed() calls must not collide');

  const g1 = createGame({ variant: '1v1', playerNames: ['P1', 'P2'], playerIsAI: [false, true] });
  const g2 = createGame({ variant: '1v1', playerNames: ['P1', 'P2'], playerIsAI: [false, true] });
  assert.notEqual(g1.seed, g2.seed, 'Back-to-back unseeded createGame calls must receive distinct seeds');
  const h1 = g1.players[0].hand.map((c) => c.defId).join(',');
  const h2 = g2.players[0].hand.map((c) => c.defId).join(',');
  const hOpp1 = g1.players[1].hand.map((c) => c.defId).join(',');
  const hOpp2 = g2.players[1].hand.map((c) => c.defId).join(',');
  assert.ok(h1 !== h2 || hOpp1 !== hOpp2, 'Distinct seeds must produce different starting deals');
});

test('DEFAULT_SETTINGS defaults layoutMode to auto and runHeadlessBenchmarkMatch supports modelOverridesBySeat', () => {
  assert.equal(DEFAULT_SETTINGS.layoutMode, 'auto');
  const modelA = createRandomFunnelModel('1v1', 'tanh', 101);
  const modelB = createRandomFunnelModel('1v1', 'tanh', 202);
  const res = runHeadlessBenchmarkMatch({
    matchIndex: 1,
    variant: '1v1',
    playerNames: ['Model A', 'Model B'],
    playerAIBackends: ['td_medium', 'td_medium'],
    modelOverridesBySeat: [modelA, modelB],
    seed: 555,
    maxTurns: 40,
  });
  assert.equal(res.variant, '1v1');
  assert.equal(res.players.length, 2);
});
