import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  computeTDLambdaTargets,
  createRandomFunnelModel,
  createTrainWorkspace,
  hydrateTDModel,
  serializeTDModel,
  TD_DEFAULT_BATCH_SIZE,
  trainTDPairsMiniBatch,
  validateTDModelBundle,
  type TDActivation,
  type TDFunnelModel,
} from '../src/engine/tdNetwork';
import {
  blendDistillationTarget,
  buildModelBundleFromMap,
  evaluateTDVsHeuristicArena,
  TD_DEFAULT_DISTILL_WEIGHT,
  trainVariantModel,
  type ArenaStats,
  type WindowProgressStats,
} from '../src/engine/tdTrainer';
import type { GameVariant } from '../src/engine/types';
import type { SerializedModelPayload, WorkerJobRequest, WorkerJobResponse } from './td-worker';

function getDefaultOutPathForVariant(variant: GameVariant): string {
  return `src/data/tdWeights.${variant}.json`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins < 60) return `${mins}m${String(secs).padStart(2, '0')}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h${String(remMins).padStart(2, '0')}m`;
}

function formatSeatBreakdown(
  variant: GameVariant,
  p1: number,
  p2: number,
  p3: number,
  draws: number
): string {
  if (variant === '2v2') {
    return `TeamA=${p1} TeamB=${p2} D=${draws}`;
  }
  if (variant === '1v1v1') {
    return `P1=${p1} P2=${p2} P3=${p3} D=${draws}`;
  }
  return `P1=${p1} P2=${p2} D=${draws}`;
}

function formatWindowSummary(
  variant: GameVariant,
  phase: 'warmstart' | 'td-selfplay',
  done: number,
  total: number,
  avgLoss: number,
  stats: WindowProgressStats,
  elapsedSec: number
): string {
  const rate = elapsedSec > 0 ? done / elapsedSec : 0;
  const etaSec = rate > 0 ? (total - done) / rate : 0;
  const parts = [
    `[${variant}] ${phase} ${done}/${total}`,
    `loss=${avgLoss.toFixed(4)} (win=${stats.windowLoss.toFixed(4)})`,
    `avgTurns=${stats.avgTurns.toFixed(1)}`,
  ];

  if (phase === 'td-selfplay') {
    if (stats.vsHeurGames > 0) {
      const heurRate = ((stats.vsHeurWins + 0.5 * stats.vsHeurDraws) / stats.vsHeurGames) * 100;
      parts.push(
        `vsHeur ${stats.vsHeurWins}W-${stats.vsHeurLosses}L-${stats.vsHeurDraws}D (${heurRate.toFixed(1)}%)`
      );
    }
    const selfGames = stats.windowGames - stats.vsHeurGames;
    if (selfGames > 0) {
      parts.push(`self(${formatSeatBreakdown(variant, stats.p1Wins, stats.p2Wins, stats.p3Wins, stats.draws)})`);
    }
  } else {
    parts.push(formatSeatBreakdown(variant, stats.p1Wins, stats.p2Wins, stats.p3Wins, stats.draws));
  }

  parts.push(formatDuration(elapsedSec));
  if (done < total) {
    parts.push(`ETA ${formatDuration(etaSec)}`);
  }
  return parts.join(' | ');
}

function createLogger(logFileArg: string | undefined) {
  const disabled = logFileArg === 'none' || logFileArg === 'false';
  const logPath = disabled ? null : path.resolve(logFileArg ?? 'src/data/tdTraining.log');
  if (logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  }
  return (msg: string) => {
    console.log(msg);
    if (logPath) {
      const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
      fs.appendFileSync(logPath, `[${ts}] ${msg}\n`, 'utf-8');
    }
  };
}

function parseArgs(argv: string[]) {
  const getVal = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];
    return undefined;
  };
  const hasFlag = (flag: string) => argv.includes(flag);

  const variantRaw = getVal('--variant') ?? 'all';
  const variants: GameVariant[] =
    variantRaw === 'all'
      ? ['1v1', '1v1v1', '2v2']
      : variantRaw === '1v1' || variantRaw === '1v1v1' || variantRaw === '2v2'
      ? [variantRaw]
      : (() => {
          throw new Error(`Invalid --variant "${variantRaw}". Use 1v1, 1v1v1, 2v2, or all.`);
        })();

  const activationRaw = getVal('--activation') ?? 'tanh';
  if (activationRaw !== 'tanh' && activationRaw !== 'leaky_relu') {
    throw new Error(`Invalid --activation "${activationRaw}". Use tanh or leaky_relu.`);
  }

  const defaultWorkers = Math.min(4, Math.max(1, os.cpus().length));
  const workers = Math.max(1, Number(getVal('--workers') ?? defaultWorkers));
  const logEvery = Math.max(1, Number(getVal('--log-every') ?? 100));

  return {
    variants,
    activation: activationRaw as TDActivation,
    warmstartGames: Number(getVal('--warmstart-games') ?? 5000),
    tdGames: Number(getVal('--games') ?? 2000),
    lambda: Number(getVal('--lambda') ?? 0.7),
    alpha: Number(getVal('--alpha') ?? 0.0003),
    warmstartAlpha: Number(getVal('--warmstart-alpha') ?? 0.0008),
    batchSize: Math.max(1, Number(getVal('--batch-size') ?? TD_DEFAULT_BATCH_SIZE)),
    distillWeight: Math.max(0, Math.min(1, Number(getVal('--distill') ?? TD_DEFAULT_DISTILL_WEIGHT))),
    evalGames: Number(getVal('--eval-games') ?? 40),
    seed: Number(getVal('--seed') ?? 202611),
    outPath: getVal('--out'),
    resumePath: getVal('--resume'),
    evalOnly: hasFlag('--eval-only'),
    logEvery,
    logFile: getVal('--log-file'),
    workers,
  };
}

function serializeModelForWorker(model: TDFunnelModel): SerializedModelPayload {
  return {
    variant: model.variant,
    activation: model.activation,
    inputSize: model.inputSize,
    hidden1Size: model.hidden1Size,
    hidden2Size: model.hidden2Size,
    outputSize: model.outputSize,
    warmstartGames: model.warmstartGames,
    trainedGames: model.trainedGames,
    trainedAt: model.trainedAt,
    w1: model.w1,
    b1: model.b1,
    w2: model.w2,
    b2: model.b2,
    w3: model.w3,
    b3: model.b3,
  };
}

type WorkerJobInput = WorkerJobRequest extends infer R
  ? R extends WorkerJobRequest
    ? Omit<R, 'id'>
    : never
  : never;

class WorkerPool {
  private workers: Worker[] = [];
  private nextId = 1;
  private inflight = new Map<
    number,
    { resolve: (r: WorkerJobResponse) => void; reject: (e: unknown) => void }
  >();

  constructor(size: number) {
    const workerUrl = new URL('./td-worker.ts', import.meta.url);
    const execArgv = process.execArgv.filter((a) => !a.startsWith('--eval'));
    for (let i = 0; i < size; i++) {
      const w = new Worker(workerUrl, { execArgv });
      w.on('message', (msg: WorkerJobResponse) => {
        const entry = this.inflight.get(msg.id);
        if (entry) {
          this.inflight.delete(msg.id);
          entry.resolve(msg);
        }
      });
      w.on('error', (err) => {
        console.error('Worker error:', err);
      });
      this.workers.push(w);
    }
  }

  run(workerIndex: number, reqWithoutId: WorkerJobInput): Promise<WorkerJobResponse> {
    const id = this.nextId++;
    const req = { ...reqWithoutId, id } as WorkerJobRequest;
    return new Promise((resolve, reject) => {
      this.inflight.set(id, { resolve, reject });
      this.workers[workerIndex % this.workers.length].postMessage(req);
    });
  }

  async close() {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}

function recordSeatWinner(
  variant: GameVariant,
  winnerIds: string[],
  counters: { p1: number; p2: number; p3: number; draws: number }
) {
  if (winnerIds.length === 0) {
    counters.draws += 1;
  } else if (variant === '2v2') {
    if (winnerIds.some((id) => id === 'p1' || id === 'p3')) counters.p1 += 1;
    else counters.p2 += 1;
  } else {
    if (winnerIds.includes('p1')) counters.p1 += 1;
    else if (winnerIds.includes('p2')) counters.p2 += 1;
    else counters.p3 += 1;
  }
}

async function trainVariantParallel(
  pool: WorkerPool,
  numWorkers: number,
  args: {
    variant: GameVariant;
    activation: TDActivation;
    warmstartGames: number;
    tdGames: number;
    lambda: number;
    warmstartAlpha: number;
    alpha: number;
    batchSize: number;
    distillWeight: number;
    evalGames: number;
    logEvery: number;
    seed: number;
    existingModel?: TDFunnelModel;
  },
  log: (msg: string) => void
): Promise<{ model: TDFunnelModel; arena?: ArenaStats }> {
  const model =
    args.existingModel ??
    createRandomFunnelModel(args.variant, args.activation, args.seed);
  const ws = createTrainWorkspace(model);

  if (args.warmstartGames > 0) {
    log(
      `[${args.variant}] Warm-starting on ${args.warmstartGames} full Heuristic games (${numWorkers} workers, batchSize=${args.batchSize}, distill=${args.distillWeight.toFixed(2)}, log every ${Math.min(args.logEvery, args.warmstartGames)})...`
    );
    const tPhase = Date.now();
    const workerChunkGames = Math.max(numWorkers * 8, 32);
    const reportEvery = Math.min(args.logEvery, args.warmstartGames);
    let done = 0;
    let lossAccum = 0;
    let lossCount = 0;
    let nextReport = reportEvery;

    let winGames = 0;
    let winTurns = 0;
    let winLossSum = 0;
    let winLossCnt = 0;
    const seatWins = { p1: 0, p2: 0, p3: 0, draws: 0 };

    while (done < args.warmstartGames) {
      const count = Math.min(workerChunkGames, args.warmstartGames - done);
      const chunks: number[][] = Array.from({ length: numWorkers }, () => []);
      for (let i = 0; i < count; i++) {
        chunks[i % numWorkers].push(args.seed + (done + i) * 17);
      }

      const promises = chunks
        .map((seeds, wIdx) =>
          seeds.length > 0
            ? pool.run(wIdx, {
                mode: 'warmstart',
                variant: args.variant,
                seeds,
                recordDistill: args.distillWeight > 0,
              })
            : null
        )
        .filter((p): p is Promise<WorkerJobResponse> => p !== null);

      const pairXs: Float32Array[] = [];
      const pairYs: Float32Array[] = [];
      const progressMid = Math.min(1, (done + count * 0.5) / args.warmstartGames);
      const lr = args.warmstartAlpha * (1 - 0.5 * progressMid);
      const lambda = progressMid < 0.5 ? 1.0 : 0.85;

      const responses = await Promise.all(promises);
      for (const resp of responses) {
        if (resp.mode !== 'warmstart') continue;
        for (const ep of resp.episodes) {
          done += 1;
          winGames += 1;
          winTurns += ep.turns;
          recordSeatWinner(args.variant, ep.winnerIds, seatWins);
          for (let idx = 0; idx < ep.trajectories.length; idx++) {
            const traj = ep.trajectories[idx];
            if (traj.length === 0) continue;
            const targets = computeTDLambdaTargets(model, traj, ep.targets[idx], lambda, ws);
            const dTargets = ep.distillTargets?.[idx];
            for (let t = 0; t < traj.length; t++) {
              pairXs.push(traj[t]);
              pairYs.push(blendDistillationTarget(targets[t], dTargets?.[t], args.distillWeight));
            }
          }
          model.warmstartGames += 1;
        }
      }

      // Deterministic Fisher-Yates shuffle across batch pairs to stabilize mini-batch Adam
      let rng = (args.seed + done * 997) >>> 0 || 1;
      for (let i = pairXs.length - 1; i > 0; i--) {
        rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
        const j = rng % (i + 1);
        const tmpX = pairXs[i];
        pairXs[i] = pairXs[j];
        pairXs[j] = tmpX;
        const tmpY = pairYs[i];
        pairYs[i] = pairYs[j];
        pairYs[j] = tmpY;
      }
      const res = trainTDPairsMiniBatch(model, pairXs, pairYs, args.batchSize, lr, ws, 3e-5);
      lossAccum += res.lossSum;
      lossCount += res.sampleCount;
      winLossSum += res.lossSum;
      winLossCnt += res.sampleCount;

      if (done >= nextReport || done === args.warmstartGames) {
        const elapsedSec = (Date.now() - tPhase) / 1000;
        log(
          formatWindowSummary(
            args.variant,
            'warmstart',
            done,
            args.warmstartGames,
            lossCount > 0 ? lossAccum / lossCount : 0,
            {
              windowGames: winGames,
              windowLoss: winLossCnt > 0 ? winLossSum / winLossCnt : 0,
              avgTurns: winGames > 0 ? winTurns / winGames : 0,
              p1Wins: seatWins.p1,
              p2Wins: seatWins.p2,
              p3Wins: seatWins.p3,
              draws: seatWins.draws,
              vsHeurGames: 0,
              vsHeurWins: 0,
              vsHeurLosses: 0,
              vsHeurDraws: 0,
            },
            elapsedSec
          )
        );
        winGames = 0;
        winTurns = 0;
        winLossSum = 0;
        winLossCnt = 0;
        seatWins.p1 = 0;
        seatWins.p2 = 0;
        seatWins.p3 = 0;
        seatWins.draws = 0;
        while (nextReport <= done) nextReport += reportEvery;
      }
    }
  }

  if (args.tdGames > 0) {
    log(
      `[${args.variant}] Running ${args.tdGames} TD(lambda=${args.lambda}) self-play games (${numWorkers} workers, batchSize=${args.batchSize}, log every ${Math.min(args.logEvery, args.tdGames)})...`
    );
    const tPhase = Date.now();
    const workerChunkGames = Math.max(numWorkers * 4, 16);
    const reportEvery = Math.min(args.logEvery, args.tdGames);
    let done = 0;
    let lossAccum = 0;
    let lossCount = 0;
    let nextReport = reportEvery;
    const baseSeed = args.seed + 500000;

    let winGames = 0;
    let winTurns = 0;
    let winLossSum = 0;
    let winLossCnt = 0;
    const seatWins = { p1: 0, p2: 0, p3: 0, draws: 0 };
    let vsHeurGames = 0;
    let vsHeurWins = 0;
    let vsHeurLosses = 0;
    let vsHeurDraws = 0;

    while (done < args.tdGames) {
      const count = Math.min(workerChunkGames, args.tdGames - done);
      const progressMid = (done + count * 0.5) / args.tdGames;
      const lr = args.alpha * Math.max(0.15, 1 - 0.85 * progressMid);
      const epsilon = Math.max(0.01, 0.06 * (1 - progressMid));
      const temperature = Math.max(0.04, 0.25 * (1 - progressMid));
      const payload = serializeModelForWorker(model);

      const seedChunks: number[][] = Array.from({ length: numWorkers }, () => []);
      const idxChunks: number[][] = Array.from({ length: numWorkers }, () => []);
      for (let i = 0; i < count; i++) {
        const gIdx = done + i;
        seedChunks[i % numWorkers].push(baseSeed + gIdx * 29);
        idxChunks[i % numWorkers].push(gIdx);
      }

      const promises = seedChunks
        .map((seeds, wIdx) =>
          seeds.length > 0
            ? pool.run(wIdx, {
                mode: 'td',
                variant: args.variant,
                seeds,
                gameIndices: idxChunks[wIdx],
                epsilon,
                temperature,
                drawSamples: 4,
                dogmaSamples: 2,
                model: payload,
              })
            : null
        )
        .filter((p): p is Promise<WorkerJobResponse> => p !== null);

      const pairXs: Float32Array[] = [];
      const pairYs: Float32Array[] = [];
      const responses = await Promise.all(promises);
      for (const resp of responses) {
        if (resp.mode !== 'td') continue;
        for (const ep of resp.episodes) {
          done += 1;
          winGames += 1;
          winTurns += ep.turns;
          const heuristicSeats = new Set(ep.heuristicSeatIds ?? []);
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
            recordSeatWinner(args.variant, ep.winnerIds, seatWins);
          }

          for (let idx = 0; idx < ep.trajectories.length; idx++) {
            const traj = ep.trajectories[idx];
            if (traj.length === 0) continue;
            if (heuristicSeats.has(`p${idx + 1}`)) continue;
            const targets = computeTDLambdaTargets(model, traj, ep.targets[idx], args.lambda, ws);
            for (let t = 0; t < traj.length; t++) {
              pairXs.push(traj[t]);
              pairYs.push(targets[t]);
            }
          }
          model.trainedGames += 1;
        }
      }

      let rng = (baseSeed + done * 997) >>> 0 || 1;
      for (let i = pairXs.length - 1; i > 0; i--) {
        rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
        const j = rng % (i + 1);
        const tmpX = pairXs[i];
        pairXs[i] = pairXs[j];
        pairXs[j] = tmpX;
        const tmpY = pairYs[i];
        pairYs[i] = pairYs[j];
        pairYs[j] = tmpY;
      }
      const res = trainTDPairsMiniBatch(model, pairXs, pairYs, args.batchSize, lr, ws, 3e-5);
      lossAccum += res.lossSum;
      lossCount += res.sampleCount;
      winLossSum += res.lossSum;
      winLossCnt += res.sampleCount;

      if (done >= nextReport || done === args.tdGames) {
        const elapsedSec = (Date.now() - tPhase) / 1000;
        log(
          formatWindowSummary(
            args.variant,
            'td-selfplay',
            done,
            args.tdGames,
            lossCount > 0 ? lossAccum / lossCount : 0,
            {
              windowGames: winGames,
              windowLoss: winLossCnt > 0 ? winLossSum / winLossCnt : 0,
              avgTurns: winGames > 0 ? winTurns / winGames : 0,
              p1Wins: seatWins.p1,
              p2Wins: seatWins.p2,
              p3Wins: seatWins.p3,
              draws: seatWins.draws,
              vsHeurGames,
              vsHeurWins,
              vsHeurLosses,
              vsHeurDraws,
            },
            elapsedSec
          )
        );
        winGames = 0;
        winTurns = 0;
        winLossSum = 0;
        winLossCnt = 0;
        seatWins.p1 = 0;
        seatWins.p2 = 0;
        seatWins.p3 = 0;
        seatWins.draws = 0;
        vsHeurGames = 0;
        vsHeurWins = 0;
        vsHeurLosses = 0;
        vsHeurDraws = 0;
        while (nextReport <= done) nextReport += reportEvery;
      }
    }
  }

  model.trainedAt = new Date().toISOString();

  let arena: ArenaStats | undefined;
  if (args.evalGames > 0) {
    log(
      `[${args.variant}] Benchmarking ${args.evalGames} paired games vs Heuristic AI (post-serialization, ${numWorkers} workers)...`
    );
    const serializedEvalModel = hydrateTDModel(serializeTDModel(model));
    arena = await evaluateParallel(
      pool,
      numWorkers,
      serializedEvalModel,
      args.evalGames,
      args.seed + 900000,
      args.logEvery,
      log
    );
    model.benchmarkWinRate = serializedEvalModel.benchmarkWinRate;
    log(
      `[${args.variant}] Arena: TD ${arena.tdWins}W - ${arena.heuristicWins}L - ${arena.draws}D (${(arena.tdWinRate * 100).toFixed(1)}% ± ${(arena.ci95 * 100).toFixed(1)}%, avg ${arena.avgTurns.toFixed(1)} turns)`
    );
  }

  return { model, arena };
}

async function evaluateParallel(
  pool: WorkerPool,
  numWorkers: number,
  model: TDFunnelModel,
  numGames: number,
  seedBase: number,
  logEvery: number,
  log: (msg: string) => void
): Promise<ArenaStats> {
  const payload = serializeModelForWorker(model);
  const chunkStep = Math.max(numWorkers * 4, Math.min(numGames, logEvery));
  const tEval = Date.now();

  let done = 0;
  let tdWins = 0;
  let heuristicWins = 0;
  let draws = 0;
  let totalTurns = 0;

  while (done < numGames) {
    const count = Math.min(chunkStep, numGames - done);
    const chunks: number[][] = Array.from({ length: numWorkers }, () => []);
    for (let i = 0; i < count; i++) {
      chunks[i % numWorkers].push(done + i);
    }

    const responses = await Promise.all(
      chunks
        .map((gameIndices, wIdx) =>
          gameIndices.length > 0
            ? pool.run(wIdx, {
                mode: 'eval',
                variant: model.variant,
                gameIndices,
                seedBase,
                model: payload,
              })
            : null
        )
        .filter((p): p is Promise<WorkerJobResponse> => p !== null)
    );

    let sliceW = 0;
    let sliceL = 0;
    let sliceD = 0;
    let sliceTurns = 0;
    for (const r of responses) {
      if (r.mode !== 'eval') continue;
      sliceW += r.tdWins;
      sliceL += r.heuristicWins;
      sliceD += r.draws;
      sliceTurns += r.totalTurns;
    }

    done += count;
    tdWins += sliceW;
    heuristicWins += sliceL;
    draws += sliceD;
    totalTurns += sliceTurns;

    if (numGames > logEvery && done < numGames) {
      const cumRate = ((tdWins + 0.5 * draws) / done) * 100;
      const elapsedSec = (Date.now() - tEval) / 1000;
      const rate = elapsedSec > 0 ? done / elapsedSec : 0;
      const eta = rate > 0 ? (numGames - done) / rate : 0;
      log(
        `[${model.variant}] eval ${done}/${numGames} | cum TD ${tdWins}W-${heuristicWins}L-${draws}D (${cumRate.toFixed(1)}%) | avgTurns=${(totalTurns / done).toFixed(1)} | ${formatDuration(elapsedSec)} | ETA ${formatDuration(eta)}`
      );
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

function loadExistingModels(
  variants: GameVariant[],
  resumePath: string | undefined,
  customOutPath: string | undefined,
  log: (msg: string) => void
): Partial<Record<GameVariant, TDFunnelModel>> {
  const models: Partial<Record<GameVariant, TDFunnelModel>> = {};

  const tryReadFile = (filePath: string, requireValid: boolean) => {
    if (!fs.existsSync(filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const checked = validateTDModelBundle(raw);
      if (!checked.valid || !checked.bundle) {
        if (requireValid) {
          throw new Error(`Invalid resume weights file (${filePath}): ${checked.error}`);
        }
        return;
      }
      for (const [k, v] of Object.entries(checked.bundle.variants)) {
        if (v) models[k as GameVariant] = hydrateTDModel(v);
      }
      log(`Loaded existing weights from ${filePath}`);
    } catch (err) {
      if (requireValid) throw err;
    }
  };

  if (resumePath) {
    tryReadFile(resumePath, true);
    return models;
  }

  if (customOutPath) {
    tryReadFile(customOutPath, false);
    return models;
  }

  for (const variant of variants) {
    tryReadFile(getDefaultOutPathForVariant(variant), false);
  }
  return models;
}

function saveVariantOutput(
  variant: GameVariant,
  models: Partial<Record<GameVariant, TDFunnelModel>>,
  customOutPath: string | undefined,
  log: (msg: string) => void
) {
  const targetPath = customOutPath ?? getDefaultOutPathForVariant(variant);
  const bundle = customOutPath
    ? buildModelBundleFromMap(models)
    : buildModelBundleFromMap({ [variant]: models[variant] });
  const outAbs = path.resolve(targetPath);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  const serialized = JSON.stringify(bundle);
  fs.writeFileSync(outAbs, serialized, 'utf-8');
  log(
    `Saved ${variant} TD weights to ${targetPath} (${(Buffer.byteLength(serialized) / 1024).toFixed(1)} KB)`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = createLogger(args.logFile);
  const models = loadExistingModels(args.variants, args.resumePath, args.outPath, log);

  const pool = args.workers > 1 ? new WorkerPool(args.workers) : null;

  try {
    for (let i = 0; i < args.variants.length; i++) {
      const variant = args.variants[i];
      const t0 = Date.now();
      if (args.evalOnly) {
        const m = models[variant];
        if (!m) {
          log(`[${variant}] No weights found to evaluate.`);
          continue;
        }
        const stats = pool
          ? await evaluateParallel(
              pool,
              args.workers,
              m,
              args.evalGames,
              args.seed + i * 1000,
              args.logEvery,
              log
            )
          : evaluateTDVsHeuristicArena(m, args.evalGames, args.seed + i * 1000);
        log(
          `[${variant}] Arena: TD ${stats.tdWins}W - ${stats.heuristicWins}L - ${stats.draws}D (${(stats.tdWinRate * 100).toFixed(1)}% ± ${(stats.ci95 * 100).toFixed(1)}%, avg ${stats.avgTurns.toFixed(1)} turns)`
        );
        continue;
      }

      if (pool) {
        const { model } = await trainVariantParallel(
          pool,
          args.workers,
          {
            variant,
            activation: args.activation,
            warmstartGames: args.warmstartGames,
            tdGames: args.tdGames,
            lambda: args.lambda,
            warmstartAlpha: args.warmstartAlpha,
            alpha: args.alpha,
            batchSize: args.batchSize,
            distillWeight: args.distillWeight,
            evalGames: args.evalGames,
            logEvery: args.logEvery,
            seed: args.seed + i * 10000,
            existingModel: models[variant],
          },
          log
        );
        models[variant] = model;
      } else {
        const tWarm = Date.now();
        const { model } = trainVariantModel({
          variant,
          activation: args.activation,
          warmstartGames: args.warmstartGames,
          tdGames: args.tdGames,
          lambda: args.lambda,
          warmstartAlpha: args.warmstartAlpha,
          alpha: args.alpha,
          batchSize: args.batchSize,
          distillWeight: args.distillWeight,
          evalGames: args.evalGames,
          logEvery: args.logEvery,
          seed: args.seed + i * 10000,
          existingModel: models[variant],
          onLog: (msg) => log(`[${formatDuration((Date.now() - tWarm) / 1000)}] ${msg}`),
        });
        models[variant] = model;
      }

      saveVariantOutput(variant, models, args.outPath, log);
      const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
      log(`[${variant}] Completed in ${elapsedSec}s`);
    }
  } finally {
    if (pool) {
      await pool.close();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
