import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { ALL_COLORS, ALL_FUNCTIONAL_ICONS, ICON_LABELS } from '../src/engine/constants';
import { computeScoreTotal } from '../src/engine/keywords';
import { getVisibleIconCounts } from '../src/engine/splay';
import { serializeTDModel, validateTDModelBundle, type TDVariantWeights } from '../src/engine/tdNetwork';
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

type BenchmarkMode = 'matchup' | 'gauntlet' | 'round-robin';

const ALL_AI_TIERS: CanonicalAIBackend[] = [
  'heuristic',
  'td_easy',
  'td_medium',
  'td_hard',
  'td_full',
];

function parseAIToken(raw: string): CanonicalAIBackend {
  const norm = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  switch (norm) {
    case 'heuristic':
    case 'heur':
    case 'h':
      return 'heuristic';
    case 'td_easy':
    case 'easy':
    case 'easy_td':
      return 'td_easy';
    case 'td_medium':
    case 'medium':
    case 'med':
    case 'medium_td':
      return 'td_medium';
    case 'td_hard':
    case 'hard':
    case 'hard_td':
      return 'td_hard';
    case 'td_full':
    case 'full':
    case 'full_td':
    case 'td':
      return 'td_full';
    default:
      throw new Error(
        `Unknown AI tier "${raw}". Valid options: heuristic, td_easy, td_medium, td_hard, td_full`
      );
  }
}

function printHelp() {
  console.log(`
Innovation 4E CLI AI Benchmark Tool (v1.8)

Usage:
  npm run bench:ai -- [options]

Modes:
  --mode matchup        One AI vs another AI specifically (default)
  --mode gauntlet       One AI vs multiple opponents in exact listed order
  --mode round-robin    Every AI plays every other AI in order + matrix table

Options:
  --variant <v>         1v1 | 1v1v1 | 2v2 (default: 1v1)
  --games <N>           Games per matchup (default: 40; paired seat swaps for fairness)
  --ai1 <ai>            Primary AI for matchup / gauntlet challenger (default: td_full)
  --ai2 <ai>            Opponent AI for matchup (default: heuristic)
  --ai3 <ai>            Optional 3rd seat AI for 1v1v1 matchup (defaults to --ai2)
  --opponents <list>    Comma-separated ordered list for gauntlet
                        (default: all other tiers vs --ai1)
  --ais <list>          Comma-separated ordered list for round-robin
                        (default: heuristic,td_easy,td_medium,td_hard,td_full)
  --weights <path>      Optional custom weights JSON bundle
  --workers <W>         Worker threads (default: min(8, cpuCount - 1))
  --seed <N>            Deterministic base seed (default: 202611)
  --snapshot-every <X>  Save an HTML end-game board snapshot every X games (0 = off, 1 = every game)
  --snapshot-dir <dir>  Directory for saved snapshots (default: benchmark-snapshots)
  --snapshot-max <N>    Max snapshot files kept on disk; oldest deleted first (default: 1000, 0 = unlimited)
  --help                Show this help

AI Tiers:
  heuristic | td_easy | td_medium | td_hard | td_full
`.trim());
}

function parseCliArgs(argv: string[]) {
  const getVal = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };
  const hasFlag = (flag: string) => argv.includes(flag);

  if (hasFlag('--help') || hasFlag('-h')) {
    printHelp();
    process.exit(0);
  }

  const modeRaw = (getVal('--mode') ?? 'matchup').toLowerCase();
  if (modeRaw !== 'matchup' && modeRaw !== 'gauntlet' && modeRaw !== 'round-robin') {
    throw new Error(`Invalid --mode "${modeRaw}". Use matchup, gauntlet, or round-robin.`);
  }

  const variantRaw = (getVal('--variant') ?? '1v1').toLowerCase();
  if (variantRaw !== '1v1' && variantRaw !== '1v1v1' && variantRaw !== '2v2') {
    throw new Error(`Invalid --variant "${variantRaw}". Use 1v1, 1v1v1, or 2v2.`);
  }

  const games = Math.max(1, Number(getVal('--games') ?? 40));
  const defaultWorkers = Math.min(8, Math.max(1, os.cpus().length - 1 || 1));
  const workers = Math.max(1, Number(getVal('--workers') ?? defaultWorkers));
  const seed = Number(getVal('--seed') ?? 202611);
  const weightsPath = getVal('--weights');

  const snapshotEveryRaw = Number(getVal('--snapshot-every') ?? 0);
  const snapshotEvery = Number.isFinite(snapshotEveryRaw) && snapshotEveryRaw > 0 ? Math.floor(snapshotEveryRaw) : 0;
  const snapshotDir = path.resolve(getVal('--snapshot-dir') ?? 'benchmark-snapshots');
  const snapshotMaxRaw = getVal('--snapshot-max');
  const snapshotMax =
    snapshotMaxRaw !== undefined && Number.isFinite(Number(snapshotMaxRaw))
      ? Math.max(0, Math.floor(Number(snapshotMaxRaw)))
      : 1000;

  const ai1 = parseAIToken(getVal('--ai1') ?? getVal('--challenger') ?? 'td_full');
  const ai2 = parseAIToken(getVal('--ai2') ?? 'heuristic');
  const ai3 = getVal('--ai3') ? parseAIToken(getVal('--ai3')!) : undefined;

  const opponentsList = getVal('--opponents')
    ? getVal('--opponents')!
        .split(',')
        .map(parseAIToken)
    : ALL_AI_TIERS.filter((t) => t !== ai1);

  const aisList = getVal('--ais')
    ? getVal('--ais')!
        .split(',')
        .map(parseAIToken)
    : [...ALL_AI_TIERS];

  return {
    mode: modeRaw as BenchmarkMode,
    variant: variantRaw as GameVariant,
    games,
    workers,
    seed,
    weightsPath,
    snapshotEvery,
    snapshotDir,
    snapshotMax,
    ai1,
    ai2,
    ai3,
    opponentsList,
    aisList,
  };
}

class BenchWorkerPool {
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

function loadWeightsForVariant(
  variant: GameVariant,
  weightsPath: string | undefined,
  needsTD: boolean
): TDVariantWeights | undefined {
  if (weightsPath) {
    const abs = path.resolve(weightsPath);
    if (!fs.existsSync(abs)) {
      throw new Error(`Weights file not found: ${abs}`);
    }
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf-8'));
    const checked = validateTDModelBundle(parsed);
    if (!checked.valid || !checked.bundle) {
      throw new Error(`Invalid weights bundle at ${abs}: ${checked.error}`);
    }
    const vw = checked.bundle.variants[variant];
    if (!vw && needsTD) {
      throw new Error(`Weights bundle ${abs} does not contain variant "${variant}".`);
    }
    return vw;
  }

  if (!hasTrainedTDWeights(variant)) {
    if (needsTD) {
      console.warn(
        `[Warning] Trained TD weights not found in src/data/tdWeights.${variant}.json; TD seats will use untrained fallback initialization.`
      );
    }
    return undefined;
  }
  return serializeTDModel(getActiveTDModel(variant));
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

class SnapshotManager {
  readonly dir: string;
  readonly every: number;
  readonly maxFiles: number;
  private trackedPaths: string[] = [];
  writtenCount = 0;

  constructor(dir: string, every: number, maxFiles: number) {
    this.dir = dir;
    this.every = every;
    this.maxFiles = maxFiles;
    if (this.every > 0) {
      fs.mkdirSync(this.dir, { recursive: true });
      const existing = fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith('.html'))
        .map((f) => {
          const full = path.join(this.dir, f);
          return { full, mtimeMs: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => a.mtimeMs - b.mtimeMs || a.full.localeCompare(b.full));
      this.trackedPaths = existing.map((e) => e.full);
      this.prune();
    }
  }

  private prune() {
    if (this.maxFiles <= 0) return;
    while (this.trackedPaths.length > this.maxFiles) {
      const oldest = this.trackedPaths.shift();
      if (oldest && fs.existsSync(oldest)) {
        try {
          fs.unlinkSync(oldest);
        } catch {
          // Ignore already removed snapshot
        }
      }
    }
  }

  writeSnapshot(opts: {
    globalGameIdx: number;
    mode: BenchmarkMode;
    pairLabel: string;
    result: BenchmarkMatchResult;
  }) {
    if (this.every <= 0 || !opts.result.finalState) return;
    const state = opts.result.finalState;
    const detailVictory = formatVictoryDetailLabel(opts.result.reason, opts.result.summary);
    const winners = opts.result.players.filter((p) => p.isWinner);
    const winnerText =
      winners.length > 0
        ? winners
            .map((w) => `${w.name} (${getAIDifficultyProfile(w.aiBackend).label})`)
            .join(', ')
        : 'Draw (Turn Limit)';

    const metadata = {
      generatedAt: new Date().toISOString(),
      globalGameNumber: opts.globalGameIdx,
      matchIndexInPair: opts.result.matchIndex,
      mode: opts.mode,
      variant: opts.result.variant,
      matchup: opts.pairLabel,
      seed: opts.result.seed,
      turns: opts.result.turns,
      victoryReason: opts.result.reason,
      victoryDetail: detailVictory,
      victorySummary: opts.result.summary,
      winnerTeamId: opts.result.winnerTeamId,
      winnerPlayerIds: opts.result.winnerPlayerIds,
      winnerText,
      players: opts.result.players,
    };

    const slug = `${opts.pairLabel}_g${opts.result.matchIndex}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64);
    const fileName = `snap_${String(opts.globalGameIdx).padStart(6, '0')}_${opts.result.variant}_${slug}.html`;
    const filePath = path.join(this.dir, fileName);

    const playersHtml = state.players
      .map((pl, idx) => {
        const summaryPlayer = opts.result.players[idx];
        const isWinner = Boolean(summaryPlayer?.isWinner);
        const icons = getVisibleIconCounts(pl.board);
        const score = summaryPlayer?.score ?? computeScoreTotal(pl);
        const achList =
          pl.achievements.length > 0
            ? pl.achievements
                .map((a) =>
                  a.kind === 'standard'
                    ? `Age ${a.age}`
                    : a.kind === 'special'
                    ? `Special: ${a.specialId ?? a.id}`
                    : `Chain: ${a.card?.name ?? a.id}`
                )
                .join(', ')
            : 'None';

        const stacksHtml = ALL_COLORS.map((c) => {
          const st = pl.board[c];
          const top = st.cards[st.cards.length - 1];
          const cardList = st.cards
            .map((card) => `[${card.age}] ${card.name}`)
            .join(' → ');
          return `
            <div class="stack color-${c}">
              <div class="stack-head">
                <strong>${c.toUpperCase()}</strong>
                <span>${st.cards.length} card${st.cards.length === 1 ? '' : 's'} · splay: ${st.splay}</span>
              </div>
              <div class="stack-top">${
                top ? `[Age ${top.age}] ${escapeHtml(top.name)}` : '<em>Empty</em>'
              }</div>
              ${
                st.cards.length > 1
                  ? `<div class="stack-all">${escapeHtml(cardList)}</div>`
                  : ''
              }
            </div>`;
        }).join('');

        const handText =
          pl.hand.length > 0
            ? pl.hand.map((c) => `[${c.age}] ${c.name}`).join(', ')
            : 'Empty';
        const scoreCardsText =
          pl.scorePile.length > 0
            ? pl.scorePile.map((c) => `[${c.age}] ${c.name}`).join(', ')
            : 'Empty';

        return `
          <section class="player ${isWinner ? 'winner' : ''}">
            <div class="player-head">
              <div>
                <h2>${escapeHtml(pl.name)} ${isWinner ? '<span class="badge">WINNER</span>' : ''}</h2>
                <div class="sub">AI: ${escapeHtml(
                  getAIDifficultyProfile(summaryPlayer?.aiBackend ?? pl.aiBackend).label
                )} · Team ${escapeHtml(pl.teamId)} · Highest Age ${
          summaryPlayer?.highestTopAge ?? '-'
        }</div>
              </div>
              <div class="metrics">
                <span><strong>Ach:</strong> ${pl.achievements.length}</span>
                <span><strong>Score:</strong> ${score} (${pl.scorePile.length} cards)</span>
                <span><strong>Hand:</strong> ${pl.hand.length}</span>
              </div>
            </div>
            <div class="icons">
              ${ALL_FUNCTIONAL_ICONS.map((ic) => `${ICON_LABELS[ic]} ${icons[ic]}`).join(' · ')}
            </div>
            <div class="stacks">${stacksHtml}</div>
            <div class="piles">
              <div><strong>Achievements (${pl.achievements.length}):</strong> ${escapeHtml(achList)}</div>
              <div><strong>Score Pile:</strong> ${escapeHtml(scoreCardsText)}</div>
              <div><strong>Hand:</strong> ${escapeHtml(handText)}</div>
            </div>
          </section>`;
      })
      .join('\n');

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Game #${opts.globalGameIdx} Snapshot · ${escapeHtml(opts.result.summary)}</title>
<style>
  body { margin: 0; padding: 20px; background: #14100d; color: #f5efe2; font-family: system-ui, -apple-system, sans-serif; line-height: 1.4; }
  .wrap { max-width: 1120px; margin: 0 auto; }
  .card { background: #221b17; border: 1px solid rgba(217,199,163,0.22); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
  h1 { margin: 0 0 6px; font-size: 20px; color: #f6c945; }
  h2 { margin: 0; font-size: 16px; display: flex; align-items: center; gap: 8px; }
  .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; font-size: 13px; color: #d9c7a3; margin-top: 8px; }
  .meta-grid strong { color: #f5efe2; }
  .player { background: #1c1714; border: 1px solid rgba(217,199,163,0.2); border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; }
  .player.winner { border-color: #66b08e; background: #17231e; }
  .badge { background: #66b08e; color: #14100d; font-size: 10px; font-weight: 800; padding: 2px 6px; border-radius: 4px; letter-spacing: .04em; }
  .player-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; align-items: baseline; }
  .sub { font-size: 12px; color: #b8a996; }
  .metrics { display: flex; gap: 14px; font-size: 13px; color: #e5dac5; font-variant-numeric: tabular-nums; }
  .icons { font-size: 12px; color: #c8b9a6; margin: 6px 0 10px; font-variant-numeric: tabular-nums; }
  .stacks { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px; }
  .stack { border-radius: 6px; padding: 8px; border: 1px solid rgba(255,255,255,0.14); background: #26201b; font-size: 12px; }
  .color-red { border-left: 4px solid #b8443a; }
  .color-yellow { border-left: 4px solid #c89d2a; }
  .color-green { border-left: 4px solid #3f8a57; }
  .color-blue { border-left: 4px solid #3c6ea8; }
  .color-purple { border-left: 4px solid #7d529e; }
  .stack-head { display: flex; justify-content: space-between; font-size: 11px; color: #c8b9a6; margin-bottom: 4px; }
  .stack-top { font-weight: 600; color: #f5efe2; }
  .stack-all { margin-top: 4px; font-size: 11px; color: #a79986; }
  .piles { margin-top: 8px; font-size: 12px; color: #cbbba6; display: grid; gap: 3px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>Game #${opts.globalGameIdx} &mdash; ${escapeHtml(opts.result.summary)}</h1>
    <div class="meta-grid">
      <div><strong>Eventual Winner:</strong> ${escapeHtml(winnerText)}</div>
      <div><strong>Victory Method:</strong> ${escapeHtml(detailVictory)}</div>
      <div><strong>Matchup:</strong> ${escapeHtml(opts.pairLabel)}</div>
      <div><strong>Variant / Mode:</strong> ${escapeHtml(opts.result.variant)} / ${escapeHtml(opts.mode)}</div>
      <div><strong>Turns:</strong> ${opts.result.turns}</div>
      <div><strong>Seed:</strong> ${opts.result.seed}</div>
      <div><strong>Match # in Pair:</strong> ${opts.result.matchIndex}</div>
      <div><strong>Recorded:</strong> ${escapeHtml(metadata.generatedAt)}</div>
    </div>
  </div>
  ${playersHtml}
</div>
<script type="application/json" id="match-snapshot-metadata">${JSON.stringify(metadata)}</script>
</body>
</html>`;

    fs.writeFileSync(filePath, html, 'utf-8');
    this.trackedPaths.push(filePath);
    this.writtenCount += 1;
    this.prune();
  }
}

interface PairwiseMatchupSummary {
  aiA: CanonicalAIBackend;
  aiB: CanonicalAIBackend;
  aiC?: CanonicalAIBackend;
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

function buildSeatLineup(
  variant: GameVariant,
  aiA: CanonicalAIBackend,
  aiB: CanonicalAIBackend,
  aiC: CanonicalAIBackend | undefined,
  gameIdx: number
): {
  names: string[];
  backends: CanonicalAIBackend[];
  aSeats: Set<string>;
  bSeats: Set<string>;
  cSeats: Set<string>;
} {
  const labelA = getAIDifficultyProfile(aiA).shortLabel;
  const labelB = getAIDifficultyProfile(aiB).shortLabel;
  if (variant === '1v1') {
    const swap = gameIdx % 2 === 1;
    const backends: CanonicalAIBackend[] = swap ? [aiB, aiA] : [aiA, aiB];
    const names = swap ? [`${labelB} (P1)`, `${labelA} (P2)`] : [`${labelA} (P1)`, `${labelB} (P2)`];
    return {
      names,
      backends,
      aSeats: new Set([swap ? 'p2' : 'p1']),
      bSeats: new Set([swap ? 'p1' : 'p2']),
      cSeats: new Set(),
    };
  }
  if (variant === '2v2') {
    const swap = gameIdx % 2 === 1;
    const backends: CanonicalAIBackend[] = swap
      ? [aiB, aiA, aiB, aiA]
      : [aiA, aiB, aiA, aiB];
    const names = swap
      ? [`${labelB} 1`, `${labelA} 1`, `${labelB} 2`, `${labelA} 2`]
      : [`${labelA} 1`, `${labelB} 1`, `${labelA} 2`, `${labelB} 2`];
    return {
      names,
      backends,
      aSeats: new Set(swap ? ['p2', 'p4'] : ['p1', 'p3']),
      bSeats: new Set(swap ? ['p1', 'p3'] : ['p2', 'p4']),
      cSeats: new Set(),
    };
  }
  // 1v1v1: rotate starter across 3 seats
  const third = aiC ?? aiB;
  const labelC = getAIDifficultyProfile(third).shortLabel;
  const baseBackends: CanonicalAIBackend[] = [aiA, aiB, third];
  const baseLabels = [labelA, labelB, labelC];
  const rot = gameIdx % 3;
  const backends: CanonicalAIBackend[] = [
    baseBackends[rot],
    baseBackends[(rot + 1) % 3],
    baseBackends[(rot + 2) % 3],
  ];
  const names = [
    `${baseLabels[rot]} (S1)`,
    `${baseLabels[(rot + 1) % 3]} (S2)`,
    `${baseLabels[(rot + 2) % 3]} (S3)`,
  ];
  const seatId = (origIdx: number) => `p${((origIdx - rot + 3) % 3) + 1}`;
  return {
    names,
    backends,
    aSeats: new Set([seatId(0)]),
    bSeats: new Set([seatId(1)]),
    cSeats: new Set([seatId(2)]),
  };
}

function formatDurationShort(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${String(rem).padStart(2, '0')}s`;
}

async function runMatchup(opts: {
  pool: BenchWorkerPool | null;
  workers: number;
  mode: BenchmarkMode;
  variant: GameVariant;
  aiA: CanonicalAIBackend;
  aiB: CanonicalAIBackend;
  aiC: CanonicalAIBackend | undefined;
  games: number;
  seedBase: number;
  modelWeights: TDVariantWeights | undefined;
  pairIdx: number;
  totalPairs: number;
  globalGameOffset: number;
  snapshotManager: SnapshotManager;
}): Promise<PairwiseMatchupSummary> {
  const {
    pool,
    workers,
    mode,
    variant,
    aiA,
    aiB,
    aiC,
    games,
    seedBase,
    modelWeights,
    pairIdx,
    totalPairs,
    globalGameOffset,
    snapshotManager,
  } = opts;

  const pairLabel = `${getAIDifficultyProfile(aiA).label} vs ${getAIDifficultyProfile(aiB).label}${
    aiC ? ` vs ${getAIDifficultyProfile(aiC).label}` : ''
  }`;
  const isTTY = Boolean(process.stdout.isTTY);
  const startedAt = Date.now();

  const scheduled = Array.from({ length: games }, (_, g) => {
    const pairCycle = variant === '1v1v1' ? 3 : 2;
    const pairSeed = seedBase + Math.floor(g / pairCycle) * 101;
    const lineup = buildSeatLineup(variant, aiA, aiB, aiC, g);
    const globalGameIdx = globalGameOffset + g + 1;
    return {
      matchIndex: g + 1,
      globalGameIdx,
      seed: pairSeed,
      playerNames: lineup.names,
      playerAIBackends: lineup.backends,
      captureFinalState:
        snapshotManager.every > 0 && globalGameIdx % snapshotManager.every === 0,
      lineup,
    };
  });

  let completed = 0;
  let winsA = 0;
  let winsB = 0;
  let winsC = 0;
  let draws = 0;
  let totalTurns = 0;
  const reasons: Record<string, number> = {};
  let nextMilestonePct = 25;

  const recordResult = (res: BenchmarkMatchResult) => {
    const idx = res.matchIndex - 1;
    const item = scheduled[idx];
    const lineup = item.lineup;
    completed += 1;
    totalTurns += res.turns;

    const reasonKey = formatVictoryDetailLabel(res.reason, res.summary);
    reasons[reasonKey] = (reasons[reasonKey] ?? 0) + 1;

    if (res.winnerPlayerIds.length === 0) {
      draws += 1;
    } else if (res.winnerPlayerIds.some((id) => lineup.aSeats.has(id))) {
      winsA += 1;
    } else if (res.winnerPlayerIds.some((id) => lineup.bSeats.has(id))) {
      winsB += 1;
    } else {
      winsC += 1;
    }

    if (item.captureFinalState && res.finalState) {
      snapshotManager.writeSnapshot({
        globalGameIdx: item.globalGameIdx,
        mode,
        pairLabel,
        result: res,
      });
    }

    const pct = Math.round((completed / games) * 100);
    const liveWinRate = ((winsA + 0.5 * draws) / completed) * 100;
    const liveAvgTurns = totalTurns / completed;
    if (isTTY) {
      process.stdout.write(
        `\r\x1b[K  [${pairIdx}/${totalPairs}] ${pairLabel}: ${completed}/${games} (${pct}%) | Win ${liveWinRate.toFixed(
          1
        )}% | Avg ${liveAvgTurns.toFixed(1)}t | ${formatDurationShort(Date.now() - startedAt)}`
      );
    } else if (games >= 4 && pct >= nextMilestonePct && completed < games) {
      console.log(
        `  [progress ${pairIdx}/${totalPairs}] ${pairLabel}: ${completed}/${games} (${pct}%) | Win ${liveWinRate.toFixed(
          1
        )}% | Avg ${liveAvgTurns.toFixed(1)}t`
      );
      while (nextMilestonePct <= pct) nextMilestonePct += 25;
    }
  };

  if (pool && workers > 1 && games > 1) {
    const batchSize = Math.max(1, Math.min(4, Math.ceil(games / (workers * 4))));
    const batches: Array<typeof scheduled> = [];
    for (let i = 0; i < scheduled.length; i += batchSize) {
      batches.push(scheduled.slice(i, i + batchSize));
    }

    let cursor = 0;
    const workerCount = Math.min(workers, batches.length);
    await Promise.all(
      Array.from({ length: workerCount }, async (_, wIdx) => {
        while (true) {
          const bIdx = cursor++;
          if (bIdx >= batches.length) break;
          const batch = batches[bIdx];
          const resp = await pool.run(wIdx, {
            variant,
            matches: batch.map(
              ({ matchIndex, seed, playerNames, playerAIBackends, captureFinalState }) => ({
                matchIndex,
                seed,
                playerNames,
                playerAIBackends,
                captureFinalState,
              })
            ),
            modelWeights,
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
        captureFinalState: m.captureFinalState,
      });
      recordResult(res);
    }
  }

  if (isTTY) {
    process.stdout.write('\r\x1b[K');
  }

  const p = (winsA + 0.5 * draws) / games;
  const ci95 = 1.96 * Math.sqrt(Math.max(0, (p * (1 - p)) / games));

  return {
    aiA,
    aiB,
    aiC,
    games,
    winsA,
    winsB,
    winsC,
    draws,
    winRateA: p,
    ci95A: ci95,
    avgTurns: totalTurns / games,
    reasons,
  };
}

function formatReasons(reasons: Record<string, number>): string {
  return Object.entries(reasons)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}

function mergeReasons(target: Record<string, number>, src: Record<string, number>) {
  for (const [k, v] of Object.entries(src)) {
    target[k] = (target[k] ?? 0) + v;
  }
}

function printVictoryReasonsSummary(reasons: Record<string, number>, totalGames: number) {
  console.log('\n=== Victory Methods & Card Victories Summary ===');
  const entries = Object.entries(reasons).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [label, count] of entries) {
    const pct = totalGames > 0 ? ((count / totalGames) * 100).toFixed(1) : '0.0';
    console.log(`  ${label.padEnd(32)} ${String(count).padStart(5)} (${pct}%)`);
  }
}

function printMatchupLine(summary: PairwiseMatchupSummary) {
  const aLabel = getAIDifficultyProfile(summary.aiA).label;
  const bLabel = getAIDifficultyProfile(summary.aiB).label;
  const scoreStr =
    summary.aiC !== undefined
      ? `${summary.winsA}-${summary.winsB}-${summary.winsC}-${summary.draws}D`
      : `${summary.winsA}W-${summary.winsB}L-${summary.draws}D`;
  const cLabel = summary.aiC ? ` vs ${getAIDifficultyProfile(summary.aiC).label}` : '';
  console.log(
    `${aLabel} vs ${bLabel}${cLabel} | ${scoreStr} | Win ${(summary.winRateA * 100).toFixed(1)}% (±${(summary.ci95A * 100).toFixed(1)}%) | Avg ${summary.avgTurns.toFixed(1)}t | [${formatReasons(summary.reasons)}]`
  );
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const usedAIs = new Set<CanonicalAIBackend>([
    args.ai1,
    args.ai2,
    ...(args.ai3 ? [args.ai3] : []),
    ...args.opponentsList,
    ...args.aisList,
  ]);
  const needsTD = Array.from(usedAIs).some((a) => getAIDifficultyProfile(a).isTD);
  const modelWeights = loadWeightsForVariant(args.variant, args.weightsPath, needsTD);
  const pool = args.workers > 1 ? new BenchWorkerPool(args.workers) : null;
  const snapshotManager = new SnapshotManager(
    args.snapshotDir,
    args.snapshotEvery,
    args.snapshotMax
  );

  console.log(
    `=== Innovation 4E AI Benchmark (${args.mode} | ${args.variant} | ${args.games} games/matchup | ${args.workers} workers) ===`
  );
  if (snapshotManager.every > 0) {
    console.log(
      `Snapshots: every ${snapshotManager.every} game(s) -> ${snapshotManager.dir} (max ${
        snapshotManager.maxFiles === 0 ? 'unlimited' : snapshotManager.maxFiles
      } files)`
    );
  }

  try {
    if (args.mode === 'matchup') {
      const res = await runMatchup({
        pool,
        workers: args.workers,
        mode: args.mode,
        variant: args.variant,
        aiA: args.ai1,
        aiB: args.ai2,
        aiC: args.ai3,
        games: args.games,
        seedBase: args.seed,
        modelWeights,
        pairIdx: 1,
        totalPairs: 1,
        globalGameOffset: 0,
        snapshotManager,
      });
      printMatchupLine(res);
      printVictoryReasonsSummary(res.reasons, res.games);
      return;
    }

    if (args.mode === 'gauntlet') {
      console.log(
        `Challenger: ${getAIDifficultyProfile(args.ai1).label} -> Opponents (in order): ${args.opponentsList
          .map((o) => getAIDifficultyProfile(o).label)
          .join(', ')}`
      );
      let totalWins = 0;
      let totalLosses = 0;
      let totalDraws = 0;
      const overallReasons: Record<string, number> = {};
      const totalPairs = args.opponentsList.length;
      for (let i = 0; i < totalPairs; i++) {
        const opp = args.opponentsList[i];
        const res = await runMatchup({
          pool,
          workers: args.workers,
          mode: args.mode,
          variant: args.variant,
          aiA: args.ai1,
          aiB: opp,
          aiC: args.variant === '1v1v1' ? opp : undefined,
          games: args.games,
          seedBase: args.seed + i * 10000,
          modelWeights,
          pairIdx: i + 1,
          totalPairs,
          globalGameOffset: i * args.games,
          snapshotManager,
        });
        totalWins += res.winsA;
        totalLosses += res.winsB + res.winsC;
        totalDraws += res.draws;
        mergeReasons(overallReasons, res.reasons);
        printMatchupLine(res);
      }
      const totalGames = totalWins + totalLosses + totalDraws;
      const overallPct = totalGames > 0 ? ((totalWins + 0.5 * totalDraws) / totalGames) * 100 : 0;
      console.log(
        `\nOverall Gauntlet: ${totalWins}W-${totalLosses}L-${totalDraws}D (${overallPct.toFixed(1)}% across ${totalGames} games)`
      );
      printVictoryReasonsSummary(overallReasons, totalGames);
      return;
    }

    // round-robin
    const roster = args.aisList;
    if (roster.length < 2) {
      throw new Error('Round-robin requires at least 2 AIs in --ais.');
    }
    const matrix = new Map<string, number>();
    const totals = new Map<
      CanonicalAIBackend,
      { wins: number; losses: number; draws: number; turnsSum: number; games: number }
    >();
    for (const ai of roster) {
      totals.set(ai, { wins: 0, losses: 0, draws: 0, turnsSum: 0, games: 0 });
    }

    const totalPairs = (roster.length * (roster.length - 1)) / 2;
    const overallReasons: Record<string, number> = {};
    let totalMatchesPlayed = 0;
    let pairIdx = 0;
    for (let i = 0; i < roster.length; i++) {
      for (let j = i + 1; j < roster.length; j++) {
        const a = roster[i];
        const b = roster[j];
        const res = await runMatchup({
          pool,
          workers: args.workers,
          mode: args.mode,
          variant: args.variant,
          aiA: a,
          aiB: b,
          aiC: args.variant === '1v1v1' ? b : undefined,
          games: args.games,
          seedBase: args.seed + pairIdx * 10000,
          modelWeights,
          pairIdx: pairIdx + 1,
          totalPairs,
          globalGameOffset: pairIdx * args.games,
          snapshotManager,
        });
        pairIdx += 1;
        totalMatchesPlayed += res.games;
        mergeReasons(overallReasons, res.reasons);
        printMatchupLine(res);
        matrix.set(`${a}__${b}`, res.winRateA * 100);
        matrix.set(`${b}__${a}`, ((res.winsB + res.winsC + 0.5 * res.draws) / res.games) * 100);

        const ta = totals.get(a)!;
        ta.wins += res.winsA;
        ta.losses += res.winsB + res.winsC;
        ta.draws += res.draws;
        ta.turnsSum += res.avgTurns * res.games;
        ta.games += res.games;

        const tb = totals.get(b)!;
        tb.wins += res.winsB + res.winsC;
        tb.losses += res.winsA;
        tb.draws += res.draws;
        tb.turnsSum += res.avgTurns * res.games;
        tb.games += res.games;
      }
    }

    console.log('\n=== Round-Robin Leaderboard ===');
    const ranked = [...roster].sort((a, b) => {
      const ta = totals.get(a)!;
      const tb = totals.get(b)!;
      const ra = (ta.wins + 0.5 * ta.draws) / Math.max(1, ta.games);
      const rb = (tb.wins + 0.5 * tb.draws) / Math.max(1, tb.games);
      return rb - ra;
    });

    for (let r = 0; r < ranked.length; r++) {
      const ai = ranked[r];
      const t = totals.get(ai)!;
      const pct = ((t.wins + 0.5 * t.draws) / Math.max(1, t.games)) * 100;
      console.log(
        `#${r + 1} ${getAIDifficultyProfile(ai).label.padEnd(13)} | ${t.wins}W-${t.losses}L-${t.draws}D (${pct.toFixed(1)}%) | Avg ${(t.turnsSum / Math.max(1, t.games)).toFixed(1)}t`
      );
    }

    console.log('\n=== Win-Rate Matrix (Row vs Column) ===');
    const header =
      'AI'.padEnd(12) +
      roster.map((c) => getAIDifficultyProfile(c).shortLabel.padStart(10)).join('');
    console.log(header);
    for (const row of roster) {
      const cells = roster.map((col) => {
        if (row === col) return '---'.padStart(10);
        const val = matrix.get(`${row}__${col}`);
        return (val !== undefined ? `${val.toFixed(1)}%` : '--').padStart(10);
      });
      console.log(getAIDifficultyProfile(row).shortLabel.padEnd(12) + cells.join(''));
    }

    printVictoryReasonsSummary(overallReasons, totalMatchesPlayed);
  } finally {
    if (snapshotManager.every > 0) {
      console.log(
        `\nSnapshots saved: ${snapshotManager.writtenCount} written to ${snapshotManager.dir} (rolling max ${
          snapshotManager.maxFiles === 0 ? 'unlimited' : snapshotManager.maxFiles
        })`
      );
    }
    if (pool) {
      await pool.close();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
