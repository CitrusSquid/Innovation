import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  hydrateTDModel,
  serializeTDModel,
  validateTDModelBundle,
  type TDVariantWeights,
} from '../src/engine/tdNetwork';
import {
  formatVictoryDetailLabel,
  runHeadlessBenchmarkMatch,
  type BenchmarkMatchResult,
} from '../src/engine/tdBenchmark';
import {
  getAIDifficultyProfile,
  getActiveTDModel,
  hasTrainedTDWeights,
  type CanonicalAIBackend,
} from '../src/engine/tdWeights';
import type { GameVariant } from '../src/engine/types';
import type { BenchWorkerResponse, BenchWorkerTask } from './bench-worker';

export interface ContestantSpec {
  id: string;
  label: string;
  backend: CanonicalAIBackend;
  weightsPath?: string;
}

export interface CompareJobConfig {
  mode: 'matchup' | 'gauntlet' | 'round-robin';
  variant: GameVariant;
  games: number;
  seed: number;
  workers: number;
  contestants: ContestantSpec[];
}

export interface MatchupComparisonResult {
  idA: string;
  labelA: string;
  idB: string;
  labelB: string;
  idC?: string;
  labelC?: string;
  games: number;
  winsA: number;
  winsB: number;
  winsC: number;
  draws: number;
  winRateA: number;
  ci95A: number;
  avgTurns: number;
  reasons: Record<string, number>;
}

export interface LeaderboardEntry {
  id: string;
  label: string;
  wins: number;
  losses: number;
  draws: number;
  games: number;
  winRate: number;
  ci95: number;
  avgTurns: number;
}

export interface CompareJobOutput {
  mode: CompareJobConfig['mode'];
  variant: GameVariant;
  gamesPerPair: number;
  totalGames: number;
  seed: number;
  matchups: MatchupComparisonResult[];
  leaderboard: LeaderboardEntry[];
  matrix: Array<{ rowId: string; colId: string; winRate: number | null }>;
  reasons: Record<string, number>;
}

function loadWeightsForContestant(
  variant: GameVariant,
  c: ContestantSpec
): TDVariantWeights | undefined {
  const profile = getAIDifficultyProfile(c.backend);
  if (!profile.isTD) return undefined;

  if (c.weightsPath) {
    const abs = path.resolve(c.weightsPath);
    if (!fs.existsSync(abs)) {
      throw new Error(`Weights file not found for "${c.label}": ${abs}`);
    }
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf-8'));
    const checked = validateTDModelBundle(parsed);
    if (!checked.valid || !checked.bundle) {
      throw new Error(`Invalid weights bundle for "${c.label}": ${checked.error}`);
    }
    const vw = checked.bundle.variants[variant];
    if (!vw) {
      throw new Error(`Model "${c.label}" does not contain weights for variant "${variant}".`);
    }
    return vw;
  }

  if (hasTrainedTDWeights(variant)) {
    return serializeTDModel(getActiveTDModel(variant));
  }
  return undefined;
}

class CompareWorkerPool {
  private workers: Worker[] = [];
  private nextId = 1;
  private inflight = new Map<
    number,
    { resolve: (r: BenchWorkerResponse) => void; reject: (err: unknown) => void }
  >();

  constructor(size: number) {
    const workerUrl = new URL('./bench-worker.ts', import.meta.url);
    const execArgv = process.execArgv.filter((a) => !a.startsWith('--eval'));
    for (let i = 0; i < size; i++) {
      const w = new Worker(workerUrl, { execArgv });
      w.on('message', (msg: BenchWorkerResponse) => {
        const cb = this.inflight.get(msg.id);
        if (cb) {
          this.inflight.delete(msg.id);
          cb.resolve(msg);
        }
      });
      w.on('error', (err) => {
        for (const cb of this.inflight.values()) cb.reject(err);
        this.inflight.clear();
      });
      this.workers.push(w);
    }
  }

  run(workerIndex: number, req: Omit<BenchWorkerTask, 'id'>): Promise<BenchWorkerResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.inflight.set(id, { resolve, reject });
      this.workers[workerIndex % this.workers.length].postMessage({ ...req, id });
    });
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}

interface ScheduledMatch {
  matchIndex: number;
  seed: number;
  playerNames: string[];
  playerAIBackends: CanonicalAIBackend[];
  seatContestantIds: string[];
  modelWeightsBySeat: Array<TDVariantWeights | undefined>;
}

function buildSchedule(
  variant: GameVariant,
  games: number,
  seedBase: number,
  cA: ContestantSpec,
  cB: ContestantSpec,
  cC: ContestantSpec | undefined,
  weightsMap: Map<string, TDVariantWeights | undefined>
): ScheduledMatch[] {
  const out: ScheduledMatch[] = [];
  const wA = weightsMap.get(cA.id);
  const wB = weightsMap.get(cB.id);
  const wC = cC ? weightsMap.get(cC.id) : undefined;

  for (let idx = 0; idx < games; idx++) {
    const pairIdx = Math.floor(idx / 2);
    const pairSeed = seedBase + pairIdx * 131 + (variant === '1v1v1' ? idx % 3 : 0);

    if (variant === '1v1') {
      const aFirst = idx % 2 === 0;
      const order = aFirst ? [cA, cB] : [cB, cA];
      const wOrder = aFirst ? [wA, wB] : [wB, wA];
      out.push({
        matchIndex: idx + 1,
        seed: pairSeed,
        playerNames: order.map((c, s) => `${c.label} [S${s + 1}]`),
        playerAIBackends: order.map((c) => c.backend),
        seatContestantIds: order.map((c) => c.id),
        modelWeightsBySeat: wOrder,
      });
    } else if (variant === '2v2') {
      const aFirst = idx % 2 === 0;
      const order = aFirst ? [cA, cB, cA, cB] : [cB, cA, cB, cA];
      const wOrder = aFirst ? [wA, wB, wA, wB] : [wB, wA, wB, wA];
      out.push({
        matchIndex: idx + 1,
        seed: pairSeed,
        playerNames: order.map((c, s) => `${c.label} [S${s + 1}]`),
        playerAIBackends: order.map((c) => c.backend),
        seatContestantIds: order.map((c) => c.id),
        modelWeightsBySeat: wOrder,
      });
    } else {
      const third = cC ?? cB;
      const wThird = cC ? wC : wB;
      const rot = idx % 3;
      const order =
        rot === 0 ? [cA, cB, third] : rot === 1 ? [cB, third, cA] : [third, cA, cB];
      const wOrder =
        rot === 0 ? [wA, wB, wThird] : rot === 1 ? [wB, wThird, wA] : [wThird, wA, wB];
      out.push({
        matchIndex: idx + 1,
        seed: seedBase + Math.floor(idx / 3) * 131,
        playerNames: order.map((c, s) => `${c.label} [S${s + 1}]`),
        playerAIBackends: order.map((c) => c.backend),
        seatContestantIds: order.map((c) => c.id),
        modelWeightsBySeat: wOrder,
      });
    }
  }
  return out;
}

async function runPairwise(
  pool: CompareWorkerPool | null,
  workers: number,
  variant: GameVariant,
  games: number,
  seedBase: number,
  cA: ContestantSpec,
  cB: ContestantSpec,
  cC: ContestantSpec | undefined,
  weightsMap: Map<string, TDVariantWeights | undefined>,
  onGameDone: (doneCount: number) => void
): Promise<MatchupComparisonResult> {
  const scheduled = buildSchedule(variant, games, seedBase, cA, cB, cC, weightsMap);
  const byMatchIdx = new Map(scheduled.map((s) => [s.matchIndex, s]));

  let winsA = 0;
  let winsB = 0;
  let winsC = 0;
  let draws = 0;
  let totalTurns = 0;
  let completed = 0;
  const reasons: Record<string, number> = {};

  const recordResult = (res: BenchmarkMatchResult) => {
    completed += 1;
    totalTurns += res.turns;
    const reasonLabel = formatVictoryDetailLabel(res.reason, res.summary);
    reasons[reasonLabel] = (reasons[reasonLabel] ?? 0) + 1;

    const sched = byMatchIdx.get(res.matchIndex)!;
    const winnerTeamIds = new Set<string>();
    res.players.forEach((p, seatIdx) => {
      if (p.isWinner) {
        winnerTeamIds.add(sched.seatContestantIds[seatIdx]);
      }
    });

    if (winnerTeamIds.size === 0) {
      draws += 1;
    } else if (winnerTeamIds.has(cA.id)) {
      winsA += 1;
    } else if (winnerTeamIds.has(cB.id)) {
      winsB += 1;
    } else if (cC && winnerTeamIds.has(cC.id)) {
      winsC += 1;
    } else {
      winsB += 1;
    }
    onGameDone(1);
  };

  if (pool && workers > 1) {
    const chunkSize = Math.max(1, Math.ceil(scheduled.length / (workers * 2)));
    const chunks: ScheduledMatch[][] = [];
    for (let i = 0; i < scheduled.length; i += chunkSize) {
      chunks.push(scheduled.slice(i, i + chunkSize));
    }
    let nextChunk = 0;
    await Promise.all(
      Array.from({ length: Math.min(workers, chunks.length) }, async (_, wIdx) => {
        while (nextChunk < chunks.length) {
          const myChunk = chunks[nextChunk++];
          const resp = await pool.run(wIdx, {
            variant,
            matches: myChunk.map((m) => ({
              matchIndex: m.matchIndex,
              seed: m.seed,
              playerNames: m.playerNames,
              playerAIBackends: m.playerAIBackends,
              modelWeightsBySeat: m.modelWeightsBySeat,
            })),
          });
          for (const res of resp.results) {
            recordResult(res);
          }
        }
      })
    );
  } else {
    for (const m of scheduled) {
      const res = runHeadlessBenchmarkMatch({
        matchIndex: m.matchIndex,
        variant,
        playerNames: m.playerNames,
        playerAIBackends: m.playerAIBackends,
        seed: m.seed,
        modelOverridesBySeat: m.modelWeightsBySeat.map((w) =>
          w ? hydrateTDModel(w) : undefined
        ),
      });
      recordResult(res);
    }
  }

  const p = (winsA + 0.5 * draws) / Math.max(1, games);
  const ci95 = 1.96 * Math.sqrt(Math.max(0, (p * (1 - p)) / Math.max(1, games)));

  return {
    idA: cA.id,
    labelA: cA.label,
    idB: cB.id,
    labelB: cB.label,
    ...(cC ? { idC: cC.id, labelC: cC.label } : {}),
    games,
    winsA,
    winsB,
    winsC,
    draws,
    winRateA: p,
    ci95A: ci95,
    avgTurns: totalTurns / Math.max(1, games),
    reasons,
  };
}

function mergeReasons(target: Record<string, number>, src: Record<string, number>) {
  for (const [k, v] of Object.entries(src)) {
    target[k] = (target[k] ?? 0) + v;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cfgIdx = argv.indexOf('--config');
  if (cfgIdx === -1 || cfgIdx + 1 >= argv.length) {
    throw new Error('Usage: tsx scripts/compare-models.ts --config <job.json>');
  }
  const cfgPath = path.resolve(argv[cfgIdx + 1]);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as CompareJobConfig;

  const variant = cfg.variant;
  const games = Math.max(1, Math.floor(cfg.games));
  const workers = Math.max(1, Math.floor(cfg.workers || Math.min(8, Math.max(1, os.cpus().length - 1))));
  const seed = Number.isFinite(cfg.seed) ? Math.floor(cfg.seed) : 202611;

  if (cfg.contestants.length < 2) {
    throw new Error('Comparison requires at least 2 contestants.');
  }

  const weightsMap = new Map<string, TDVariantWeights | undefined>();
  for (const c of cfg.contestants) {
    weightsMap.set(c.id, loadWeightsForContestant(variant, c));
  }

  const pairs: Array<[ContestantSpec, ContestantSpec, ContestantSpec | undefined]> = [];
  if (cfg.mode === 'matchup') {
    pairs.push([cfg.contestants[0], cfg.contestants[1], variant === '1v1v1' ? cfg.contestants[2] : undefined]);
  } else if (cfg.mode === 'gauntlet') {
    const challenger = cfg.contestants[0];
    for (let i = 1; i < cfg.contestants.length; i++) {
      pairs.push([
        challenger,
        cfg.contestants[i],
        variant === '1v1v1' ? cfg.contestants[i] : undefined,
      ]);
    }
  } else {
    for (let i = 0; i < cfg.contestants.length; i++) {
      for (let j = i + 1; j < cfg.contestants.length; j++) {
        pairs.push([
          cfg.contestants[i],
          cfg.contestants[j],
          variant === '1v1v1' ? cfg.contestants[j] : undefined,
        ]);
      }
    }
  }

  const totalGames = pairs.length * games;
  let doneGames = 0;

  const emit = (type: string, payload: unknown) => {
    process.stdout.write(`__COMPARE_JSON__${JSON.stringify({ type, payload })}\n`);
  };

  const pool = workers > 1 ? new CompareWorkerPool(workers) : null;
  const matchups: MatchupComparisonResult[] = [];
  const overallReasons: Record<string, number> = {};
  const matrixMap = new Map<string, number>();

  const totals = new Map<
    string,
    { label: string; wins: number; losses: number; draws: number; games: number; turnsSum: number }
  >();
  for (const c of cfg.contestants) {
    totals.set(c.id, { label: c.label, wins: 0, losses: 0, draws: 0, games: 0, turnsSum: 0 });
  }

  try {
    for (let pIdx = 0; pIdx < pairs.length; pIdx++) {
      const [cA, cB, cC] = pairs[pIdx];
      const pairLabel = cC
        ? `${cA.label} vs ${cB.label} vs ${cC.label}`
        : `${cA.label} vs ${cB.label}`;
      emit('progress', {
        doneGames,
        totalGames,
        pairIndex: pIdx + 1,
        totalPairs: pairs.length,
        pairLabel,
      });

      const res = await runPairwise(
        pool,
        workers,
        variant,
        games,
        seed + pIdx * 10000,
        cA,
        cB,
        cC,
        weightsMap,
        (inc) => {
          doneGames += inc;
          if (doneGames % Math.max(1, Math.floor(games / 5)) === 0 || doneGames === totalGames) {
            emit('progress', {
              doneGames,
              totalGames,
              pairIndex: pIdx + 1,
              totalPairs: pairs.length,
              pairLabel,
            });
          }
        }
      );

      matchups.push(res);
      mergeReasons(overallReasons, res.reasons);

      matrixMap.set(`${cA.id}__${cB.id}`, res.winRateA * 100);
      matrixMap.set(
        `${cB.id}__${cA.id}`,
        ((res.winsB + res.winsC + 0.5 * res.draws) / Math.max(1, res.games)) * 100
      );

      const ta = totals.get(cA.id)!;
      ta.wins += res.winsA;
      ta.losses += res.winsB + res.winsC;
      ta.draws += res.draws;
      ta.games += res.games;
      ta.turnsSum += res.avgTurns * res.games;

      const tb = totals.get(cB.id)!;
      if (cC && cC.id !== cB.id) {
        tb.wins += res.winsB;
        tb.losses += res.winsA + res.winsC;
        tb.draws += res.draws;
        tb.games += res.games;
        tb.turnsSum += res.avgTurns * res.games;
        const tc = totals.get(cC.id)!;
        tc.wins += res.winsC;
        tc.losses += res.winsA + res.winsB;
        tc.draws += res.draws;
        tc.games += res.games;
        tc.turnsSum += res.avgTurns * res.games;
      } else {
        tb.wins += res.winsB + res.winsC;
        tb.losses += res.winsA;
        tb.draws += res.draws;
        tb.games += res.games;
        tb.turnsSum += res.avgTurns * res.games;
      }
    }

    const leaderboard: LeaderboardEntry[] = Array.from(totals.entries())
      .filter(([, t]) => t.games > 0)
      .map(([id, t]) => {
        const wr = (t.wins + 0.5 * t.draws) / Math.max(1, t.games);
        const ci95 = 1.96 * Math.sqrt(Math.max(0, (wr * (1 - wr)) / Math.max(1, t.games)));
        return {
          id,
          label: t.label,
          wins: t.wins,
          losses: t.losses,
          draws: t.draws,
          games: t.games,
          winRate: wr,
          ci95,
          avgTurns: t.turnsSum / Math.max(1, t.games),
        };
      })
      .sort((a, b) => b.winRate - a.winRate || b.wins - a.wins);

    const matrix: Array<{ rowId: string; colId: string; winRate: number | null }> = [];
    for (const r of cfg.contestants) {
      for (const c of cfg.contestants) {
        matrix.push({
          rowId: r.id,
          colId: c.id,
          winRate: r.id === c.id ? null : (matrixMap.get(`${r.id}__${c.id}`) ?? null),
        });
      }
    }

    const output: CompareJobOutput = {
      mode: cfg.mode,
      variant,
      gamesPerPair: games,
      totalGames,
      seed,
      matchups,
      leaderboard,
      matrix,
      reasons: overallReasons,
    };

    emit('result', output);
  } finally {
    if (pool) {
      await pool.close();
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
