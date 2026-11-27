import { instantiateCard } from '../data/cards/catalog';
import { applyAction, getLegalTurnOptions } from './engine';
import { projectPlayerView } from './playerView';
import { canSplayStack } from './splay';
import { extractTDFeatures, extractTDFeaturesFromState, TD_INPUT_SIZE } from './tdFeatures';
import {
  createForwardWorkspace,
  evaluateTDWinProbability,
  type TDFunnelModel,
  type TDForwardWorkspace,
} from './tdNetwork';
import {
  ACTIVE_BY_AGE,
  assessSituation,
  buildCandidatePromptAnswers,
  buildFairPlaySimState,
  collectVisiblySeenDefIds,
  formatCandidateLabel,
  hasMaterialStateChange,
  resolveStateThroughPrompts,
  sanitizePromptAction,
  simulateDirectPromptState,
  type SituationAssessment,
} from './ai';
import type {
  AIDecisionCandidateTrace,
  AIDecisionTrace,
  Age,
  CardDefinition,
  GameState,
  PlayerView,
  TurnAction,
} from './types';

export interface TDPlannerOptions {
  /** Number of stratified unseen draw samples evaluated for `draw` chance nodes */
  drawSamples?: number;
  /** Number of determinized worlds evaluated for `dogma` chance branches */
  dogmaSamples?: number;
  /** Enable 1-ply opponent reply minimization at turn end */
  enableOpponentReply?: boolean;
  /** Enable 2-step Action-1 combo follow-up lookahead (meld->dogma/achieve, dogma->achieve) */
  enableLookahead?: boolean;
  /** Exploration epsilon (0..1) for self-play / difficulty variance */
  epsilon?: number;
  /** Softmax temperature (> 0) for Boltzmann exploration over candidate win probabilities */
  temperature?: number;
  /** Deterministic RNG [0, 1) when sampling exploratory actions */
  rng?: () => number;
  /** Reusable scratch buffers to minimize GC pressure during training */
  featureBuf?: Float32Array;
  workspace?: TDForwardWorkspace;
}

function quickCardImpactHeuristic(def: CardDefinition, view: PlayerView): number {
  let score = def.age * 1.5;
  if (view.viewer.board[def.color].cards.length === 0) score += 2.5;
  let iconCount = 0;
  for (const s of ['tl', 'bl', 'bc', 'br'] as const) {
    if (def.icons[s] !== 'hexagon') iconCount += 1;
  }
  score += iconCount * 0.7;
  if (def.abilities.some((a) => a.isDemand)) score += 1.2;
  return score;
}

function selectStratifiedDrawDefinitions(
  view: PlayerView,
  age: Age,
  k: number
): CardDefinition[] {
  const seen = collectVisiblySeenDefIds(view);
  const allAge = ACTIVE_BY_AGE[age];
  const unseen = allAge.filter((c) => !seen.has(c.id));
  const pool = (unseen.length > 0 ? unseen : allAge).slice();
  if (pool.length === 0) return [];
  pool.sort((a, b) => quickCardImpactHeuristic(a, view) - quickCardImpactHeuristic(b, view));
  if (pool.length <= k) return pool;

  const picked: CardDefinition[] = [];
  for (let i = 0; i < k; i++) {
    const idx = Math.min(pool.length - 1, Math.floor(((i + 0.5) * pool.length) / k));
    picked.push(pool[idx]);
  }
  return picked;
}

function evaluateGameStateWithTD(
  state: GameState,
  viewerId: string,
  model: TDFunnelModel,
  featureBuf: Float32Array,
  ws: TDForwardWorkspace
): number {
  if (state.phase === 'gameover' && state.victory) {
    if (state.victory.winnerPlayerIds.includes(viewerId)) return 1.0;
    if (state.victory.winnerPlayerIds.length === 0) {
      return state.variant === '1v1v1' ? 1 / 3 : 0.5;
    }
    return 0.0;
  }
  const player = state.players.find((p) => p.id === viewerId);
  if (!player || player.eliminated) return 0.0;
  const feats = extractTDFeaturesFromState(state, viewerId, featureBuf);
  return evaluateTDWinProbability(model, feats, ws);
}

function evaluateOpponentCounterTD(
  simAfter: GameState,
  aiId: string,
  model: TDFunnelModel,
  featureBuf: Float32Array,
  ws: TDForwardWorkspace
): number | null {
  if (simAfter.phase !== 'playing') return null;
  const aiIdx = simAfter.players.findIndex((p) => p.id === aiId);
  if (aiIdx === -1) return null;
  const aiPlayer = simAfter.players[aiIdx];

  let oppIdx = simAfter.currentPlayerIndex;
  const isOpp = (idx: number) => {
    const p = simAfter.players[idx];
    return !p.eliminated && p.id !== aiId && (simAfter.variant !== '2v2' || p.teamId !== aiPlayer.teamId);
  };
  if (!isOpp(oppIdx)) {
    let probe = (oppIdx + 1) % simAfter.players.length;
    while (probe !== oppIdx && !isOpp(probe)) {
      probe = (probe + 1) % simAfter.players.length;
    }
    if (!isOpp(probe)) return null;
    oppIdx = probe;
  }

  const opp = simAfter.players[oppIdx];
  const oppSim: GameState = {
    ...simAfter,
    currentPlayerIndex: oppIdx,
    actionsRemaining: 1,
  };
  const oppOpts = getLegalTurnOptions(oppSim, opp.id);
  const oppCands: TurnAction[] = [];
  if (oppOpts.achievableAges.length > 0) {
    oppCands.push({
      type: 'achieve',
      playerId: opp.id,
      age: oppOpts.achievableAges[oppOpts.achievableAges.length - 1],
    });
  }
  for (const col of oppOpts.dogmaColors) {
    oppCands.push({ type: 'dogma', playerId: opp.id, color: col });
  }
  if (oppOpts.meldableCardIds.length > 0) {
    let bestMeldId: string | null = null;
    let bestMeldAge = -1;
    for (const mid of oppOpts.meldableCardIds) {
      const c = opp.hand.find((h) => h.instanceId === mid);
      if (c && c.age > bestMeldAge) {
        bestMeldAge = c.age;
        bestMeldId = mid;
      }
    }
    if (bestMeldId) {
      oppCands.push({ type: 'meld', playerId: opp.id, cardInstanceId: bestMeldId });
    }
  }
  if (oppCands.length === 0 && oppOpts.canDraw) {
    oppCands.push({ type: 'draw', playerId: opp.id });
  }
  if (oppCands.length === 0) return null;

  const oppSitu = assessSituation(projectPlayerView(oppSim, opp.id));
  const evalLeaf = (s: GameState, pid: string) =>
    evaluateGameStateWithTD(s, pid, model, featureBuf, ws);
  let worstAiWinProb = Infinity;
  for (const c of oppCands) {
    try {
      const oppMid = applyAction(oppSim, c);
      const oppAfter = resolveStateThroughPrompts(
        oppMid,
        opp.id,
        oppSitu,
        2,
        { remaining: 6 },
        undefined,
        undefined,
        evalLeaf
      );
      const pWin = evaluateGameStateWithTD(oppAfter, aiId, model, featureBuf, ws);
      if (pWin < worstAiWinProb) {
        worstAiWinProb = pWin;
      }
    } catch {
      // Ignore illegal counter branch
    }
  }
  return Number.isFinite(worstAiWinProb) ? worstAiWinProb : null;
}

function buildChooseOrderCandidates(
  prompt: Extract<NonNullable<GameState['pendingPrompts'][number]>, { kind: 'choose_order' }>
): TurnAction[] {
  const pid = prompt.playerId;
  const cards = prompt.cards;
  if (cards.length <= 1) {
    return [
      {
        type: 'answer_prompt',
        playerId: pid,
        promptId: prompt.id,
        orderedCardIds: cards.map((c) => c.instanceId),
      },
    ];
  }

  const actions: TurnAction[] = [];
  const seen = new Set<string>();
  const addOrder = (ids: string[]) => {
    const key = ids.join('|');
    if (seen.has(key)) return;
    seen.add(key);
    actions.push({
      type: 'answer_prompt',
      playerId: pid,
      promptId: prompt.id,
      orderedCardIds: ids,
    });
  };

  addOrder(cards.map((c) => c.instanceId));

  // Deduplicate candidate pivots by (defId, color) if prompt has many cards
  const pivots =
    cards.length <= 5
      ? cards
      : cards.filter((c, i, arr) => arr.findIndex((x) => x.defId === c.defId && x.color === c.color) === i);

  for (const pivot of pivots.slice(0, 6)) {
    const rest = cards.filter((c) => c.instanceId !== pivot.instanceId).map((c) => c.instanceId);
    addOrder([...rest, pivot.instanceId]); // pivot last -> top on meld
    addOrder([pivot.instanceId, ...rest]); // pivot first -> bottom/top-when-empty on tuck
  }

  return actions;
}

function pickSoftmaxOrGreedy<T>(
  items: ReadonlyArray<{ item: T; score: number }>,
  epsilon: number,
  temperature: number,
  rng: () => number
): T {
  if (epsilon > 0 && rng() < epsilon) {
    return items[Math.floor(rng() * items.length)].item;
  }
  if (temperature > 0 && items.length > 1) {
    let maxU = -Infinity;
    for (const s of items) if (s.score > maxU) maxU = s.score;
    const weights = items.map((s) => Math.exp(((s.score - maxU) * 10) / temperature));
    const wSum = weights.reduce((a, b) => a + b, 0);
    if (Number.isFinite(wSum) && wSum > 0) {
      let r = rng() * wSum;
      for (let i = 0; i < items.length; i++) {
        r -= weights[i];
        if (r <= 0) return items[i].item;
      }
    }
  }
  let best = items[0];
  for (let i = 1; i < items.length; i++) {
    if (items[i].score > best.score) best = items[i];
  }
  return best.item;
}

function choosePromptActionWithTD(
  view: PlayerView,
  model: TDFunnelModel,
  situ: SituationAssessment,
  featureBuf: Float32Array,
  ws: TDForwardWorkspace,
  epsilon = 0,
  temperature = 0,
  rng: () => number = Math.random
): TurnAction {
  const prompt = view.pendingPromptForViewer!;
  const simBase = buildFairPlaySimState(view, 0);
  simBase.pendingPrompts = [prompt];

  const evalLeaf = (s: GameState, pid: string) =>
    evaluateGameStateWithTD(s, pid, model, featureBuf, ws);

  let candidateAnswers: TurnAction[];
  if (prompt.kind === 'choose_order') {
    candidateAnswers = buildChooseOrderCandidates(prompt);
  } else {
    candidateAnswers = buildCandidatePromptAnswers(simBase, prompt, situ, 10, view);
    if (prompt.kind === 'choose_color' && prompt.splayDirection && prompt.splayDirection !== 'none') {
      const targetDir = prompt.splayDirection;
      const validSplay = candidateAnswers.filter(
        (ans) =>
          ans.type === 'answer_prompt' &&
          (!ans.selectedColor || canSplayStack(view.viewer.board[ans.selectedColor], targetDir))
      );
      if (validSplay.length > 0) {
        candidateAnswers = validSplay;
      }
    }
  }

  if (candidateAnswers.length === 0) {
    if (prompt.kind === 'setup_meld') {
      return sanitizePromptAction(view, {
        type: 'setup_meld',
        playerId: view.viewerId,
        cardInstanceId: prompt.options[0].instanceId,
      });
    }
    return sanitizePromptAction(view, {
      type: 'answer_prompt',
      playerId: view.viewerId,
      promptId: prompt.id,
    });
  }

  const scoredPrompts: Array<{ item: TurnAction; score: number }> = [];

  for (const ans of candidateAnswers) {
    try {
      const simRes = simulateDirectPromptState(simBase, view, prompt, ans, situ, evalLeaf);
      let resolved = simRes.sim;
      if (!simRes.simulated) {
        const next = applyAction(simBase, ans);
        resolved = resolveStateThroughPrompts(
          next,
          view.viewerId,
          situ,
          1,
          { remaining: 12 },
          view,
          undefined,
          evalLeaf
        );
      }
      const prob = evalLeaf(resolved, view.viewerId);
      scoredPrompts.push({ item: ans, score: prob });
    } catch {
      // Ignore invalid candidate branch
    }
  }

  const picked =
    scoredPrompts.length > 0
      ? pickSoftmaxOrGreedy(scoredPrompts, epsilon, temperature, rng)
      : candidateAnswers[0];

  return sanitizePromptAction(view, picked);
}

/**
 * Selects an action using Keldon Jones-style 1-ply / shallow expectiminimax lookahead
 * over chance nodes (unseen Age card draws & fair-play Dogma worlds), scoring each
 * leaf strictly from fair-play `PlayerView` via the variant's 2-layer TD funnel MLP.
 */
export function chooseTDActionWithModel(
  view: PlayerView,
  model: TDFunnelModel,
  traceOut?: AIDecisionTrace,
  options?: TDPlannerOptions
): TurnAction {
  const aiId = view.viewerId;
  const featureBuf = options?.featureBuf ?? new Float32Array(TD_INPUT_SIZE);
  const ws = options?.workspace ?? createForwardWorkspace(model.outputSize);
  const enableLookahead = options?.enableLookahead ?? true;
  const drawSamples = options?.drawSamples ?? (enableLookahead ? 6 : 1);
  const dogmaSamples = options?.dogmaSamples ?? (enableLookahead ? 3 : 1);
  const enableOppReply = enableLookahead ? (options?.enableOpponentReply ?? true) : false;
  const epsilon = options?.epsilon ?? 0;
  const temperature = options?.temperature ?? 0;
  const rng = options?.rng ?? Math.random;

  const situ = assessSituation(view);

  if (view.pendingPromptForViewer) {
    const promptAction = choosePromptActionWithTD(
      view,
      model,
      situ,
      featureBuf,
      ws,
      epsilon,
      temperature,
      rng
    );
    if (traceOut) {
      traceOut.id = `td_trace_${view.turnNumber}_${Date.now()}`;
      traceOut.turn = view.turnNumber;
      traceOut.actorId = aiId;
      traceOut.actorName = view.viewer.name;
      traceOut.actionLabel = `[TD] ${view.pendingPromptForViewer.title}`;
      traceOut.situationSummary = `Score ${situ.myScore} · Top [${view.viewer.highestTopAge}] · Hand ${view.viewer.hand.length}`;
      traceOut.chosenLabel =
        promptAction.type === 'setup_meld'
          ? `Starting meld (${promptAction.cardInstanceId})`
          : 'TD Prompt Choice';
      traceOut.candidates = [];
    }
    return promptAction;
  }

  const simBase = buildFairPlaySimState(view, 0);
  const legal = getLegalTurnOptions(simBase, aiId);
  const simSamples: GameState[] = [simBase];
  if (legal.dogmaColors.length > 0 && dogmaSamples > 1) {
    for (let s = 1; s < dogmaSamples; s++) {
      simSamples.push(buildFairPlaySimState(view, s));
    }
  }

  const baselineFeats = extractTDFeatures(view, featureBuf);
  const baselineWinProb = evaluateTDWinProbability(model, baselineFeats, ws);

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

  interface ScoredCandidate {
    cand: TurnAction;
    expectedWinProb: number;
    utility: number;
    immediateWinProb: number;
    oppAdjustedWinProb: number;
    samplesUsed: number;
  }

  const scored: ScoredCandidate[] = [];

  for (const cand of candidates) {
    if (cand.type === 'draw') {
      const targetAge = legal.drawTargetAge;
      if (targetAge === null) {
        // Age 12+ exhaustion -> deterministic score victory evaluation
        try {
          const simAfter = applyAction(simBase, cand);
          const pWin = evaluateGameStateWithTD(simAfter, aiId, model, featureBuf, ws);
          scored.push({
            cand,
            expectedWinProb: pWin,
            utility: pWin,
            immediateWinProb: pWin,
            oppAdjustedWinProb: pWin,
            samplesUsed: 1,
          });
        } catch {
          // ignore
        }
        continue;
      }

      const drawPool = selectStratifiedDrawDefinitions(view, targetAge, drawSamples);
      if (drawPool.length === 0) {
        try {
          const simAfter = applyAction(simBase, cand);
          const pWin = evaluateGameStateWithTD(simAfter, aiId, model, featureBuf, ws);
          scored.push({
            cand,
            expectedWinProb: pWin,
            utility: pWin,
            immediateWinProb: pWin,
            oppAdjustedWinProb: pWin,
            samplesUsed: 1,
          });
        } catch {
          // ignore
        }
        continue;
      }

      let sumWin = 0;
      let valid = 0;
      let oppWinRef: number | null = null;

      for (let i = 0; i < drawPool.length; i++) {
        const def = drawPool[i];
        simBase.decks[targetAge].unshift(instantiateCard(def, `td_chance_${i}`));
        try {
          const simAfter = applyAction(simBase, cand);
          const pWin = evaluateGameStateWithTD(simAfter, aiId, model, featureBuf, ws);
          sumWin += pWin;
          valid += 1;
          if (
            enableOppReply &&
            oppWinRef === null &&
            i === Math.floor(drawPool.length / 2) &&
            simAfter.phase === 'playing' &&
            simAfter.players[simAfter.currentPlayerIndex]?.id !== aiId
          ) {
            oppWinRef = evaluateOpponentCounterTD(simAfter, aiId, model, featureBuf, ws);
          }
        } catch {
          // ignore
        } finally {
          simBase.decks[targetAge].shift();
        }
      }

      if (valid > 0) {
        const meanWin = sumWin / valid;
        const blended = oppWinRef !== null ? meanWin * 0.7 + oppWinRef * 0.3 : meanWin;
        scored.push({
          cand,
          expectedWinProb: blended,
          utility: blended,
          immediateWinProb: meanWin,
          oppAdjustedWinProb: oppWinRef ?? meanWin,
          samplesUsed: valid,
        });
      }
      continue;
    }

    if (cand.type === 'achieve') {
      try {
        const simAfter = applyAction(simBase, cand);
        const immediateWin = evaluateGameStateWithTD(simAfter, aiId, model, featureBuf, ws);
        let blended = immediateWin;
        let oppWin = immediateWin;
        if (
          enableOppReply &&
          simAfter.phase === 'playing' &&
          simAfter.players[simAfter.currentPlayerIndex]?.id !== aiId
        ) {
          const reply = evaluateOpponentCounterTD(simAfter, aiId, model, featureBuf, ws);
          if (reply !== null) {
            oppWin = reply;
            blended = immediateWin * 0.7 + reply * 0.3;
          }
        }
        scored.push({
          cand,
          expectedWinProb: blended,
          utility: blended + cand.age * 0.0005,
          immediateWinProb: immediateWin,
          oppAdjustedWinProb: oppWin,
          samplesUsed: 1,
        });
      } catch {
        // ignore
      }
      continue;
    }

    if (cand.type === 'meld') {
      try {
        const evalLeaf = (s: GameState, pid: string) =>
          evaluateGameStateWithTD(s, pid, model, featureBuf, ws);
        const simAfter = applyAction(simBase, cand);
        const immediateWin = evaluateGameStateWithTD(simAfter, aiId, model, featureBuf, ws);
        let bestCombo = immediateWin;
        let comboEndState: GameState = simAfter;

        // 1-step follow-up lookahead when this is Action 1 of 2 and melding unlocks a Dogma or Achieve
        if (
          enableLookahead &&
          view.actionsRemaining >= 2 &&
          simAfter.phase === 'playing' &&
          simAfter.pendingPrompts.length === 0 &&
          simAfter.players[simAfter.currentPlayerIndex]?.id === aiId
        ) {
          const followLegal = getLegalTurnOptions(simAfter, aiId);
          if (followLegal.achievableAges.length > 0) {
            try {
              const achieveAge = followLegal.achievableAges[followLegal.achievableAges.length - 1];
              const afterAchieve = applyAction(simAfter, {
                type: 'achieve',
                playerId: aiId,
                age: achieveAge,
              });
              const achWin = evaluateGameStateWithTD(afterAchieve, aiId, model, featureBuf, ws);
              const blendedAch = immediateWin * 0.3 + achWin * 0.7;
              if (blendedAch > bestCombo) {
                bestCombo = blendedAch;
                comboEndState = afterAchieve;
              }
            } catch {
              // ignore
            }
          }

          const card = view.viewer.hand.find((c) => c.instanceId === cand.cardInstanceId);
          if (
            card &&
            card.abilities.length > 0 &&
            (legal.meldableCardIds.length <= 6 || card.age >= view.viewer.highestTopAge - 1)
          ) {
            try {
              const afterDogmaMid = applyAction(simAfter, {
                type: 'dogma',
                playerId: aiId,
                color: card.color,
              });
              const afterDogma = resolveStateThroughPrompts(
                afterDogmaMid,
                aiId,
                situ,
                1,
                { remaining: 8 },
                undefined,
                undefined,
                evalLeaf
              );
              const comboWin = evaluateGameStateWithTD(afterDogma, aiId, model, featureBuf, ws);
              const blendedDogma = immediateWin * 0.3 + comboWin * 0.7;
              if (blendedDogma > bestCombo) {
                bestCombo = blendedDogma;
                comboEndState = afterDogma;
              }
            } catch {
              // ignore
            }
          }
        }

        let blended = bestCombo;
        let oppWin = bestCombo;
        if (
          enableOppReply &&
          comboEndState.phase === 'playing' &&
          comboEndState.players[comboEndState.currentPlayerIndex]?.id !== aiId
        ) {
          const reply = evaluateOpponentCounterTD(comboEndState, aiId, model, featureBuf, ws);
          if (reply !== null) {
            oppWin = reply;
            blended = bestCombo * 0.7 + reply * 0.3;
          }
        }

        scored.push({
          cand,
          expectedWinProb: blended,
          utility: blended,
          immediateWinProb: immediateWin,
          oppAdjustedWinProb: oppWin,
          samplesUsed: 1,
        });
      } catch {
        // ignore
      }
      continue;
    }

    if (cand.type === 'dogma') {
      let sumWin = 0;
      let valid = 0;
      let anyChange = false;
      let oppWinRef: number | null = null;
      const evalLeaf = (s: GameState, pid: string) =>
        evaluateGameStateWithTD(s, pid, model, featureBuf, ws);

      for (let s = 0; s < simSamples.length; s++) {
        const simBefore = simSamples[s];
        try {
          const simMid = applyAction(simBefore, cand);
          const simAfter = resolveStateThroughPrompts(
            simMid,
            aiId,
            situ,
            0,
            { remaining: 14 },
            undefined,
            undefined,
            evalLeaf
          );
          if (hasMaterialStateChange(simBefore, simAfter)) {
            anyChange = true;
          }
          let pWin = evaluateGameStateWithTD(simAfter, aiId, model, featureBuf, ws);
          let endState = simAfter;

          // If Action 1 Dogma unlocks an immediate Achievement, account for Action 2 Achieve
          if (
            enableLookahead &&
            view.actionsRemaining >= 2 &&
            simAfter.phase === 'playing' &&
            simAfter.pendingPrompts.length === 0 &&
            simAfter.players[simAfter.currentPlayerIndex]?.id === aiId
          ) {
            const followLegal = getLegalTurnOptions(simAfter, aiId);
            if (followLegal.achievableAges.length > 0) {
              try {
                const achAge = followLegal.achievableAges[followLegal.achievableAges.length - 1];
                const afterAch = applyAction(simAfter, {
                  type: 'achieve',
                  playerId: aiId,
                  age: achAge,
                });
                const achWin = evaluateGameStateWithTD(afterAch, aiId, model, featureBuf, ws);
                const combo = pWin * 0.3 + achWin * 0.7;
                if (combo > pWin) {
                  pWin = combo;
                  endState = afterAch;
                }
              } catch {
                // ignore
              }
            }
          }

          sumWin += pWin;
          valid += 1;

          if (
            enableOppReply &&
            s === 0 &&
            endState.phase === 'playing' &&
            endState.players[endState.currentPlayerIndex]?.id !== aiId
          ) {
            oppWinRef = evaluateOpponentCounterTD(endState, aiId, model, featureBuf, ws);
          }
        } catch {
          // ignore
        }
      }

      if (valid > 0) {
        const meanWin = sumWin / valid;
        const blended = oppWinRef !== null ? meanWin * 0.7 + oppWinRef * 0.3 : meanWin;
        const utility = anyChange ? blended : blended - 0.08;
        scored.push({
          cand,
          expectedWinProb: blended,
          utility,
          immediateWinProb: meanWin,
          oppAdjustedWinProb: oppWinRef ?? meanWin,
          samplesUsed: valid,
        });
      }
    }
  }

  let chosen: TurnAction = { type: 'draw', playerId: aiId };
  if (scored.length > 0) {
    if (epsilon > 0 && rng() < epsilon) {
      chosen = scored[Math.floor(rng() * scored.length)].cand;
    } else if (temperature > 0 && scored.length > 1) {
      let maxU = -Infinity;
      for (const s of scored) if (s.utility > maxU) maxU = s.utility;
      const weights = scored.map((s) => Math.exp(((s.utility - maxU) * 10) / temperature));
      const wSum = weights.reduce((a, b) => a + b, 0);
      let r = rng() * wSum;
      let picked = scored[0].cand;
      for (let i = 0; i < scored.length; i++) {
        r -= weights[i];
        if (r <= 0) {
          picked = scored[i].cand;
          break;
        }
      }
      chosen = picked;
    } else {
      let best = scored[0];
      for (let i = 1; i < scored.length; i++) {
        if (scored[i].utility > best.utility) best = scored[i];
      }
      chosen = best.cand;
    }
  }

  if (traceOut) {
    const drawTarget = legal.drawTargetAge ?? Math.max(1, view.viewer.highestTopAge);
    const chosenLabel = formatCandidateLabel(view, chosen, drawTarget);
    const traceCandidates: AIDecisionCandidateTrace[] = scored
      .slice()
      .sort((a, b) => b.utility - a.utility)
      .map((entry) => {
        const winPct = Math.round(entry.expectedWinProb * 1000) / 10;
        const immPct = Math.round(entry.immediateWinProb * 1000) / 10;
        const deltaPct = Math.round((entry.expectedWinProb - baselineWinProb) * 1000) / 10;
        const oppDeltaPct = Math.round((entry.oppAdjustedWinProb - entry.immediateWinProb) * 1000) / 10;
        return {
          label: `${formatCandidateLabel(view, entry.cand, drawTarget)}`,
          actionType: entry.cand.type,
          score: winPct,
          selected: entry.cand === chosen,
          breakdown: [
            { factor: 'Expected Win %', delta: winPct },
            { factor: 'Immediate Win %', delta: immPct },
            { factor: 'Delta vs Current Pos %', delta: deltaPct },
            { factor: 'Opp Reply Adjustment %', delta: oppDeltaPct },
            { factor: 'Chance Branches Evaluated', delta: entry.samplesUsed },
          ],
        };
      });

    traceOut.id = `td_trace_${view.turnNumber}_${view.actionsRemaining}_${Date.now()}`;
    traceOut.turn = view.turnNumber;
    traceOut.actorId = aiId;
    traceOut.actorName = view.viewer.name;
    traceOut.actionLabel = `TD AI (${view.actionsRemaining} left)`;
    traceOut.situationSummary = `Est Win ${(baselineWinProb * 100).toFixed(1)}% · Score ${situ.myScore} · Ach ${view.viewer.achievements.length}/${view.achievementTarget} · Top [${view.viewer.highestTopAge}]`;
    traceOut.chosenLabel = `${chosenLabel}`;
    traceOut.candidates = traceCandidates;
  }

  if (scored.length > 0) {
    return chosen;
  }

  if (legal.achievableAges.length > 0) {
    return { type: 'achieve', playerId: aiId, age: legal.achievableAges[0] };
  }
  if (legal.meldableCardIds.length > 0) {
    return { type: 'meld', playerId: aiId, cardInstanceId: legal.meldableCardIds[0] };
  }
  return { type: 'draw', playerId: aiId };
}
