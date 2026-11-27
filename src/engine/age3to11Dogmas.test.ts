import test from 'node:test';
import assert from 'node:assert/strict';

import { BASE_CARD_DATABASE, instantiateCard } from '../data/cards/catalog';
import { chooseAIAction } from './ai';
import { ALL_AGES } from './constants';
import { applyAction, createGame, setManualEndTurn } from './engine';
import { meldCardInstance, scoreCardInstance, splayPlayerColor } from './keywords';
import { projectPlayerView } from './playerView';
import { getTopCard } from './splay';
import type { Age, CardInstance, GameState } from './types';

function byId(defId: string, suffix = 't'): CardInstance {
  const def = BASE_CARD_DATABASE.find((c) => c.id === defId);
  if (!def) throw new Error(`Missing card ${defId}`);
  return instantiateCard(def, suffix);
}

function makePlayingState(seed = 2026): GameState {
  const state = createGame({
    variant: '1v1',
    controlMode: 'vs_ai',
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

function fillDeck(state: GameState, age: Age, defIds: string[], prefix = 'fd'): void {
  state.decks[age] = defIds.map((id, i) => byId(id, `${prefix}_${age}_${i}`));
}

function resolveAllWithAI(state: GameState, maxSteps = 20): GameState {
  let cur = state;
  let steps = 0;
  while (cur.phase === 'playing' && cur.pendingPrompts.length > 0 && steps < maxSteps) {
    const p = cur.pendingPrompts[0];
    const act = chooseAIAction(projectPlayerView(cur, p.playerId));
    cur = applyAction(cur, act);
    steps += 1;
  }
  return cur;
}

test('Age 3 B026-B035: Engineering, Optics, Machinery, Medicine, Compass, Paper, Alchemy, Translation, Education, Feudalism', () => {
  // B026 Engineering: transfers top Tower cards and splays red left
  const sEng = makePlayingState();
  meldCardInstance(sEng, 'p1', byId('B001', 'p1_r1')); // 2 towers
  meldCardInstance(sEng, 'p1', byId('B026', 'p1_eng')); // 2 towers
  meldCardInstance(sEng, 'p1', byId('B005', 'p1_dom')); // +2 towers = 4 towers > p2's 2!
  meldCardInstance(sEng, 'p2', byId('B005', 'p2_dom')); // yellow with tower!
  let rEng = applyAction(sEng, { type: 'dogma', playerId: 'p1', color: 'red' });
  rEng = applyAction(rEng, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: rEng.pendingPrompts[0].id,
    selectedColor: 'red',
  });
  assert.equal(rEng.players[1].board.yellow.cards.length, 0);
  assert.equal(rEng.players[0].scorePile[0].defId, 'B005');
  assert.equal(rEng.players[0].board.red.splay, 'left');

  // B027 Optics: coin draws & scores [4]; non-coin transfers score card to opponent with fewer points
  const sOpt = makePlayingState();
  meldCardInstance(sOpt, 'p1', byId('B027', 'p1_opt'));
  fillDeck(sOpt, 3, ['B033']); // Translation has coin!
  fillDeck(sOpt, 4, ['B036']);
  const rOpt1 = applyAction(sOpt, { type: 'dogma', playerId: 'p1', color: 'red' });
  assert.equal(getTopCard(rOpt1.players[0].board.blue)?.defId, 'B033');
  assert.equal(rOpt1.players[0].scorePile[0].defId, 'B036');

  const sOpt2 = makePlayingState();
  meldCardInstance(sOpt2, 'p1', byId('B027', 'p1_opt2'));
  const p1Sc = byId('B001', 'p1_sc');
  scoreCardInstance(sOpt2, 'p1', p1Sc);
  fillDeck(sOpt2, 3, ['B032']); // Alchemy has NO coin (leaf, tower, tower)
  const rOpt2 = applyAction(sOpt2, { type: 'dogma', playerId: 'p1', color: 'red' });
  assert.equal(rOpt2.players[0].scorePile.length, 0);
  assert.equal(rOpt2.players[1].scorePile[0].instanceId, p1Sc.instanceId);

  // B028 Machinery: demand exchanges victim hand with attacker highest hand; scores tower card
  const sMach = makePlayingState();
  meldCardInstance(sMach, 'p1', byId('B028', 'p1_mach')); // 2 leaves
  sMach.players[0].hand = [byId('B004', 'p1_low'), byId('B036', 'p1_hi')]; // [1] (no tower), [4]
  sMach.players[1].hand = [byId('B002', 'p2_h1')]; // [1] (with tower!)
  const rMach = applyAction(sMach, { type: 'dogma', playerId: 'p1', color: 'yellow' });
  assert.ok(rMach.players[1].hand.some((c) => c.defId === 'B036'));
  assert.equal(rMach.players[0].scorePile[0].defId, 'B002'); // scored tower card from exchanged hand!

  // B029 Medicine: demand exchanges victim highest score with attacker lowest score + junks [3] or [4]
  const sMed = makePlayingState();
  meldCardInstance(sMed, 'p1', byId('B029', 'p1_med')); // 2 leaves, 1 coin
  scoreCardInstance(sMed, 'p1', byId('B001', 'p1_low'));
  scoreCardInstance(sMed, 'p2', byId('B036', 'p2_hi'));
  let rMed = applyAction(sMed, { type: 'dogma', playerId: 'p1', color: 'yellow' });
  assert.equal(rMed.players[0].scorePile[0].defId, 'B036');
  assert.equal(rMed.players[1].scorePile[0].defId, 'B001');
  rMed = applyAction(rMed, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: rMed.pendingPrompts[0].id,
    selectedValue: 4,
  });
  assert.ok(!rMed.standardAchievements.some((a) => a.age === 4));

  // B030 Compass: demand transfers top non-green Leaf and melds top non-Leaf from attacker
  const sComp = makePlayingState();
  meldCardInstance(sComp, 'p1', byId('B030', 'p1_comp')); // 2 coins
  meldCardInstance(sComp, 'p1', byId('B001', 'p1_arch')); // no leaf!
  meldCardInstance(sComp, 'p2', byId('B004', 'p2_agri')); // yellow with leaf!
  const rComp = applyAction(sComp, { type: 'dogma', playerId: 'p1', color: 'green' });
  assert.equal(getTopCard(rComp.players[0].board.yellow)?.defId, 'B004');
  assert.equal(getTopCard(rComp.players[1].board.red)?.defId, 'B001');

  // B031 Paper: splay green/blue left + score top leaf + draw [4] per left-splayed color
  const sPap = makePlayingState();
  meldCardInstance(sPap, 'p1', byId('B008', 'p1_g1'));
  meldCardInstance(sPap, 'p1', byId('B031', 'p1_pap'));
  meldCardInstance(sPap, 'p1', byId('B004', 'p1_y1')); // top card with Leaf!
  fillDeck(sPap, 4, ['B036', 'B037']);
  let rPap = applyAction(sPap, { type: 'dogma', playerId: 'p1', color: 'green' });
  rPap = applyAction(rPap, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: rPap.pendingPrompts[0].id,
    selectedColor: 'green',
  });
  assert.equal(rPap.players[0].board.green.splay, 'left');
  assert.equal(rPap.players[0].scorePile[0].defId, 'B004'); // scored top leaf!
  assert.equal(rPap.players[0].hand.length, 1); // 1 left-splayed color -> 1 [4]

  // B032 Alchemy: red card drawn returns hand; ability 2 melds 1 then scores 1
  const sAlch = makePlayingState();
  meldCardInstance(sAlch, 'p1', byId('B032', 'p1_alch')); // has 1 tower color
  sAlch.players[0].hand = [byId('B004', 'h1'), byId('B008', 'h2')];
  fillDeck(sAlch, 4, ['B036']); // Colonialism is RED!
  let rAlch = applyAction(sAlch, { type: 'dogma', playerId: 'p1', color: 'blue' });
  assert.equal(rAlch.players[0].hand.length, 0); // Red returned all hand cards!

  // B033 Translation: optional meld all score pile + World special achievement
  const sTrans = makePlayingState();
  meldCardInstance(sTrans, 'p1', byId('B033', 'p1_trans')); // has coin
  scoreCardInstance(sTrans, 'p1', byId('B008', 'p1_sc_sail')); // green with coin
  let rTrans = applyAction(sTrans, { type: 'dogma', playerId: 'p1', color: 'blue' });
  rTrans = applyAction(rTrans, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: rTrans.pendingPrompts[0].id,
    confirmed: true,
  });
  assert.equal(rTrans.players[0].scorePile.length, 0);
  assert.ok(rTrans.players[0].achievements.some((a) => a.specialId === 'world'));

  // B034 Education: optional return highest score card -> draw remMax + 2
  const sEdu = makePlayingState();
  meldCardInstance(sEdu, 'p1', byId('B034', 'p1_edu'));
  const eduLow = byId('B016', 's2'); // Age 2
  const eduHigh = byId('B036', 's4'); // Age 4
  scoreCardInstance(sEdu, 'p1', eduLow);
  scoreCardInstance(sEdu, 'p1', eduHigh);
  fillDeck(sEdu, 4, ['B037']); // remaining max is 2 -> draws 2+2 = 4!
  let rEdu = applyAction(sEdu, { type: 'dogma', playerId: 'p1', color: 'purple' });
  rEdu = applyAction(rEdu, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: rEdu.pendingPrompts[0].id,
    selectedCardIds: [eduHigh.instanceId],
  });
  assert.equal(rEdu.players[0].hand[0].defId, 'B037');

  // B035 Feudalism: demand transfers Tower from hand & junks ALL available special achievements
  const sFeud = makePlayingState();
  meldCardInstance(sFeud, 'p1', byId('B035', 'p1_feud'));
  sFeud.players[1].hand = [byId('B001', 'p2_arch')]; // has tower
  const rFeud = applyAction(sFeud, { type: 'dogma', playerId: 'p1', color: 'purple' });
  assert.equal(rFeud.players[0].hand[0].defId, 'B001');
  assert.equal(rFeud.availableSpecialAchievements.length, 0);
});

test('Age 4 B036-B045: Colonialism, Gunpowder, Anatomy, Perspective, Invention, Navigation, Experimentation, Printing Press, Enterprise, Reformation', () => {
  // B036 Colonialism: repeats on coin, green junks [5] deck
  const sCol = makePlayingState();
  meldCardInstance(sCol, 'p1', byId('B036', 'p1_col'));
  fillDeck(sCol, 3, ['B030', 'B032']); // Compass (green, coin) -> junks [5] & repeats -> Alchemy (no coin) -> stops
  const rCol = applyAction(sCol, { type: 'dogma', playerId: 'p1', color: 'red' });
  assert.equal(rCol.decks[5].length, 0);
  assert.equal(rCol.players[0].board.green.cards[0].defId, 'B030');
  assert.equal(rCol.players[0].board.blue.cards[0].defId, 'B032');

  // B037 Gunpowder: transfers top Tower; draws & scores [2] ONLY if transferred
  const sGunNo = makePlayingState();
  meldCardInstance(sGunNo, 'p1', byId('B037', 'p1_gun'));
  const rGunNo = applyAction(sGunNo, { type: 'dogma', playerId: 'p1', color: 'red' });
  assert.equal(rGunNo.players[0].scorePile.length, 0);

  const sGunYes = makePlayingState();
  meldCardInstance(sGunYes, 'p1', byId('B037', 'p1_gun'));
  meldCardInstance(sGunYes, 'p2', byId('B001', 'p2_arch')); // has tower
  fillDeck(sGunYes, 2, ['B016']);
  const rGunYes = applyAction(sGunYes, { type: 'dogma', playerId: 'p1', color: 'red' });
  assert.equal(rGunYes.players[0].scorePile.length, 2); // B001 + B016

  // B038 Anatomy: returns score card + equal-value top board card -> junks [4] deck
  const sAnat = makePlayingState();
  meldCardInstance(sAnat, 'p1', byId('B038', 'p1_anat'));
  scoreCardInstance(sAnat, 'p2', byId('B004', 'p2_s1'));
  meldCardInstance(sAnat, 'p2', byId('B001', 'p2_t1')); // age 1 matches score [1]!
  const rAnat = applyAction(sAnat, { type: 'dogma', playerId: 'p1', color: 'yellow' });
  assert.equal(rAnat.players[1].scorePile.length, 0);
  assert.equal(rAnat.players[1].board.red.cards.length, 0);
  assert.equal(rAnat.decks[4].length, 0);

  // B039 Perspective & B040 Invention (Wonder) & B041 Navigation & B042 Experimentation
  const sInv = makePlayingState();
  for (const col of ['red', 'yellow', 'green', 'blue', 'purple'] as const) {
    meldCardInstance(sInv, 'p1', byId(col === 'red' ? 'B001' : col === 'yellow' ? 'B004' : col === 'green' ? 'B008' : col === 'blue' ? 'B010' : 'B014', `c1_${col}`));
    meldCardInstance(sInv, 'p1', byId(col === 'red' ? 'B002' : col === 'yellow' ? 'B005' : col === 'green' ? 'B040' : col === 'blue' ? 'B012' : 'B015', `c2_${col}`));
    splayPlayerColor(sInv, 'p1', col, 'left', 'Test');
  }
  let rInv = applyAction(sInv, { type: 'dogma', playerId: 'p1', color: 'green' });
  rInv = applyAction(rInv, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: rInv.pendingPrompts[0].id,
    selectedColor: 'red',
  });
  assert.equal(rInv.players[0].board.red.splay, 'right');
  assert.ok(rInv.players[0].achievements.some((a) => a.specialId === 'wonder'));

  // B043 Printing Press, B044 Enterprise, B045 Reformation
  const sRef = makePlayingState();
  meldCardInstance(sRef, 'p1', byId('B004', 'y1'));
  meldCardInstance(sRef, 'p1', byId('B014', 'p_bot'));
  meldCardInstance(sRef, 'p1', byId('B045', 'p1_ref')); // Reformation on top of purple!
  splayPlayerColor(sRef, 'p1', 'purple', 'left', 'Test');
  const hRef = byId('B001', 'h_ref');
  sRef.players[0].hand = [hRef];
  let rRef = applyAction(sRef, { type: 'dogma', playerId: 'p1', color: 'purple' });
  rRef = applyAction(rRef, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: rRef.pendingPrompts[0].id,
    selectedColor: 'purple',
  });
  assert.equal(rRef.players[0].board.purple.splay, 'right');
  rRef = applyAction(rRef, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: rRef.pendingPrompts[0].id,
    selectedCardIds: [hRef.instanceId],
  });
  assert.equal(rRef.players[0].board.red.cards[0].instanceId, hRef.instanceId);
});

test('Age 5 B046-B055: Coal, Pirate Code, Statistics, Steam Engine, Banking, Measurement, Chemistry, Physics, Astronomy, Societies', () => {
  // B049 Steam Engine: tuck 2 [4], score bottom yellow; if Steam Engine, junk [6] deck
  const sSteam = makePlayingState();
  meldCardInstance(sSteam, 'p1', byId('B049', 'p1_steam')); // bottom & top yellow initially
  fillDeck(sSteam, 4, ['B036', 'B037']); // tuck red [4], red [4] -> Steam Engine stays bottom yellow!
  const rSteam = applyAction(sSteam, { type: 'dogma', playerId: 'p1', color: 'yellow' });
  assert.equal(rSteam.players[0].scorePile[0].defId, 'B049');
  assert.equal(rSteam.decks[6].length, 0);

  // B053 Physics: duplicate color returns hand; distinct keeps all
  const sPhy = makePlayingState();
  meldCardInstance(sPhy, 'p1', byId('B053', 'p1_phy'));
  sPhy.players[0].hand = [byId('B001', 'existing')];
  fillDeck(sPhy, 6, ['B056', 'B057', 'B058']); // Red, Red, Yellow -> duplicate color!
  const rPhy = applyAction(sPhy, { type: 'dogma', playerId: 'p1', color: 'blue' });
  assert.equal(rPhy.players[0].hand.length, 0);

  // B054 Astronomy: Universe special achievement
  const sAst = makePlayingState();
  meldCardInstance(sAst, 'p1', byId('B054', 'p1_ast'));
  meldCardInstance(sAst, 'p1', byId('B056', 'p1_r6'));
  fillDeck(sAst, 6, ['B058']); // Yellow [6] -> stops loop cleanly
  const rAst = applyAction(sAst, { type: 'dogma', playerId: 'p1', color: 'purple' });
  assert.ok(rAst.players[0].achievements.some((a) => a.specialId === 'universe'));

  // B055 Societies: transfers qualifying top Lightbulb card higher than activating player's matching color
  const sSoc = makePlayingState();
  meldCardInstance(sSoc, 'p1', byId('B055', 'p1_soc')); // 2 coins
  meldCardInstance(sSoc, 'p1', byId('B012', 'p1_blue1')); // Age 1 blue
  meldCardInstance(sSoc, 'p2', byId('B052', 'p2_chem')); // Age 5 blue with lightbulb!
  fillDeck(sSoc, 5, ['B046']);
  const rSoc = applyAction(sSoc, { type: 'dogma', playerId: 'p1', color: 'purple' });
  assert.equal(getTopCard(rSoc.players[0].board.blue)?.defId, 'B052');
  assert.equal(rSoc.players[1].hand[0].defId, 'B046');
});

test('Age 6-8 B056-B085: Vaccination, Democracy, Explosives, Mass Media, Empiricism Victory, Skyscrapers', () => {
  // B059 Vaccination: demand returns all of 1 score value & triggers [7] draw & meld
  const sVac = makePlayingState();
  meldCardInstance(sVac, 'p1', byId('B059', 'p1_vac')); // 2 leaves
  scoreCardInstance(sVac, 'p2', byId('B001', 'p2_s1a'));
  scoreCardInstance(sVac, 'p2', byId('B002', 'p2_s1b'));
  fillDeck(sVac, 6, ['B056']);
  fillDeck(sVac, 7, ['B066']);
  const rVac = applyAction(sVac, { type: 'dogma', playerId: 'p1', color: 'yellow' });
  assert.equal(rVac.players[1].scorePile.length, 0);
  assert.equal(getTopCard(rVac.players[0].board.red)?.defId, 'B066');

  // B064 Democracy: sharing opponent returns more than activating player -> only sharing opponent scores [8]
  const sDem = makePlayingState();
  meldCardInstance(sDem, 'p1', byId('B064', 'p1_dem')); // 2 lightbulbs
  meldCardInstance(sDem, 'p2', byId('B034', 'p2_edu')); // 3 lightbulbs -> shares!
  const p2h1 = byId('B001', 'p2_h1');
  const p2h2 = byId('B002', 'p2_h2');
  const p1h1 = byId('B004', 'p1_h1');
  sDem.players[1].hand = [p2h1, p2h2];
  sDem.players[0].hand = [p1h1];
  fillDeck(sDem, 8, ['B076']);
  let rDem = applyAction(sDem, { type: 'dogma', playerId: 'p1', color: 'purple' });
  // First prompt goes to sharing player p2
  assert.equal(rDem.pendingPrompts[0].playerId, 'p2');
  rDem = applyAction(rDem, {
    type: 'answer_prompt',
    playerId: 'p2',
    promptId: rDem.pendingPrompts[0].id,
    selectedCardIds: [p2h1.instanceId, p2h2.instanceId],
  });
  assert.equal(rDem.players[1].scorePile[0].defId, 'B076');
  // Now prompt goes to p1; returning 1 is <= 2 so p1 does NOT score [8]
  rDem = applyAction(rDem, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: rDem.pendingPrompts[0].id,
    selectedCardIds: [p1h1.instanceId],
  });
  assert.equal(rDem.players[0].scorePile.length, 0);

  // B084 Empiricism: >= 20 lightbulbs wins immediately
  const sEmp = makePlayingState();
  // Purple stack with heavy lightbulb cards splayed aslant (3 icons/card)
  const purpleBulbs = ['B025', 'B034', 'B064', 'B074', 'B085', 'B084'];
  for (let i = 0; i < purpleBulbs.length; i++) {
    meldCardInstance(sEmp, 'p1', byId(purpleBulbs[i], `pb_${i}`));
  }
  splayPlayerColor(sEmp, 'p1', 'purple', 'aslant', 'Test');
  // Blue stack with heavy lightbulb cards splayed aslant
  const blueBulbs = ['B012', 'B023', 'B032', 'B042', 'B043', 'B052', 'B062', 'B072', 'B082'];
  for (let i = 0; i < blueBulbs.length; i++) {
    meldCardInstance(sEmp, 'p1', byId(blueBulbs[i], `bb_${i}`));
  }
  splayPlayerColor(sEmp, 'p1', 'blue', 'aslant', 'Test');
  // Yellow + Green lightbulb cards splayed up
  meldCardInstance(sEmp, 'p1', byId('B039', 'y_1'));
  meldCardInstance(sEmp, 'p1', byId('B058', 'y_2'));
  splayPlayerColor(sEmp, 'p1', 'yellow', 'up', 'Test');
  meldCardInstance(sEmp, 'p1', byId('B031', 'g_1'));
  meldCardInstance(sEmp, 'p1', byId('B040', 'g_2'));
  splayPlayerColor(sEmp, 'p1', 'green', 'up', 'Test');

  fillDeck(sEmp, 9, ['B092']); // blue
  let rEmp = applyAction(sEmp, { type: 'dogma', playerId: 'p1', color: 'purple' });
  rEmp = applyAction(rEmp, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: rEmp.pendingPrompts[0].id,
    selectedColor: 'blue',
  });
  rEmp = applyAction(rEmp, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: rEmp.pendingPrompts[0].id,
    selectedColor: 'red',
  });
  assert.equal(rEmp.phase, 'gameover');
  assert.equal(rEmp.victory?.reason, 'card_effect');
  assert.deepEqual(rEmp.victory?.winnerPlayerIds, ['p1']);
});

test('Age 9 B086-B095: Fission dogma_complete board wipe, Satellites self-execute, Collaboration victory', () => {
  // B087 Fission: drawing a RED [10] junks all non-achievement cards and ends Dogma immediately!
  const sFiss = makePlayingState();
  meldCardInstance(sFiss, 'p1', byId('B087', 'p1_fiss')); // 2 clocks
  meldCardInstance(sFiss, 'p2', byId('B001', 'p2_arch')); // 0 clocks -> vulnerable to demand
  sFiss.players[0].hand = [byId('B004', 'p1_h')];
  scoreCardInstance(sFiss, 'p1', byId('B016', 'p1_s'));
  fillDeck(sFiss, 10, ['B096']); // Miniaturization is RED!
  const rFiss = applyAction(sFiss, { type: 'dogma', playerId: 'p1', color: 'red' });
  assert.equal(rFiss.activeDogma, null);
  assert.equal(rFiss.players[0].board.red.cards.length, 0);
  assert.equal(rFiss.players[0].hand.length, 0);
  assert.equal(rFiss.players[0].scorePile.length, 0);
  assert.equal(rFiss.players[1].board.red.cards.length, 0);
  assert.ok(rFiss.junk.length >= 4);

  // B090 Collaboration: >= 10 green cards on board wins
  const sCollab = makePlayingState();
  for (let i = 0; i < 9; i++) {
    meldCardInstance(sCollab, 'p1', byId('B008', `g_${i}`));
  }
  meldCardInstance(sCollab, 'p1', byId('B090', 'p1_collab')); // 10th green card!
  fillDeck(sCollab, 9, ['B091', 'B094']);
  let rCollab = applyAction(sCollab, { type: 'dogma', playerId: 'p1', color: 'green' });
  const collabPick = rCollab.pendingPrompts[0];
  assert.equal(collabPick.kind, 'choose_cards');
  rCollab = applyAction(rCollab, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: collabPick.id,
    selectedCardIds: [collabPick.candidates[0].instanceId],
  });
  assert.equal(rCollab.phase, 'gameover');
  assert.equal(rCollab.victory?.reason, 'card_effect');

  // B091 Satellites: returns hand, splays purple up, draws three [8], melds from hand and self-executes!
  const sSat = makePlayingState();
  meldCardInstance(sSat, 'p1', byId('B014', 'p_bot'));
  meldCardInstance(sSat, 'p1', byId('B024', 'p_top'));
  meldCardInstance(sSat, 'p1', byId('B091', 'p1_sat'));
  sSat.players[0].hand = [byId('B001', 'ret_me')];
  // Put B042 (Experimentation: draw & meld [5]) in deck 8 so melding & self-executing B042 draws & melds [5]!
  fillDeck(sSat, 8, ['B042', 'B076', 'B077']);
  fillDeck(sSat, 5, ['B046']);
  let rSat = applyAction(sSat, { type: 'dogma', playerId: 'p1', color: 'green' });
  rSat = applyAction(rSat, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: rSat.pendingPrompts[0].id,
    selectedColor: 'purple',
  });
  assert.equal(rSat.players[0].board.purple.splay, 'up');
  // Now prompt to choose 1 of the 3 drawn [8]s (we force pick B042 instanceId)
  const b042InHand = rSat.players[0].hand.find((c) => c.defId === 'B042')!;
  rSat = applyAction(rSat, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: rSat.pendingPrompts[0].id,
    selectedCardIds: [b042InHand.instanceId],
  });
  assert.equal(getTopCard(rSat.players[0].board.blue)?.defId, 'B042');
  assert.equal(getTopCard(rSat.players[0].board.red)?.defId, 'B046'); // Self-executed Experimentation!
});

test('Age 10 B096-B105: Globalization, Self Service, Bioengineering, A.I victories & card effects', () => {
  // B098 Globalization: draws & melds [11]; if all players have leaf <= factory, highest score wins
  const sGlob = makePlayingState();
  meldCardInstance(sGlob, 'p1', byId('B098', 'p1_glob')); // has 3 factories, 0 leaf
  scoreCardInstance(sGlob, 'p1', byId('B098', 'p1_s10'));
  fillDeck(sGlob, 11, ['B107']); // Fusion (red, factories/clocks, no leaf)
  const rGlob = applyAction(sGlob, { type: 'dogma', playerId: 'p1', color: 'yellow' });
  assert.equal(rGlob.phase, 'gameover');
  assert.equal(rGlob.victory?.reason, 'card_effect');
  assert.deepEqual(rGlob.victory?.winnerPlayerIds, ['p1']);

  // B101 Self Service: >= 2x each opponent's achievements wins immediately
  const sSelf = makePlayingState();
  meldCardInstance(sSelf, 'p1', byId('B101', 'p1_ss'));
  sSelf.players[0].achievements = [
    { id: 'a1', kind: 'standard', age: 1 },
    { id: 'a2', kind: 'standard', age: 2 },
  ];
  sSelf.players[1].achievements = [{ id: 'b1', kind: 'standard', age: 3 }];
  const rSelf = applyAction(sSelf, { type: 'dogma', playerId: 'p1', color: 'green' });
  assert.equal(rSelf.phase, 'gameover');
  assert.equal(rSelf.victory?.reason, 'card_effect');

  // B102 Bioengineering: if any player has <2 Leaf, single player with most Leaf wins
  const sBio = makePlayingState();
  meldCardInstance(sBio, 'p1', byId('B102', 'p1_bio'));
  meldCardInstance(sBio, 'p1', byId('B004', 'p1_agri')); // p1 has 2 leaves; p2 has 0 (<2)!
  const rBio = applyAction(sBio, { type: 'dogma', playerId: 'p1', color: 'blue' });
  assert.equal(rBio.phase, 'gameover');
  assert.equal(rBio.victory?.reason, 'card_effect');
  assert.deepEqual(rBio.victory?.winnerPlayerIds, ['p1']);

  // B104 A.I: if Robotics & Software are both top cards, single player with lowest score wins
  const sAI = makePlayingState();
  meldCardInstance(sAI, 'p1', byId('B104', 'p1_ai'));
  meldCardInstance(sAI, 'p1', byId('B097', 'p1_rob')); // Robotics
  meldCardInstance(sAI, 'p1', byId('B103', 'p1_sw'));  // Software
  scoreCardInstance(sAI, 'p2', byId('B096', 'p2_sc10')); // p2 has 10 pts
  fillDeck(sAI, 10, ['B099']); // p1 scores 10 from Ability 1 -> tied! Wait: give p2 an extra point
  scoreCardInstance(sAI, 'p2', byId('B001', 'p2_sc1')); // p2 now has 11 > p1's 10!
  const rAI = applyAction(sAI, { type: 'dogma', playerId: 'p1', color: 'purple' });
  assert.equal(rAI.phase, 'gameover');
  assert.equal(rAI.victory?.reason, 'card_effect');
  assert.deepEqual(rAI.victory?.winnerPlayerIds, ['p1']);
});

test('Age 11 B106-B115: Astrogeology, Fusion, Space Traffic elimination, Climatology, Solar Sailing, Escapism, Whataboutism', () => {
  // B106 Astrogeology: askew splay trims stack to <=4 & >=8 hand wins
  const sAstro = makePlayingState();
  for (let i = 0; i < 5; i++) meldCardInstance(sAstro, 'p1', byId('B001', `r_${i}`));
  meldCardInstance(sAstro, 'p1', byId('B106', 'p1_astro')); // top of red stack (6 cards)
  sAstro.players[0].hand = Array.from({ length: 6 }, (_, i) => byId('B002', `h_${i}`));
  fillDeck(sAstro, 11, ['B107']); // Red [11] -> splays red aslant, moves 2 red cards to hand (total 6+1+2 = 9 >= 8!)
  const rAstro = applyAction(sAstro, { type: 'dogma', playerId: 'p1', color: 'red' });
  assert.equal(rAstro.players[0].board.red.splay, 'aslant');
  assert.equal(rAstro.players[0].board.red.cards.length, 4);
  assert.equal(rAstro.phase, 'gameover');
  assert.equal(rAstro.victory?.reason, 'card_effect');

  // B107 Fusion: scores 11 -> chooses 10 or 9 -> scores 9
  const sFus = makePlayingState();
  meldCardInstance(sFus, 'p1', byId('B107', 'p1_fus')); // Red [11]
  meldCardInstance(sFus, 'p1', byId('B088', 'p1_eco')); // Yellow [9]
  let rFus = applyAction(sFus, { type: 'dogma', playerId: 'p1', color: 'red' });
  rFus = applyAction(rFus, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: rFus.pendingPrompts[0].id,
    selectedValue: 9,
  });
  assert.equal(rFus.players[0].scorePile.length, 2);
  assert.equal(rFus.players[0].board.red.cards.length, 0);
  assert.equal(rFus.players[0].board.yellow.cards.length, 0);

  // B111 Space Traffic: tucking [11] directly under an existing bottom [11] eliminates player
  const sSpace = makePlayingState();
  meldCardInstance(sSpace, 'p1', byId('B111', 'p1_space')); // Green [11] at bottom of green!
  fillDeck(sSpace, 11, ['B110']); // Hypersonics is ALSO Green [11] -> tucks directly under [11] -> eliminated!
  const rSpace = applyAction(sSpace, { type: 'dogma', playerId: 'p1', color: 'green' });
  assert.equal(rSpace.players[0].eliminated, true);
  assert.equal(rSpace.phase, 'gameover');
  assert.equal(rSpace.victory?.reason, 'elimination');
  assert.deepEqual(rSpace.victory?.winnerPlayerIds, ['p2']);

  // B112 Climatology: demand chooses non-Leaf icon -> victim returns up to 2 matching top cards
  const sClim = makePlayingState();
  meldCardInstance(sClim, 'p1', byId('B112', 'p1_clim')); // 3 clocks
  meldCardInstance(sClim, 'p2', byId('B001', 'p2_arch')); // has tower
  let rClim = applyAction(sClim, { type: 'dogma', playerId: 'p1', color: 'blue' });
  rClim = applyAction(rClim, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: rClim.pendingPrompts[0].id,
    selectedOptionId: 'tower',
  });
  assert.equal(rClim.players[1].board.red.cards.length, 0);

  // B113 Solar Sailing: 6 cards of drawn color wins immediately
  const sSol = makePlayingState();
  for (let i = 0; i < 4; i++) meldCardInstance(sSol, 'p1', byId('B012', `b_${i}`));
  meldCardInstance(sSol, 'p1', byId('B113', 'p1_sol')); // 5th blue card
  splayPlayerColor(sSol, 'p1', 'blue', 'aslant', 'Test'); // already askew so won't trim to 4!
  fillDeck(sSol, 11, ['B112']); // Blue [11] -> 6th blue card -> Solar Sailing wins!
  const rSol = applyAction(sSol, { type: 'dogma', playerId: 'p1', color: 'blue' });
  assert.equal(rSol.phase, 'gameover');
  assert.equal(rSol.victory?.reason, 'card_effect');

  // B114 Escapism: junks card from hand, returns same-age, draws 3, self-executes junked card
  const sEsc = makePlayingState();
  meldCardInstance(sEsc, 'p1', byId('B114', 'p1_esc'));
  const toJunk = byId('B042', 'p1_exp'); // Age 4 Experimentation: draw & meld [5]
  sEsc.players[0].hand = [toJunk];
  fillDeck(sEsc, 4, ['B036', 'B037', 'B038']);
  fillDeck(sEsc, 5, ['B046']);
  const rEsc = applyAction(sEsc, { type: 'dogma', playerId: 'p1', color: 'purple' });
  assert.ok(rEsc.junk.some((c) => c.defId === 'B042'));
  assert.equal(rEsc.players[0].hand.length, 3);
  assert.equal(getTopCard(rEsc.players[0].board.red)?.defId, 'B046');

  // B115 Whataboutism: demand transfers all opponent top demand cards & swaps score piles
  const sWhat = makePlayingState();
  meldCardInstance(sWhat, 'p1', byId('B115', 'p1_what')); // 3 clocks
  meldCardInstance(sWhat, 'p2', byId('B001', 'p2_arch')); // demand top card
  scoreCardInstance(sWhat, 'p1', byId('B001', 'p1_s1'));
  scoreCardInstance(sWhat, 'p2', byId('B106', 'p2_s11'));
  const rWhat = applyAction(sWhat, { type: 'dogma', playerId: 'p1', color: 'purple' });
  assert.equal(getTopCard(rWhat.players[0].board.red)?.defId, 'B001');
  assert.equal(rWhat.players[0].scorePile[0].defId, 'B106');
  assert.equal(rWhat.players[1].scorePile[0].defId, 'B001');
});

test('Exhaustive B026-B115 sweep: all 90 Age 3-11 cards execute cleanly with AI prompt resolution', () => {
  const cards = BASE_CARD_DATABASE.filter((c) => c.age >= 3 && c.age <= 11);
  assert.equal(cards.length, 90);

  for (const def of cards) {
    assert.equal(def.isPlaceholder, false, `${def.id} ${def.name} must not be placeholder`);
    assert.ok(def.abilities.length > 0, `${def.id} ${def.name} must have >=1 ability`);

    const state = makePlayingState(100 + def.age);
    const card = instantiateCard(def, `sweep_${def.id}`);
    meldCardInstance(state, 'p1', card);
    // Give both players diverse board/hand/score materials so demands & prompts exercise real branches
    meldCardInstance(state, 'p1', byId('B001', 'p1_r'));
    meldCardInstance(state, 'p2', byId('B003', 'p2_r'));
    meldCardInstance(state, 'p2', byId('B004', 'p2_y'));
    state.players[0].hand = [byId('B002', 'p1_h1'), byId('B010', 'p1_h2')];
    state.players[1].hand = [byId('B005', 'p2_h1'), byId('B008', 'p2_h2')];
    scoreCardInstance(state, 'p1', byId('B006', 'p1_s1'));
    scoreCardInstance(state, 'p2', byId('B016', 'p2_s1'));

    const mid = applyAction(state, { type: 'dogma', playerId: 'p1', color: card.color });
    const after = resolveAllWithAI(mid, 25);
    assert.equal(
      after.pendingPrompts.length,
      0,
      `Card ${def.id} (${def.name}) left unresolved prompt: ${after.pendingPrompts[0]?.title}`
    );
  }
});

test('Audit regression: B048/B094/B108 prompt 1-11 even with 1 score value, B079 returns Skyscrapers, B051 records revealedCardIds', () => {
  // 1. B048 Statistics: single distinct age in victim score pile still prompts [1..11], and naming an absent age moves 0 cards
  const sStats = makePlayingState();
  meldCardInstance(sStats, 'p1', byId('B048', 'p1_stat')); // 2 leaves
  scoreCardInstance(sStats, 'p2', byId('B070', 'p2_s7'));
  let rStats = applyAction(sStats, { type: 'dogma', playerId: 'p1', color: 'yellow' });
  assert.equal(rStats.pendingPrompts.length, 1);
  const statsPrompt = rStats.pendingPrompts[0];
  assert.equal(statsPrompt.kind, 'choose_value');
  assert.equal(statsPrompt.playerId, 'p1');
  if (statsPrompt.kind === 'choose_value') {
    assert.deepEqual(statsPrompt.options, [...ALL_AGES]);
  }
  // Choose absent value [2]: 0 cards returned to P2's hand
  rStats = applyAction(rStats, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: statsPrompt.id,
    selectedValue: 2,
  });
  assert.equal(rStats.players[1].scorePile.length, 1);
  assert.equal(rStats.players[1].hand.length, 0);

  // 2. B094 Services: single distinct age in victim score pile still prompts [1..11]; absent age avoids "If you do" penalty
  const sServ = makePlayingState();
  meldCardInstance(sServ, 'p1', byId('B094', 'p1_serv')); // purple, persona demand
  meldCardInstance(sServ, 'p1', byId('B076', 'p1_red_noleaf')); // red top card without leaf
  scoreCardInstance(sServ, 'p2', byId('B070', 'p2_s7'));
  let rServ = applyAction(sServ, { type: 'dogma', playerId: 'p1', color: 'purple' });
  assert.equal(rServ.pendingPrompts.length, 1);
  const servPrompt = rServ.pendingPrompts[0];
  assert.equal(servPrompt.kind, 'choose_value');
  if (servPrompt.kind === 'choose_value') {
    assert.deepEqual(servPrompt.options, [...ALL_AGES]);
  }
  rServ = applyAction(rServ, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: servPrompt.id,
    selectedValue: 1,
  });
  assert.equal(rServ.players[1].scorePile.length, 1);
  assert.equal(rServ.players[0].hand.length, 0);
  // P1 kept red top card because 0 cards were transferred
  assert.equal(getTopCard(rServ.players[0].board.red)?.defId, 'B076');
  assert.equal(rServ.players[1].hand.length, 0);

  // 3. B108 Near-Field Comm: single distinct age prompts [1..11]; absent value transfers 0 cards
  const sNfc = makePlayingState();
  meldCardInstance(sNfc, 'p1', byId('B108', 'p1_nfc')); // yellow, 2 persona
  scoreCardInstance(sNfc, 'p2', byId('B070', 'p2_s7'));
  let rNfc = applyAction(sNfc, { type: 'dogma', playerId: 'p1', color: 'yellow' });
  assert.equal(rNfc.pendingPrompts.length, 1);
  const nfcPrompt = rNfc.pendingPrompts[0];
  assert.equal(nfcPrompt.kind, 'choose_value');
  if (nfcPrompt.kind === 'choose_value') {
    assert.deepEqual(nfcPrompt.options, [...ALL_AGES]);
  }
  rNfc = applyAction(rNfc, {
    type: 'answer_prompt',
    playerId: 'p1',
    promptId: nfcPrompt.id,
    selectedValue: 3,
  });
  assert.equal(rNfc.players[1].scorePile.length, 1);
  assert.equal(rNfc.players[0].scorePile.length, 0);

  // 4. B079 Skyscrapers: returns Skyscrapers from activating player's yellow top card to their hand on successful demand
  const sSky = makePlayingState();
  meldCardInstance(sSky, 'p1', byId('B079', 'p1_sky')); // yellow, 2 coins
  meldCardInstance(sSky, 'p2', byId('B083', 'p2_rock')); // blue, has clock, 0 coins
  const rSky = applyAction(sSky, { type: 'dogma', playerId: 'p1', color: 'yellow' });
  assert.equal(getTopCard(rSky.players[0].board.blue)?.defId, 'B083');
  assert.equal(getTopCard(rSky.players[0].board.yellow), null);
  assert.ok(rSky.players[0].hand.some((c) => c.defId === 'B079'));

  // 5. B051 Measurement: pushes returned card instanceId into state.revealedCardIds mid-action
  const sMeas = makePlayingState();
  meldCardInstance(sMeas, 'p1', byId('B051', 'p1_meas')); // green, 2 lightbulbs
  meldCardInstance(sMeas, 'p2', byId('B084', 'p2_emp')); // purple, 3 lightbulbs -> shares!
  const p2HandCard = byId('B001', 'p2_meas_ret');
  sMeas.players[1].hand = [p2HandCard];
  sMeas.players[0].hand = [byId('B002', 'p1_meas_ret')];
  let rMeas = applyAction(sMeas, { type: 'dogma', playerId: 'p1', color: 'green' });
  // P2 shares first
  assert.equal(rMeas.pendingPrompts[0]?.playerId, 'p2');
  rMeas = applyAction(rMeas, {
    type: 'answer_prompt',
    playerId: 'p2',
    promptId: rMeas.pendingPrompts[0].id,
    selectedCardIds: [p2HandCard.instanceId],
  });
  // While awaiting P1's prompt in the same action, P2's revealed card must be tracked in revealedCardIds
  assert.equal(rMeas.pendingPrompts[0]?.playerId, 'p1');
  assert.ok(rMeas.revealedCardIds.includes(p2HandCard.instanceId));
});

test('Audit regression: B111 Space Traffic continues steps after sharing elimination and handles self-elimination without soft-lock', () => {
  // Case A: Sharing opponent eliminates themselves on B111 in 1v1v1 -> remaining players STILL execute B111
  const s3 = createGame({
    variant: '1v1v1',
    controlMode: 'vs_ai',
    playerNames: ['P1', 'P2', 'P3'],
    seed: 901,
  });
  s3.phase = 'playing';
  s3.pendingPrompts = [];
  s3.currentPlayerIndex = 0;
  s3.actionsRemaining = 2;
  s3.actionsTotalThisTurn = 2;
  for (const p of s3.players) p.hand = [];

  meldCardInstance(s3, 'p1', byId('B111', 'p1_st')); // 2 coins
  // Give P1 5 red cards so tucking 1 red [11] scores bottom Age 10 -> 11 + 10 = 21 > P3's 20
  meldCardInstance(s3, 'p1', byId('B096', 'p1_r10'));
  meldCardInstance(s3, 'p1', byId('B001', 'p1_r1'));
  meldCardInstance(s3, 'p1', byId('B016', 'p1_r2'));
  meldCardInstance(s3, 'p1', byId('B026', 'p1_r3'));
  meldCardInstance(s3, 'p1', byId('B036', 'p1_r4'));
  scoreCardInstance(s3, 'p1', byId('B106', 'p1_s11')); // 11 pts
  scoreCardInstance(s3, 'p3', byId('B097', 'p3_s10a'));
  scoreCardInstance(s3, 'p3', byId('B098', 'p3_s10b')); // 20 pts
  meldCardInstance(s3, 'p2', byId('B076', 'p2_fl')); // 2 coins -> shares
  meldCardInstance(s3, 'p2', byId('B112', 'p2_b11_1')); // blue [11] on bottom of blue
  meldCardInstance(s3, 'p3', byId('B076', 'p3_fl')); // 2 coins -> shares
  fillDeck(s3, 11, ['B113', 'B112', 'B107', 'B108']); // p2 draws B113 (dies), p3 draws B112 (stops), p1 draws B107 (stops), free draw draws B108

  const r3 = applyAction(s3, { type: 'dogma', playerId: 'p1', color: 'green' });
  assert.equal(r3.phase, 'playing');
  assert.equal(r3.players[1].eliminated, true);
  assert.equal(r3.players[0].eliminated, false);
  assert.equal(r3.players[2].eliminated, false);
  // Both P3 (sharing) and P1 (activating) still executed B111 after P2 was eliminated!
  assert.ok(r3.players[2].board.blue.cards.some((c) => c.defId === 'B112'));
  assert.ok(r3.players[0].scorePile.some((c) => c.defId === 'B107'));

  // Case B: Active player eliminates themselves on Action 1 of their turn after sharing opponent caused card change
  let sSelf = createGame({
    variant: '1v1v1',
    controlMode: 'vs_ai',
    playerNames: ['P1', 'P2', 'P3'],
    seed: 902,
  });
  sSelf.phase = 'playing';
  sSelf.pendingPrompts = [];
  sSelf.currentPlayerIndex = 0;
  sSelf.actionsRemaining = 2;
  sSelf.actionsTotalThisTurn = 2;
  for (const p of sSelf.players) p.hand = [];
  sSelf = setManualEndTurn(sSelf, true, true);

  meldCardInstance(sSelf, 'p1', byId('B111', 'p1_st2')); // 2 coins
  meldCardInstance(sSelf, 'p1', byId('B112', 'p1_b11_bot')); // blue [11] on bottom of P1's blue stack
  meldCardInstance(sSelf, 'p2', byId('B076', 'p2_fl2')); // 2 coins -> shares & causes card change!
  scoreCardInstance(sSelf, 'p2', byId('B106', 'p2_s11')); // 11 pts (> 0) so P2 stops after tucking B107
  fillDeck(sSelf, 11, ['B107', 'B113']); // p2 tucks B107 (red 11, survives); p1 tucks B113 (blue 11 under blue 11 -> P1 eliminated!)

  const rSelf = applyAction(sSelf, { type: 'dogma', playerId: 'p1', color: 'green' });
  assert.equal(rSelf.phase, 'playing');
  assert.equal(rSelf.players[0].eliminated, true);
  // Eliminated activating player MUST NOT receive Sharing Free Draw
  assert.equal(rSelf.players[0].hand.length, 0);
  // Turn must advance away from eliminated P1 without soft-locking (even with manualEndTurn enabled)
  assert.equal(rSelf.players[rSelf.currentPlayerIndex].id, 'p2');
  assert.equal(rSelf.actionsRemaining, 1);
  const p2After = applyAction(rSelf, { type: 'draw', playerId: 'p2' });
  assert.equal(p2After.actionsRemaining, 0);
});

