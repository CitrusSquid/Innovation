import { assessSituation, chooseAIAction, evaluateGameStateForPlayer } from './ai';
import { applyAction, createGame } from './engine';
import { computeScoreTotal, computeTeamAchievements } from './keywords';
import { projectPlayerView } from './playerView';
import { extractTDFeaturesFromState, TD_FEATURE_VERSION, TD_INPUT_SIZE } from './tdFeatures';
import {
  computeTDLambdaTargets,
  createRandomFunnelModel,
  createTrainWorkspace,
  hydrateTDModel,
  serializeTDModel,
  TD_DEFAULT_BATCH_SIZE,
  trainTDPairsMiniBatch,
  type TDActivation,
  type TDFunnelModel,
  type TDModelBundle,
  type TDTrainWorkspace,
} from './tdNetwork';
import { chooseTDActionWithModel } from './tdPlanner';
import type { GameState, GameVariant, PlayerState, TurnAction } from './types';

export const TD_DEFAULT_DISTILL_WEIGHT = 0.55;
export const TD_DEFAULT_DISTILL_TEMPERATURE = 40;

function makeSeededRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Returns the set of seat IDs controlled by full-strength Heuristic AI for a given
 * TD self-play game index (30% mixed-league games, alternating seats fairly across
 * going first/second in 1v1, 1v1v1, and 2v2).
 */
export function getMixedHeuristicSeatSet(variant: GameVariant, gameIndex: number): Set<string> {
  const mod10 = ((gameIndex % 10) + 10) % 10;
  if (mod10 !== 2 && mod10 !== 5 && mod10 !== 8) {
    return new Set();
  }
  if (variant === '1v1') {
    return new Set([gameIndex % 2 === 1 ? 'p1' : 'p2']);
  }
  if (variant === '1v1v1') {
    const rot = gameIndex % 3;
    if (rot === 0) return new Set(['p2', 'p3']);
    if (rot === 1) return new Set(['p1', 'p3']);
    return new Set(['p1', 'p2']);
  }
  return gameIndex % 2 === 1 ? new Set(['p1', 'p3']) : new Set(['p2', 'p4']);
}

function getTurnFallbackWinners(state: GameState): Set<string> {
  if (state.victory) {
    return new Set(state.victory.winnerPlayerIds);
  }
  const active = state.players.filter((p) => !p.eliminated);
  if (active.length === 0) return new Set();

  if (state.variant === '2v2') {
    const teamA = active.filter((p) => p.teamId === 'A');
    const teamB = active.filter((p) => p.teamId === 'B');
    const achA = computeTeamAchievements(state, 'A');
    const achB = computeTeamAchievements(state, 'B');
    const scoreA = teamA.reduce((s, p) => s + computeScoreTotal(p), 0);
    const scoreB = teamB.reduce((s, p) => s + computeScoreTotal(p), 0);
    if (achA > achB || (achA === achB && scoreA > scoreB)) {
      return new Set(teamA.map((p) => p.id));
    }
    if (achB > achA || (achA === achB && scoreB > scoreA)) {
      return new Set(teamB.map((p) => p.id));
    }
    return new Set();
  }

  const ranked = [...active].sort(
    (a, b) =>
      b.achievements.length - a.achievements.length ||
      computeScoreTotal(b) - computeScoreTotal(a)
  );
  const top = ranked[0];
  const topAch = top.achievements.length;
  const topScore = computeScoreTotal(top);
  const tied = ranked.filter(
    (p) => p.achievements.length === topAch && computeScoreTotal(p) === topScore
  );
  if (tied.length > 1) return new Set();
  return new Set([top.id]);
}

function buildRotatedTargetForPlayer(
  state: GameState,
  playerIndex: number,
  winnerIds: Set<string>
): Float32Array {
  const outSize = state.variant === '1v1v1' ? 3 : 2;
  const target = new Float32Array(outSize);
  const n = state.players.length;
  const self = state.players[playerIndex];

  if (state.variant === '2v2') {
    if (winnerIds.size === 0) {
      target[0] = 0.5;
      target[1] = 0.5;
      return target;
    }
    const selfTeamWon = state.players.some(
      (p) => p.teamId === self.teamId && winnerIds.has(p.id)
    );
    target[0] = selfTeamWon ? 1 : 0;
    target[1] = selfTeamWon ? 0 : 1;
    return target;
  }

  if (winnerIds.size === 0) {
    target.fill(1 / outSize);
    return target;
  }

  let sum = 0;
  for (let offset = 0; offset < outSize; offset++) {
    const slotPlayer = state.players[(playerIndex + offset) % n];
    const w = winnerIds.has(slotPlayer.id) ? 1 : 0;
    target[offset] = w;
    sum += w;
  }
  if (sum > 0) {
    for (let k = 0; k < outSize; k++) target[k] /= sum;
  } else {
    target.fill(1 / outSize);
  }
  return target;
}

export function computeHeuristicDistillTarget(
  state: GameState,
  playerIndex: number,
  temperature = TD_DEFAULT_DISTILL_TEMPERATURE
): Float32Array {
  const outSize = state.variant === '1v1v1' ? 3 : 2;
  const logits = new Float32Array(outSize);
  const probs = new Float32Array(outSize);

  const evalPlayer = (p: PlayerState): number => {
    if (p.eliminated) return -100000;
    const pv = projectPlayerView(state, p.id);
    return evaluateGameStateForPlayer(state, p.id, assessSituation(pv));
  };

  if (state.variant === '2v2') {
    const self = state.players[playerIndex];
    const ally = state.players.find((p) => p.id !== self.id && p.teamId === self.teamId);
    const opps = state.players.filter((p) => p.teamId !== self.teamId);
    const selfTeamScore = ally ? 0.5 * (evalPlayer(self) + evalPlayer(ally)) : evalPlayer(self);
    const oppTeamScore =
      opps.length >= 2
        ? 0.5 * (evalPlayer(opps[0]) + evalPlayer(opps[1]))
        : opps[0]
        ? evalPlayer(opps[0])
        : 0;
    logits[0] = selfTeamScore / temperature;
    logits[1] = oppTeamScore / temperature;
  } else {
    const n = state.players.length;
    for (let offset = 0; offset < outSize; offset++) {
      const slotPlayer = state.players[(playerIndex + offset) % n];
      logits[offset] = evalPlayer(slotPlayer) / temperature;
    }
  }

  let maxLogit = -Infinity;
  for (let k = 0; k < outSize; k++) {
    if (logits[k] > maxLogit) maxLogit = logits[k];
  }

  let expSum = 0;
  for (let k = 0; k < outSize; k++) {
    const diff = Math.max(-30, logits[k] - maxLogit);
    const e = Math.exp(diff);
    probs[k] = e;
    expSum += e;
  }
  const inv = expSum > 0 ? 1 / expSum : 1 / outSize;
  for (let k = 0; k < outSize; k++) {
    probs[k] *= inv;
  }
  return probs;
}

export interface EpisodeResult {
  variant: GameVariant;
  winnerIds: string[];
  turns: number;
  trajectories: Float32Array[][];
  targets: Float32Array[];
  distillTargets?: Float32Array[][];
}

export function playFastTrainingEpisode(
  variant: GameVariant,
  seed: number,
  choosePolicy: (state: GameState, actorId: string) => TurnAction,
  recordTrajectories = true,
  maxActions = 450,
  recordHeuristicDistill = false
): EpisodeResult {
  const seatCount = variant === '1v1' ? 2 : variant === '1v1v1' ? 3 : 4;
  const state = createGame({
    variant,
    controlMode: 'vs_ai',
    playerNames: Array.from({ length: seatCount }, (_, i) => `Bot ${i + 1}`),
    playerIsAI: Array.from({ length: seatCount }, () => true),
    seed,
    fastSimulation: true,
  });

  const trajectories: Float32Array[][] = Array.from({ length: seatCount }, () => []);
  const distillTargets: Float32Array[][] | undefined =
    recordTrajectories && recordHeuristicDistill
      ? Array.from({ length: seatCount }, () => [])
      : undefined;
  const featureBuf = new Float32Array(TD_INPUT_SIZE);

  let steps = 0;
  while (state.phase !== 'gameover' && steps < maxActions) {
    steps += 1;
    const actorId =
      state.pendingPrompts[0]?.playerId ?? state.players[state.currentPlayerIndex]?.id;
    if (!actorId) break;

    const prevPhase = state.phase;
    const action = choosePolicy(state, actorId);
    applyAction(state, action, { mutateInPlace: true });

    // Record post-turn state snapshot for active player whenever a regular action completes cleanly
    if (
      recordTrajectories &&
      prevPhase === 'playing' &&
      state.phase === 'playing' &&
      state.pendingPrompts.length === 0
    ) {
      const idx = state.players.findIndex((p) => p.id === actorId);
      if (idx !== -1 && !state.players[idx].eliminated) {
        const vec = extractTDFeaturesFromState(state, actorId, featureBuf);
        trajectories[idx].push(Float32Array.from(vec));
        if (distillTargets) {
          distillTargets[idx].push(computeHeuristicDistillTarget(state, idx));
        }
      }
    }
  }

  const winnerSet = getTurnFallbackWinners(state);
  const targets = state.players.map((_, idx) =>
    buildRotatedTargetForPlayer(state, idx, winnerSet)
  );

  return {
    variant,
    winnerIds: Array.from(winnerSet),
    turns: state.turnNumber,
    trajectories,
    targets,
    ...(distillTargets ? { distillTargets } : {}),
  };
}

export interface WindowProgressStats {
  windowGames: number;
  windowLoss: number;
  avgTurns: number;
  p1Wins: number;
  p2Wins: number;
  p3Wins: number;
  draws: number;
  vsHeurGames: number;
  vsHeurWins: number;
  vsHeurLosses: number;
  vsHeurDraws: number;
}

export interface WarmstartOptions {
  games: number;
  learningRate: number;
  batchSize?: number;
  distillWeight?: number;
  seed?: number;
  logEvery?: number;
  logProgress?: (done: number, total: number, avgLoss: number, stats?: WindowProgressStats) => void;
}

function shufflePairedArrays(
  xs: Float32Array[],
  ys: Float32Array[],
  seed: number
): void {
  let rng = seed >>> 0 || 1;
  for (let i = xs.length - 1; i > 0; i--) {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    const j = rng % (i + 1);
    const tmpX = xs[i];
    xs[i] = xs[j];
    xs[j] = tmpX;
    const tmpY = ys[i];
    ys[i] = ys[j];
    ys[j] = tmpY;
  }
}

export function blendDistillationTarget(
  tdTarget: Float32Array,
  distillTarget: Float32Array | undefined,
  distillWeight: number
): Float32Array {
  if (!distillTarget || distillWeight <= 0) return tdTarget;
  const w = Math.min(1, distillWeight);
  const out = new Float32Array(tdTarget.length);
  const invW = 1 - w;
  for (let k = 0; k < tdTarget.length; k++) {
    out[k] = invW * tdTarget[k] + w * distillTarget[k];
  }
  return out;
}

export function runWarmstartPretraining(
  model: TDFunnelModel,
  opts: WarmstartOptions
): { avgLoss: number } {
  if (opts.games <= 0) return { avgLoss: 0 };
  const ws: TDTrainWorkspace = createTrainWorkspace(model);
  const baseSeed = opts.seed ?? 10000;
  const batchSize = Math.max(1, opts.batchSize ?? TD_DEFAULT_BATCH_SIZE);
  const distillWeight = Math.max(0, Math.min(1, opts.distillWeight ?? TD_DEFAULT_DISTILL_WEIGHT));
  const reportEvery = Math.max(1, opts.logEvery ?? Math.min(100, Math.max(1, Math.floor(opts.games / 10))));
  const flushThreshold = Math.max(batchSize * 8, 256);

  let lossAccum = 0;
  let lossCount = 0;
  let winGames = 0;
  let winTurns = 0;
  let winLossSum = 0;
  let winLossCnt = 0;
  let p1Wins = 0;
  let p2Wins = 0;
  let p3Wins = 0;
  let draws = 0;

  let pairXs: Float32Array[] = [];
  let pairYs: Float32Array[] = [];

  for (let g = 0; g < opts.games; g++) {
    const ep = playFastTrainingEpisode(
      model.variant,
      baseSeed + g * 17,
      (state, actorId) => chooseAIAction(projectPlayerView(state, actorId)),
      true,
      450,
      distillWeight > 0
    );

    const progress = (g + 1) / opts.games;
    const lr = opts.learningRate * (1 - 0.5 * progress);
    // Warm-start first half pure Monte-Carlo outcome (lambda=1.0), second half mild TD (lambda=0.85)
    const lambda = progress < 0.5 ? 1.0 : 0.85;

    winGames += 1;
    winTurns += ep.turns;
    if (ep.winnerIds.length === 0) {
      draws += 1;
    } else if (model.variant === '2v2') {
      if (ep.winnerIds.some((id) => id === 'p1' || id === 'p3')) p1Wins += 1;
      else p2Wins += 1;
    } else {
      if (ep.winnerIds.includes('p1')) p1Wins += 1;
      else if (ep.winnerIds.includes('p2')) p2Wins += 1;
      else p3Wins += 1;
    }

    for (let idx = 0; idx < ep.trajectories.length; idx++) {
      const traj = ep.trajectories[idx];
      if (traj.length === 0) continue;
      const tdTargets = computeTDLambdaTargets(model, traj, ep.targets[idx], lambda, ws);
      const dTargets = ep.distillTargets?.[idx];
      for (let t = 0; t < traj.length; t++) {
        pairXs.push(traj[t]);
        pairYs.push(blendDistillationTarget(tdTargets[t], dTargets?.[t], distillWeight));
      }
    }
    model.warmstartGames += 1;

    const shouldFlush =
      pairXs.length >= flushThreshold ||
      g + 1 === opts.games ||
      (opts.logProgress !== undefined && (g + 1) % reportEvery === 0);

    if (shouldFlush && pairXs.length > 0) {
      shufflePairedArrays(pairXs, pairYs, baseSeed + g * 997);
      const res = trainTDPairsMiniBatch(model, pairXs, pairYs, batchSize, lr, ws, 3e-5);
      lossAccum += res.lossSum;
      lossCount += res.sampleCount;
      winLossSum += res.lossSum;
      winLossCnt += res.sampleCount;
      pairXs = [];
      pairYs = [];
    }

    if (opts.logProgress && ((g + 1) % reportEvery === 0 || g + 1 === opts.games)) {
      opts.logProgress(g + 1, opts.games, lossCount > 0 ? lossAccum / lossCount : 0, {
        windowGames: winGames,
        windowLoss: winLossCnt > 0 ? winLossSum / winLossCnt : 0,
        avgTurns: winGames > 0 ? winTurns / winGames : 0,
        p1Wins,
        p2Wins,
        p3Wins,
        draws,
        vsHeurGames: 0,
        vsHeurWins: 0,
        vsHeurLosses: 0,
        vsHeurDraws: 0,
      });
      winGames = 0;
      winTurns = 0;
      winLossSum = 0;
      winLossCnt = 0;
      p1Wins = 0;
      p2Wins = 0;
      p3Wins = 0;
      draws = 0;
    }
  }

  model.trainedAt = new Date().toISOString();
  return { avgLoss: lossCount > 0 ? lossAccum / lossCount : 0 };
}

export interface TDLambdaTrainOptions {
  games: number;
  lambda: number;
  learningRate: number;
  batchSize?: number;
  seed?: number;
  drawSamples?: number;
  dogmaSamples?: number;
  logEvery?: number;
  logProgress?: (done: number, total: number, avgLoss: number, stats?: WindowProgressStats) => void;
}

export function runTDLambdaSelfPlay(
  model: TDFunnelModel,
  opts: TDLambdaTrainOptions
): { avgLoss: number } {
  if (opts.games <= 0) return { avgLoss: 0 };
  const ws: TDTrainWorkspace = createTrainWorkspace(model);
  const featBuf = new Float32Array(TD_INPUT_SIZE);
  const baseSeed = opts.seed ?? 900000;
  const batchSize = Math.max(1, opts.batchSize ?? TD_DEFAULT_BATCH_SIZE);
  const reportEvery = Math.max(1, opts.logEvery ?? Math.min(100, Math.max(1, Math.floor(opts.games / 10))));
  const flushThreshold = Math.max(batchSize * 4, 128);

  let lossAccum = 0;
  let lossCount = 0;
  let winGames = 0;
  let winTurns = 0;
  let winLossSum = 0;
  let winLossCnt = 0;
  let p1Wins = 0;
  let p2Wins = 0;
  let p3Wins = 0;
  let draws = 0;
  let vsHeurGames = 0;
  let vsHeurWins = 0;
  let vsHeurLosses = 0;
  let vsHeurDraws = 0;

  let pairXs: Float32Array[] = [];
  let pairYs: Float32Array[] = [];

  for (let g = 0; g < opts.games; g++) {
    const progress = (g + 1) / opts.games;
    const lr = opts.learningRate * Math.max(0.15, 1 - 0.85 * progress);
    const epsilon = Math.max(0.01, 0.06 * (1 - progress));
    const temperature = Math.max(0.04, 0.25 * (1 - progress));
    const rng = makeSeededRng(baseSeed + g * 31 + 7);

    // Periodically pit against full-strength Heuristic AI (30% of games, alternating seats)
    const heuristicSeats = getMixedHeuristicSeatSet(model.variant, g);

    const ep = playFastTrainingEpisode(
      model.variant,
      baseSeed + g * 29,
      (state, actorId) => {
        const pv = projectPlayerView(state, actorId);
        if (heuristicSeats.has(actorId)) {
          return chooseAIAction(pv);
        }
        return chooseTDActionWithModel(pv, model, undefined, {
          drawSamples: opts.drawSamples ?? 4,
          dogmaSamples: opts.dogmaSamples ?? 2,
          enableOpponentReply: true,
          epsilon,
          temperature,
          rng,
          featureBuf: featBuf,
          workspace: ws,
        });
      },
      true
    );

    winGames += 1;
    winTurns += ep.turns;
    if (heuristicSeats.size > 0) {
      vsHeurGames += 1;
      if (ep.winnerIds.length === 0) {
        vsHeurDraws += 1;
      } else if (ep.winnerIds.some((id) => !heuristicSeats.has(id))) {
        vsHeurWins += 1;
      } else {
        vsHeurLosses += 1;
      }
    } else {
      if (ep.winnerIds.length === 0) {
        draws += 1;
      } else if (model.variant === '2v2') {
        if (ep.winnerIds.some((id) => id === 'p1' || id === 'p3')) p1Wins += 1;
        else p2Wins += 1;
      } else {
        if (ep.winnerIds.includes('p1')) p1Wins += 1;
        else if (ep.winnerIds.includes('p2')) p2Wins += 1;
        else p3Wins += 1;
      }
    }

    const seatPrefix = 'p';
    for (let idx = 0; idx < ep.trajectories.length; idx++) {
      const traj = ep.trajectories[idx];
      if (traj.length === 0) continue;
      if (heuristicSeats.has(`${seatPrefix}${idx + 1}`)) continue;
      const targets = computeTDLambdaTargets(model, traj, ep.targets[idx], opts.lambda, ws);
      for (let t = 0; t < traj.length; t++) {
        pairXs.push(traj[t]);
        pairYs.push(targets[t]);
      }
    }

    model.trainedGames += 1;

    const shouldFlush =
      pairXs.length >= flushThreshold ||
      g + 1 === opts.games ||
      (opts.logProgress !== undefined && (g + 1) % reportEvery === 0);

    if (shouldFlush && pairXs.length > 0) {
      shufflePairedArrays(pairXs, pairYs, baseSeed + g * 997);
      const res = trainTDPairsMiniBatch(model, pairXs, pairYs, batchSize, lr, ws, 3e-5);
      lossAccum += res.lossSum;
      lossCount += res.sampleCount;
      winLossSum += res.lossSum;
      winLossCnt += res.sampleCount;
      pairXs = [];
      pairYs = [];
    }

    if (opts.logProgress && ((g + 1) % reportEvery === 0 || g + 1 === opts.games)) {
      opts.logProgress(g + 1, opts.games, lossCount > 0 ? lossAccum / lossCount : 0, {
        windowGames: winGames,
        windowLoss: winLossCnt > 0 ? winLossSum / winLossCnt : 0,
        avgTurns: winGames > 0 ? winTurns / winGames : 0,
        p1Wins,
        p2Wins,
        p3Wins,
        draws,
        vsHeurGames,
        vsHeurWins,
        vsHeurLosses,
        vsHeurDraws,
      });
      winGames = 0;
      winTurns = 0;
      winLossSum = 0;
      winLossCnt = 0;
      p1Wins = 0;
      p2Wins = 0;
      p3Wins = 0;
      draws = 0;
      vsHeurGames = 0;
      vsHeurWins = 0;
      vsHeurLosses = 0;
      vsHeurDraws = 0;
    }
  }

  model.trainedAt = new Date().toISOString();
  return { avgLoss: lossCount > 0 ? lossAccum / lossCount : 0 };
}

export interface ArenaStats {
  games: number;
  tdWins: number;
  heuristicWins: number;
  draws: number;
  tdWinRate: number;
  ci95: number;
  avgTurns: number;
}

/**
 * Benchmarks TD model vs Heuristic AI using paired mirror seeds for low-variance comparison.
 */
export function evaluateTDVsHeuristicArena(
  model: TDFunnelModel,
  numGames = 40,
  seed = 555000
): ArenaStats {
  const ws = createTrainWorkspace(model);
  const featBuf = new Float32Array(TD_INPUT_SIZE);

  let tdWins = 0;
  let heuristicWins = 0;
  let draws = 0;
  let totalTurns = 0;

  for (let g = 0; g < numGames; g++) {
    const pairSeed = seed + Math.floor(g / 2) * 101;
    const swap = g % 2 === 1;

    const tdIds = new Set<string>();
    if (model.variant === '1v1') {
      tdIds.add(swap ? 'p2' : 'p1');
    } else if (model.variant === '1v1v1') {
      tdIds.add(swap ? 'p2' : 'p1');
    } else {
      // Team A = p1 + p3, Team B = p2 + p4
      if (swap) {
        tdIds.add('p2');
        tdIds.add('p4');
      } else {
        tdIds.add('p1');
        tdIds.add('p3');
      }
    }

    const ep = playFastTrainingEpisode(
      model.variant,
      pairSeed,
      (state, actorId) => {
        const pv = projectPlayerView(state, actorId);
        if (tdIds.has(actorId)) {
          return chooseTDActionWithModel(pv, model, undefined, {
            drawSamples: 6,
            dogmaSamples: 3,
            enableOpponentReply: true,
            featureBuf: featBuf,
            workspace: ws,
          });
        }
        return chooseAIAction(pv);
      },
      false
    );

    totalTurns += ep.turns;
    if (ep.winnerIds.length === 0) {
      draws += 1;
    } else if (ep.winnerIds.some((id) => tdIds.has(id))) {
      tdWins += 1;
    } else {
      heuristicWins += 1;
    }
  }

  const p = numGames > 0 ? (tdWins + 0.5 * draws) / numGames : 0.5;
  const ci95 = numGames > 0 ? 1.96 * Math.sqrt((p * (1 - p)) / numGames) : 0;
  model.benchmarkWinRate = Math.round(p * 1000) / 1000;

  return {
    games: numGames,
    tdWins,
    heuristicWins,
    draws,
    tdWinRate: p,
    ci95,
    avgTurns: numGames > 0 ? totalTurns / numGames : 0,
  };
}

export function trainVariantModel(args: {
  variant: GameVariant;
  activation?: TDActivation;
  warmstartGames: number;
  tdGames: number;
  lambda: number;
  warmstartAlpha: number;
  alpha: number;
  batchSize?: number;
  distillWeight?: number;
  evalGames: number;
  logEvery?: number;
  seed: number;
  existingModel?: TDFunnelModel;
  onLog?: (msg: string) => void;
}): { model: TDFunnelModel; arena?: ArenaStats } {
  const model =
    args.existingModel ??
    createRandomFunnelModel(args.variant, args.activation ?? 'tanh', args.seed);
  const batchSize = args.batchSize ?? TD_DEFAULT_BATCH_SIZE;
  const distillWeight = args.distillWeight ?? TD_DEFAULT_DISTILL_WEIGHT;

  if (args.warmstartGames > 0) {
    args.onLog?.(`[${args.variant}] Warm-starting on ${args.warmstartGames} full Heuristic games (batchSize=${batchSize}, distill=${distillWeight.toFixed(2)})...`);
    runWarmstartPretraining(model, {
      games: args.warmstartGames,
      learningRate: args.warmstartAlpha,
      batchSize,
      distillWeight,
      seed: args.seed,
      logEvery: args.logEvery,
      logProgress: (done, total, avgLoss, stats) => {
        const extra = stats
          ? ` | avgTurns=${stats.avgTurns.toFixed(1)} | P1=${stats.p1Wins} P2=${stats.p2Wins}${args.variant === '1v1v1' ? ` P3=${stats.p3Wins}` : ''} D=${stats.draws}`
          : '';
        args.onLog?.(`  [${args.variant}] warmstart ${done}/${total} | loss=${avgLoss.toFixed(4)}${extra}`);
      },
    });
  }

  if (args.tdGames > 0) {
    args.onLog?.(
      `[${args.variant}] Running ${args.tdGames} TD(lambda=${args.lambda}) self-play games (batchSize=${batchSize})...`
    );
    runTDLambdaSelfPlay(model, {
      games: args.tdGames,
      lambda: args.lambda,
      learningRate: args.alpha,
      batchSize,
      seed: args.seed + 500000,
      logEvery: args.logEvery,
      logProgress: (done, total, avgLoss, stats) => {
        let extra = '';
        if (stats) {
          extra = ` | avgTurns=${stats.avgTurns.toFixed(1)}`;
          if (stats.vsHeurGames > 0) {
            const pct = (((stats.vsHeurWins + 0.5 * stats.vsHeurDraws) / stats.vsHeurGames) * 100).toFixed(1);
            extra += ` | vsHeur ${stats.vsHeurWins}W-${stats.vsHeurLosses}L-${stats.vsHeurDraws}D (${pct}%)`;
          }
        }
        args.onLog?.(`  [${args.variant}] td-selfplay ${done}/${total} | loss=${avgLoss.toFixed(4)}${extra}`);
      },
    });
  }

  let arena: ArenaStats | undefined;
  if (args.evalGames > 0) {
    args.onLog?.(`[${args.variant}] Benchmarking ${args.evalGames} paired games vs Heuristic AI (post-serialization)...`);
    const serializedEvalModel = hydrateTDModel(serializeTDModel(model));
    arena = evaluateTDVsHeuristicArena(serializedEvalModel, args.evalGames, args.seed + 900000);
    model.benchmarkWinRate = serializedEvalModel.benchmarkWinRate;
    args.onLog?.(
      `[${args.variant}] Arena: TD ${arena.tdWins}W - ${arena.heuristicWins}L - ${arena.draws}D (${(arena.tdWinRate * 100).toFixed(1)}% ± ${(arena.ci95 * 100).toFixed(1)}%, avg ${arena.avgTurns.toFixed(1)} turns)`
    );
  }

  return { model, arena };
}

export function buildModelBundleFromMap(models: Partial<Record<GameVariant, TDFunnelModel>>): TDModelBundle {
  const variants: TDModelBundle['variants'] = {};
  for (const key of ['1v1', '1v1v1', '2v2'] as const) {
    const m = models[key];
    if (m) variants[key] = serializeTDModel(m);
  }
  return {
    schemaVersion: 1,
    featureVersion: TD_FEATURE_VERSION,
    variants,
  };
}
