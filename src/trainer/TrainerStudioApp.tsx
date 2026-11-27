import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  BarChart3,
  Check,
  Copy,
  Cpu,
  Download,
  Image as ImageIcon,
  Layers,
  Play,
  Plus,
  RefreshCw,
  Square,
  Star,
  Trash2,
  Upload,
} from 'lucide-react';
import type { GameVariant } from '../engine/types';

type StudioTab = 'models' | 'train' | 'benchmark';
type BackendTier = 'heuristic' | 'td_easy' | 'td_medium' | 'td_hard' | 'td_full';
type BenchMode = 'matchup' | 'gauntlet' | 'round-robin';

interface VariantMetaInfo {
  activation: string;
  layerSizes: [number, number, number, number];
  warmstartGames: number;
  trainedGames: number;
  trainedAt: string;
  benchmarkWinRate?: number;
  fileSizeKB: number;
}

interface StoredModelMeta {
  id: string;
  name: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  resumedFrom?: string;
  variants: Partial<Record<GameVariant, VariantMetaInfo>>;
}

interface TrainMetricPoint {
  variant: GameVariant;
  phase: 'warmstart' | 'td-selfplay';
  done: number;
  total: number;
  loss: number;
  windowLoss: number;
  avgTurns: number;
  vsHeurRate?: number;
}

interface TrainJobState {
  id: string;
  running: boolean;
  modelId: string;
  modelName: string;
  variants: GameVariant[];
  currentVariant: GameVariant | null;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
  logs: string[];
  metrics: TrainMetricPoint[];
  latestProgress: TrainMetricPoint | null;
}

interface ContestantItem {
  key: string;
  label: string;
  backend: BackendTier;
  modelId?: string;
}

interface MatchupComparisonResult {
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

interface LeaderboardEntry {
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

interface CompareJobOutput {
  mode: BenchMode;
  variant: GameVariant;
  gamesPerPair: number;
  totalGames: number;
  seed: number;
  matchups: MatchupComparisonResult[];
  leaderboard: LeaderboardEntry[];
  matrix: Array<{ rowId: string; colId: string; winRate: number | null }>;
  reasons: Record<string, number>;
}

interface BenchmarkJobState {
  id: string;
  running: boolean;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
  progress: {
    doneGames: number;
    totalGames: number;
    pairIndex: number;
    totalPairs: number;
    pairLabel: string;
  } | null;
  logs: string[];
  result: CompareJobOutput | null;
}

const ALL_VARIANTS: readonly GameVariant[] = ['1v1', '1v1v1', '2v2'];
const TD_TIERS: ReadonlyArray<{ id: BackendTier; label: string }> = [
  { id: 'td_full', label: 'Full TD' },
  { id: 'td_hard', label: 'Hard TD' },
  { id: 'td_medium', label: 'Med TD' },
  { id: 'td_easy', label: 'Easy TD' },
];

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function renderBenchmarkSummaryCanvas(output: CompareJobOutput): string {
  const width = 1400;
  const headerH = 115;
  const rowCount = Math.max(output.leaderboard.length, output.matchups.length);
  const matrixRows = output.mode === 'round-robin' ? output.leaderboard.length : 0;
  const height = Math.max(
    680,
    headerH + rowCount * 58 + (matrixRows > 0 ? matrixRows * 42 + 120 : 120) + 170
  );

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  // Background
  ctx.fillStyle = '#1C1714';
  ctx.fillRect(0, 0, width, height);

  // Subtle gold frame
  ctx.strokeStyle = '#C88A1E';
  ctx.lineWidth = 3;
  ctx.strokeRect(20, 20, width - 40, height - 40);

  // Header
  ctx.fillStyle = '#F5EFE2';
  ctx.font = 'bold 34px Georgia, serif';
  ctx.fillText('Innovation 4E · AI Model Benchmark Report', 52, 70);

  ctx.fillStyle = '#C8B9A6';
  ctx.font = '18px ui-monospace, monospace';
  ctx.fillText(
    `Mode: ${output.mode.toUpperCase()}  |  Variant: ${output.variant}  |  Games/Pair: ${output.gamesPerPair}  |  Total Games: ${output.totalGames}  |  Seed: ${output.seed}`,
    52,
    102
  );

  ctx.fillStyle = '#9E8F7E';
  ctx.font = '14px ui-monospace, monospace';
  ctx.fillText(new Date().toISOString().slice(0, 19).replace('T', ' '), width - 260, 68);

  // Divider
  ctx.strokeStyle = 'rgba(217, 199, 163, 0.25)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(50, 124);
  ctx.lineTo(width - 50, 124);
  ctx.stroke();

  // Left: Leaderboard Win-Rate Bars
  let y = 165;
  ctx.fillStyle = '#F6C945';
  ctx.font = 'bold 20px system-ui, sans-serif';
  ctx.fillText('OVERALL STANDINGS & WIN RATE (±95% CI)', 52, y);
  y += 26;

  const barMaxW = 460;
  const labelW = 300;
  for (let i = 0; i < output.leaderboard.length; i++) {
    const item = output.leaderboard[i];
    const pct = item.winRate * 100;
    const ci = item.ci95 * 100;

    ctx.fillStyle = '#27201B';
    ctx.fillRect(52, y, 860, 44);
    ctx.strokeStyle = i === 0 ? '#C88A1E' : 'rgba(217, 199, 163, 0.18)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(52, y, 860, 44);

    ctx.fillStyle = '#F5EFE2';
    ctx.font = 'bold 16px system-ui, sans-serif';
    ctx.fillText(`#${i + 1} ${item.label.slice(0, 28)}`, 68, y + 27);

    // Bar track
    const bx = 52 + labelW;
    const bw = barMaxW;
    ctx.fillStyle = '#14100E';
    ctx.fillRect(bx, y + 12, bw, 20);

    const fillW = Math.max(2, (pct / 100) * bw);
    ctx.fillStyle = i === 0 ? '#C88A1E' : '#588157';
    ctx.fillRect(bx, y + 12, fillW, 20);

    // 50% line
    ctx.strokeStyle = 'rgba(245, 239, 226, 0.35)';
    ctx.beginPath();
    ctx.moveTo(bx + bw * 0.5, y + 10);
    ctx.lineTo(bx + bw * 0.5, y + 34);
    ctx.stroke();

    // Stats text
    ctx.fillStyle = '#F6C945';
    ctx.font = 'bold 15px ui-monospace, monospace';
    ctx.fillText(
      `${pct.toFixed(1)}% ±${ci.toFixed(1)}%  (${item.wins}W-${item.losses}L-${item.draws}D)`,
      bx + bw + 14,
      y + 27
    );

    y += 54;
  }

  // Right column: Victory Breakdown
  let ry = 165;
  const rx = 955;
  ctx.fillStyle = '#F6C945';
  ctx.font = 'bold 20px system-ui, sans-serif';
  ctx.fillText('VICTORY METHODS', rx, ry);
  ry += 28;

  const reasonEntries = Object.entries(output.reasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  for (const [label, count] of reasonEntries) {
    const rPct = output.totalGames > 0 ? ((count / output.totalGames) * 100).toFixed(1) : '0.0';
    ctx.fillStyle = '#27201B';
    ctx.fillRect(rx, ry, 395, 34);
    ctx.fillStyle = '#E5DAC5';
    ctx.font = '14px system-ui, sans-serif';
    ctx.fillText(label.slice(0, 28), rx + 12, ry + 22);
    ctx.fillStyle = '#F6C945';
    ctx.font = 'bold 14px ui-monospace, monospace';
    ctx.fillText(`${count} (${rPct}%)`, rx + 275, ry + 22);
    ry += 40;
  }

  // Bottom: Pairwise Matchups or Round-Robin Matrix
  let my = Math.max(y, ry) + 28;
  ctx.fillStyle = '#F6C945';
  ctx.font = 'bold 20px system-ui, sans-serif';
  ctx.fillText(
    output.mode === 'round-robin' ? 'ROUND-ROBIN WIN-RATE MATRIX' : 'PAIRWISE MATCHUP DETAILS',
    52,
    my
  );
  my += 24;

  if (output.mode === 'round-robin') {
    const roster = output.leaderboard;
    const colW = Math.min(180, Math.floor((width - 360) / Math.max(1, roster.length)));
    ctx.fillStyle = '#C8B9A6';
    ctx.font = 'bold 13px ui-monospace, monospace';
    roster.forEach((col, cIdx) => {
      ctx.fillText(col.label.slice(0, 15), 320 + cIdx * colW, my + 16);
    });
    my += 26;
    roster.forEach((row) => {
      ctx.fillStyle = '#F5EFE2';
      ctx.font = 'bold 14px system-ui, sans-serif';
      ctx.fillText(row.label.slice(0, 26), 52, my + 24);
      roster.forEach((col, cIdx) => {
        const cell = output.matrix.find((m) => m.rowId === row.id && m.colId === col.id);
        const val = cell?.winRate;
        const cx = 315 + cIdx * colW;
        ctx.fillStyle =
          val === null || val === undefined
            ? '#221B17'
            : val >= 55
            ? '#1E462C'
            : val >= 45
            ? '#382E1E'
            : '#4A2220';
        ctx.fillRect(cx, my + 4, colW - 8, 30);
        ctx.fillStyle = '#F5EFE2';
        ctx.font = '14px ui-monospace, monospace';
        ctx.fillText(
          val === null || val === undefined ? '—' : `${val.toFixed(1)}%`,
          cx + 12,
          my + 24
        );
      });
      my += 38;
    });
  } else {
    for (const m of output.matchups) {
      ctx.fillStyle = '#27201B';
      ctx.fillRect(52, my, width - 104, 38);
      ctx.fillStyle = '#F5EFE2';
      ctx.font = '15px system-ui, sans-serif';
      const title = m.labelC ? `${m.labelA} vs ${m.labelB} vs ${m.labelC}` : `${m.labelA} vs ${m.labelB}`;
      ctx.fillText(title, 68, my + 24);
      ctx.fillStyle = '#F6C945';
      ctx.font = 'bold 15px ui-monospace, monospace';
      ctx.fillText(
        `${m.winsA}W-${m.winsB}L${m.labelC ? `-${m.winsC}C` : ''}-${m.draws}D · ${(m.winRateA * 100).toFixed(1)}% (±${(m.ci95A * 100).toFixed(1)}%) · Avg ${m.avgTurns.toFixed(1)}t`,
        680,
        my + 24
      );
      my += 44;
    }
  }

  return canvas.toDataURL('image/png');
}

export const TrainerStudioApp: React.FC = () => {
  const [tab, setTab] = useState<StudioTab>('models');
  const [models, setModels] = useState<StoredModelMeta[]>([]);
  const [primaryModelId, setPrimaryModelId] = useState<string>('bundled-primary');
  const [statusBanner, setStatusBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editNotes, setEditNotes] = useState('');

  // Import state
  const [importName, setImportName] = useState('');
  const [importNotes, setImportNotes] = useState('');
  const importInputRef = useRef<HTMLInputElement | null>(null);

  // Train state (all CLI flags)
  const [trainModelName, setTrainModelName] = useState('TD Run v1.6');
  const [trainNotes, setTrainNotes] = useState('');
  const [resumeModelId, setResumeModelId] = useState<string>('');
  const [trainVariant, setTrainVariant] = useState<GameVariant | 'all'>('all');
  const [activation, setActivation] = useState<'tanh' | 'leaky_relu'>('tanh');
  const [warmstartGames, setWarmstartGames] = useState(5000);
  const [tdGames, setTdGames] = useState(2000);
  const [lambdaVal, setLambdaVal] = useState(0.7);
  const [alphaVal, setAlphaVal] = useState(0.0003);
  const [warmstartAlphaVal, setWarmstartAlphaVal] = useState(0.0008);
  const [batchSize, setBatchSize] = useState(32);
  const [distillWeight, setDistillWeight] = useState(0.55);
  const [evalGames, setEvalGames] = useState(40);
  const [trainWorkers, setTrainWorkers] = useState(4);
  const [trainSeed, setTrainSeed] = useState(202611);
  const [logEvery, setLogEvery] = useState(100);
  const [evalOnly, setEvalOnly] = useState(false);
  const [trainJob, setTrainJob] = useState<TrainJobState | null>(null);

  // Benchmark & Comparison state
  const [benchMode, setBenchMode] = useState<BenchMode>('round-robin');
  const [benchVariant, setBenchVariant] = useState<GameVariant>('1v1');
  const [benchGames, setBenchGames] = useState(40);
  const [benchWorkers, setBenchWorkers] = useState(4);
  const [benchSeed, setBenchSeed] = useState(202611);
  const [contestants, setContestants] = useState<ContestantItem[]>([]);
  const [pickModelId, setPickModelId] = useState<string>('');
  const [pickTier, setPickTier] = useState<BackendTier>('td_full');
  const [benchJob, setBenchJob] = useState<BenchmarkJobState | null>(null);

  const loadModels = useCallback(async () => {
    const data = await apiJson<{ primaryModelId: string; models: StoredModelMeta[] }>(
      '/__trainer_api/models'
    );
    setModels(data.models);
    setPrimaryModelId(data.primaryModelId);
    setPickModelId((prev) => prev || data.primaryModelId || data.models[0]?.id || '');
    setContestants((prev) => {
      if (prev.length > 0) return prev;
      const primary = data.models.find((m) => m.id === data.primaryModelId) ?? data.models[0];
      const seedList: ContestantItem[] = [];
      if (primary) {
        seedList.push({
          key: `${primary.id}::td_full::${Date.now()}`,
          label: `${primary.name} (Full TD)`,
          backend: 'td_full',
          modelId: primary.id,
        });
      }
      seedList.push({
        key: `heuristic::${Date.now() + 1}`,
        label: 'Heuristic',
        backend: 'heuristic',
      });
      return seedList;
    });
  }, []);

  useEffect(() => {
    void loadModels().catch((err) =>
      setStatusBanner({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    );
    void apiJson<{ defaultTrainWorkers: number; defaultBenchWorkers: number }>(
      '/__trainer_api/system'
    )
      .then((sys) => {
        setTrainWorkers(sys.defaultTrainWorkers);
        setBenchWorkers(sys.defaultBenchWorkers);
      })
      .catch(() => {});
    void apiJson<{ job: TrainJobState | null }>('/__trainer_api/train/status')
      .then((res) => {
        if (res.job) setTrainJob(res.job);
      })
      .catch(() => {});
    void apiJson<{ job: BenchmarkJobState | null }>('/__trainer_api/benchmark/status')
      .then((res) => {
        if (res.job) setBenchJob(res.job);
      })
      .catch(() => {});
  }, [loadModels]);

  // Poll running training job
  useEffect(() => {
    if (!trainJob?.running) return;
    const id = window.setInterval(() => {
      void apiJson<{ job: TrainJobState | null }>('/__trainer_api/train/status')
        .then((res) => {
          if (!res.job) return;
          setTrainJob(res.job);
          if (!res.job.running) {
            void loadModels();
          }
        })
        .catch(() => {});
    }, 1000);
    return () => window.clearInterval(id);
  }, [trainJob?.running, loadModels]);

  // Poll running benchmark job
  useEffect(() => {
    if (!benchJob?.running) return;
    const id = window.setInterval(() => {
      void apiJson<{ job: BenchmarkJobState | null }>('/__trainer_api/benchmark/status')
        .then((res) => {
          if (res.job) setBenchJob(res.job);
        })
        .catch(() => {});
    }, 800);
    return () => window.clearInterval(id);
  }, [benchJob?.running]);

  const handleSetPrimary = async (id: string) => {
    try {
      const data = await apiJson<{ primaryModelId: string; models: StoredModelMeta[] }>(
        `/__trainer_api/models/${encodeURIComponent(id)}/set-primary`,
        { method: 'POST', body: '{}' }
      );
      setModels(data.models);
      setPrimaryModelId(data.primaryModelId);
      setStatusBanner({
        kind: 'ok',
        text: `Promoted "${data.models.find((m) => m.id === id)?.name ?? id}" to Primary (src/data/tdWeights.*.json). Rebuild/offline export will now bundle these weights.`,
      });
    } catch (err) {
      setStatusBanner({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleCloneModel = async (m: StoredModelMeta) => {
    try {
      const data = await apiJson<{ models: StoredModelMeta[]; primaryModelId: string }>(
        `/__trainer_api/models/${encodeURIComponent(m.id)}/clone`,
        {
          method: 'POST',
          body: JSON.stringify({ name: `${m.name} Copy` }),
        }
      );
      setModels(data.models);
      setPrimaryModelId(data.primaryModelId);
      setStatusBanner({ kind: 'ok', text: `Cloned "${m.name}" to a new model entry.` });
    } catch (err) {
      setStatusBanner({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleDeleteModel = async (id: string) => {
    try {
      const data = await apiJson<{ models: StoredModelMeta[]; primaryModelId: string }>(
        `/__trainer_api/models/${encodeURIComponent(id)}`,
        { method: 'DELETE' }
      );
      setModels(data.models);
      setPrimaryModelId(data.primaryModelId);
      setConfirmDeleteId(null);
      setStatusBanner({ kind: 'ok', text: 'Deleted non-primary model.' });
    } catch (err) {
      setStatusBanner({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleSaveRename = async (id: string) => {
    try {
      const data = await apiJson<{ models: StoredModelMeta[]; primaryModelId: string }>(
        `/__trainer_api/models/${encodeURIComponent(id)}/rename`,
        {
          method: 'POST',
          body: JSON.stringify({ name: editName, notes: editNotes }),
        }
      );
      setModels(data.models);
      setPrimaryModelId(data.primaryModelId);
      setEditingId(null);
    } catch (err) {
      setStatusBanner({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleImportFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    try {
      const bundles = await Promise.all(
        files.map(async (f) => ({ fileName: f.name, content: await f.text() }))
      );
      const data = await apiJson<{ models: StoredModelMeta[]; primaryModelId: string }>(
        '/__trainer_api/models/import',
        {
          method: 'POST',
          body: JSON.stringify({
            name: importName.trim() || files[0].name.replace(/\.json$/i, ''),
            notes: importNotes.trim(),
            bundles,
          }),
        }
      );
      setModels(data.models);
      setPrimaryModelId(data.primaryModelId);
      setImportName('');
      setImportNotes('');
      setStatusBanner({ kind: 'ok', text: 'Imported weights into a new saved model.' });
    } catch (err) {
      setStatusBanner({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleStartTraining = async () => {
    try {
      setStatusBanner(null);
      const job = await apiJson<TrainJobState>('/__trainer_api/train/start', {
        method: 'POST',
        body: JSON.stringify({
          modelName: trainModelName,
          notes: trainNotes,
          resumeModelId: resumeModelId || undefined,
          variant: trainVariant,
          activation,
          warmstartGames,
          games: tdGames,
          lambda: lambdaVal,
          alpha: alphaVal,
          warmstartAlpha: warmstartAlphaVal,
          batchSize,
          distillWeight,
          evalGames,
          workers: trainWorkers,
          seed: trainSeed,
          logEvery,
          evalOnly,
        }),
      });
      setTrainJob(job);
    } catch (err) {
      setStatusBanner({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleStopTraining = async () => {
    await apiJson('/__trainer_api/train/stop', { method: 'POST', body: '{}' }).catch(() => {});
  };

  const addModelContestant = () => {
    const model = models.find((m) => m.id === pickModelId) ?? models[0];
    if (!model) return;
    const tierLabel = TD_TIERS.find((t) => t.id === pickTier)?.label ?? pickTier;
    setContestants((prev) => [
      ...prev,
      {
        key: `${model.id}::${pickTier}::${Date.now()}::${prev.length}`,
        label: `${model.name} (${tierLabel})`,
        backend: pickTier,
        modelId: model.id,
      },
    ]);
  };

  const addHeuristicContestant = () => {
    setContestants((prev) => [
      ...prev,
      {
        key: `heuristic::${Date.now()}::${prev.length}`,
        label: 'Heuristic',
        backend: 'heuristic',
      },
    ]);
  };

  const handleStartBenchmark = async () => {
    try {
      setStatusBanner(null);
      const job = await apiJson<BenchmarkJobState>('/__trainer_api/benchmark/start', {
        method: 'POST',
        body: JSON.stringify({
          mode: benchMode,
          variant: benchVariant,
          games: benchGames,
          workers: benchWorkers,
          seed: benchSeed,
          contestants: contestants.map((c) => ({
            id: c.key,
            label: c.label,
            backend: c.backend,
            modelId: c.modelId,
          })),
        }),
      });
      setBenchJob(job);
    } catch (err) {
      setStatusBanner({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleStopBenchmark = async () => {
    await apiJson('/__trainer_api/benchmark/stop', { method: 'POST', body: '{}' }).catch(() => {});
  };

  const handleDownloadBenchmarkPng = () => {
    if (!benchJob?.result) return;
    const dataUrl = renderBenchmarkSummaryCanvas(benchJob.result);
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `innovation-benchmark-${benchJob.result.variant}-${benchJob.result.mode}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const cliPreview = useMemo(() => {
    const parts = [
      'npm run train:td --',
      `--variant ${trainVariant}`,
      `--activation ${activation}`,
      `--warmstart-games ${warmstartGames}`,
      `--games ${tdGames}`,
      `--lambda ${lambdaVal}`,
      `--alpha ${alphaVal}`,
      `--warmstart-alpha ${warmstartAlphaVal}`,
      `--batch-size ${batchSize}`,
      `--distill ${distillWeight}`,
      `--eval-games ${evalGames}`,
      `--workers ${trainWorkers}`,
      `--seed ${trainSeed}`,
      `--log-every ${logEvery}`,
    ];
    if (resumeModelId) parts.push(`--resume trained-models/${resumeModelId}/tdWeights.${trainVariant === 'all' ? '1v1' : trainVariant}.json`);
    if (evalOnly) parts.push('--eval-only');
    return parts.join(' ');
  }, [
    trainVariant,
    activation,
    warmstartGames,
    tdGames,
    lambdaVal,
    alphaVal,
    warmstartAlphaVal,
    batchSize,
    distillWeight,
    evalGames,
    trainWorkers,
    trainSeed,
    logEvery,
    resumeModelId,
    evalOnly,
  ]);

  return (
    <div className="min-h-screen bg-archival-table text-[#F5EFE2] flex flex-col">
      <header className="sticky top-0 z-30 bg-[#1C1714] border-b border-[#D9C7A3]/20 px-4 sm:px-6 py-3">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <a
              href="/"
              className="inline-flex items-center gap-1.5 min-h-[36px] px-3 rounded-lg border border-[#D9C7A3]/25 bg-[#27201B] text-xs font-semibold text-[#D9C7A3] hover:text-[#F5EFE2] hover:border-[#F6C945]"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Game</span>
            </a>
            <div className="min-w-0">
              <h1 className="font-display text-lg sm:text-xl font-bold text-[#F6C945] truncate">
                TD Training &amp; Weights Studio
              </h1>
              <p className="text-[11px] text-[#B8A996]">
                Dev-only workbench · Multi-model management &amp; comparison (excluded from offline .html)
              </p>
            </div>
          </div>

          <nav className="flex items-center gap-1.5">
            {(
              [
                { id: 'models', label: 'Models & Primary', icon: Layers },
                { id: 'train', label: 'Train New AI', icon: Cpu },
                { id: 'benchmark', label: 'Compare & Benchmark', icon: BarChart3 },
              ] as const
            ).map((item) => {
              const Icon = item.icon;
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={`min-h-[38px] px-3 rounded-lg border text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors ${
                    active
                      ? 'bg-[#C88A1E] border-[#C88A1E] text-[#1C1714]'
                      : 'bg-[#27201B] border-[#D9C7A3]/20 text-[#D9C7A3] hover:text-[#F5EFE2]'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 space-y-5">
        {statusBanner && (
          <div
            className={`rounded-lg border px-4 py-2.5 text-xs sm:text-sm flex items-center justify-between gap-3 ${
              statusBanner.kind === 'err'
                ? 'border-[#8E2920] bg-[#361614] text-[#F4B4AC]'
                : 'border-[#588157] bg-[#1A2B1D] text-[#A8E6B0]'
            }`}
          >
            <span>{statusBanner.text}</span>
            <button
              type="button"
              onClick={() => setStatusBanner(null)}
              className="text-xs underline opacity-80 hover:opacity-100 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* TAB 1: MODELS & PRIMARY */}
        {tab === 'models' && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-lg font-bold text-[#F5EFE2]">
                  Saved Weight Models ({models.length})
                </h2>
                <p className="text-xs text-[#B8A996]">
                  Only the selected Primary model is copied to <code className="font-mono-num">src/data/tdWeights.*.json</code> and folded into <code className="font-mono-num">npm run build</code> / offline HTML.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void loadModels()}
                  className="min-h-[36px] px-3 rounded-lg border border-[#D9C7A3]/25 bg-[#27201B] text-xs font-semibold text-[#E5DAC5] hover:border-[#F6C945] inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Refresh</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setResumeModelId('');
                    setTrainModelName(`TD Run ${models.length + 1}`);
                    setTab('train');
                  }}
                  className="min-h-[36px] px-3.5 rounded-lg bg-[#C88A1E] text-[#1C1714] text-xs font-bold hover:bg-[#d89928] inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Train New Model</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {models.map((m) => {
                const isPrimary = m.id === primaryModelId;
                const isEditing = editingId === m.id;
                return (
                  <section
                    key={m.id}
                    className={`rounded-xl border p-4 space-y-3 ${
                      isPrimary
                        ? 'border-[#C88A1E] bg-[#2B221B]'
                        : 'border-[#D9C7A3]/20 bg-[#27201B]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      {isEditing ? (
                        <div className="flex-1 space-y-2">
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className="w-full min-h-[34px] rounded border border-[#D9C7A3]/30 bg-[#1C1714] px-2.5 text-sm font-semibold text-[#F5EFE2]"
                          />
                          <input
                            type="text"
                            value={editNotes}
                            onChange={(e) => setEditNotes(e.target.value)}
                            placeholder="Optional notes..."
                            className="w-full min-h-[32px] rounded border border-[#D9C7A3]/20 bg-[#1C1714] px-2.5 text-xs text-[#D9C7A3]"
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => void handleSaveRename(m.id)}
                              className="min-h-[30px] px-3 rounded bg-[#C88A1E] text-[#1C1714] text-xs font-bold cursor-pointer"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingId(null)}
                              className="min-h-[30px] px-3 rounded border border-[#D9C7A3]/25 text-xs cursor-pointer"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="font-display text-base font-bold text-[#F5EFE2] truncate">
                              {m.name}
                            </h3>
                            {isPrimary && (
                              <span className="inline-flex items-center gap-1 rounded border border-[#E5B842] bg-[#3A2D19] px-2 py-0.5 font-mono-num text-[10px] font-bold text-[#F6C945]">
                                <Star className="w-3 h-3 fill-current" />
                                PRIMARY (NPM/GAME)
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] font-mono-num text-[#9E8F7E] mt-0.5">
                            {m.id} · Updated {m.updatedAt.slice(0, 16).replace('T', ' ')}
                          </div>
                          {m.notes && (
                            <p className="text-xs text-[#C8B9A6] mt-1">{m.notes}</p>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      {ALL_VARIANTS.map((v) => {
                        const info = m.variants[v];
                        return (
                          <div
                            key={v}
                            className="flex items-center justify-between gap-2 rounded-lg border border-[#D9C7A3]/15 bg-[#1C1714] px-2.5 py-1.5 text-xs"
                          >
                            <div className="min-w-0">
                              <span className="font-mono-num font-bold text-[#F6C945] mr-2">
                                {v}
                              </span>
                              {info ? (
                                <span className="font-mono-num text-[11px] text-[#D9C7A3]">
                                  {info.layerSizes.join('→')} ({info.activation}) · {info.warmstartGames}w + {info.trainedGames} TD
                                  {info.benchmarkWinRate !== undefined
                                    ? ` · ${(info.benchmarkWinRate * 100).toFixed(1)}% vs Heur`
                                    : ''}
                                  {' · '}
                                  {info.fileSizeKB} KB
                                </span>
                              ) : (
                                <span className="text-[11px] text-[#7D7061]">Not trained</span>
                              )}
                            </div>
                            {info && (
                              <a
                                href={`/__trainer_api/models/${encodeURIComponent(m.id)}/export/${v}`}
                                className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#C8B9A6] hover:text-[#F6C945] shrink-0"
                                title={`Download ${v} JSON`}
                              >
                                <Download className="w-3 h-3" />
                                <span>JSON</span>
                              </a>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      {!isPrimary && Object.keys(m.variants).length > 0 && (
                        <button
                          type="button"
                          onClick={() => void handleSetPrimary(m.id)}
                          className="min-h-[32px] px-3 rounded-lg bg-[#C88A1E] text-[#1C1714] text-xs font-bold hover:bg-[#d89928] inline-flex items-center gap-1 cursor-pointer"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>Set as Primary</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setResumeModelId(m.id);
                          setTrainModelName(`${m.name} +TD`);
                          setTab('train');
                        }}
                        className="min-h-[32px] px-2.5 rounded-lg border border-[#C88A1E]/50 bg-[#3A2D19]/60 text-xs font-semibold text-[#F6C945] hover:bg-[#4d3b21] inline-flex items-center gap-1 cursor-pointer"
                      >
                        <Cpu className="w-3.5 h-3.5" />
                        <span>Retrain New Copy</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleCloneModel(m)}
                        className="min-h-[32px] px-2.5 rounded-lg border border-[#D9C7A3]/20 bg-[#1C1714] text-xs font-medium text-[#E5DAC5] hover:border-[#F6C945] inline-flex items-center gap-1 cursor-pointer"
                      >
                        <Copy className="w-3 h-3" />
                        <span>Clone</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(m.id);
                          setEditName(m.name);
                          setEditNotes(m.notes);
                        }}
                        className="min-h-[32px] px-2.5 rounded-lg border border-[#D9C7A3]/20 bg-[#1C1714] text-xs font-medium text-[#E5DAC5] hover:border-[#F6C945] cursor-pointer"
                      >
                        Rename
                      </button>
                      {!isPrimary && (
                        confirmDeleteId === m.id ? (
                          <button
                            type="button"
                            onClick={() => void handleDeleteModel(m.id)}
                            className="min-h-[32px] px-2.5 rounded-lg bg-[#8E2920] text-[#F5EFE2] text-xs font-bold cursor-pointer"
                          >
                            Confirm Delete
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(m.id)}
                            className="min-h-[32px] px-2.5 rounded-lg border border-[#8E2920]/60 bg-[#1C1714] text-xs font-medium text-[#E89B90] hover:bg-[#361614] inline-flex items-center gap-1 cursor-pointer"
                          >
                            <Trash2 className="w-3 h-3" />
                            <span>Delete</span>
                          </button>
                        )
                      )}
                    </div>
                  </section>
                );
              })}
            </div>

            {/* Import Weights Bundle */}
            <section className="rounded-xl border border-[#D9C7A3]/20 bg-[#27201B] p-4 space-y-3">
              <h3 className="font-display text-sm font-bold text-[#F6C945]">
                Import External Weight JSON(s) as New Model
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <input
                  type="text"
                  value={importName}
                  onChange={(e) => setImportName(e.target.value)}
                  placeholder="Model display name..."
                  className="min-h-[38px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-3 text-xs text-[#F5EFE2]"
                />
                <input
                  type="text"
                  value={importNotes}
                  onChange={(e) => setImportNotes(e.target.value)}
                  placeholder="Notes (optional)..."
                  className="min-h-[38px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-3 text-xs text-[#F5EFE2]"
                />
                <div>
                  <input
                    ref={importInputRef}
                    type="file"
                    accept=".json,application/json"
                    multiple
                    onChange={handleImportFiles}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => importInputRef.current?.click()}
                    className="w-full min-h-[38px] rounded-lg border border-[#C88A1E]/60 bg-[#3A2D19] text-xs font-bold text-[#F6C945] hover:bg-[#4d3b21] inline-flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>Choose JSON File(s)</span>
                  </button>
                </div>
              </div>
            </section>
          </div>
        )}

        {/* TAB 2: TRAIN NEW AI (ALL CLI FLAGS) */}
        {tab === 'train' && (
          <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_1fr] gap-5">
            <section className="rounded-xl border border-[#D9C7A3]/20 bg-[#27201B] p-4 space-y-4">
              <div>
                <h2 className="font-display text-lg font-bold text-[#F5EFE2]">
                  Train New Model (Non-Destructive)
                </h2>
                <p className="text-xs text-[#B8A996]">
                  Every run saves into a separate model folder so previous weights are never deleted.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="space-y-1 text-xs">
                  <span className="font-semibold text-[#D9C7A3]">New Model Name</span>
                  <input
                    type="text"
                    value={trainModelName}
                    onChange={(e) => setTrainModelName(e.target.value)}
                    className="w-full min-h-[36px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-3 text-xs text-[#F5EFE2]"
                  />
                </label>

                <label className="space-y-1 text-xs">
                  <span className="font-semibold text-[#D9C7A3]">Resume / Seed From (--resume)</span>
                  <select
                    value={resumeModelId}
                    onChange={(e) => setResumeModelId(e.target.value)}
                    className="w-full min-h-[36px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-2.5 text-xs text-[#F5EFE2]"
                  >
                    <option value="">Fresh Random Initialization</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} {m.id === primaryModelId ? '(Primary)' : ''}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-1 text-xs">
                  <span className="font-semibold text-[#D9C7A3]">Variant (--variant)</span>
                  <select
                    value={trainVariant}
                    onChange={(e) => setTrainVariant(e.target.value as GameVariant | 'all')}
                    className="w-full min-h-[36px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-2.5 text-xs text-[#F5EFE2]"
                  >
                    <option value="all">all (1v1, 1v1v1, 2v2)</option>
                    <option value="1v1">1v1</option>
                    <option value="1v1v1">1v1v1</option>
                    <option value="2v2">2v2</option>
                  </select>
                </label>

                <label className="space-y-1 text-xs">
                  <span className="font-semibold text-[#D9C7A3]">Activation (--activation)</span>
                  <select
                    value={activation}
                    onChange={(e) => setActivation(e.target.value as 'tanh' | 'leaky_relu')}
                    className="w-full min-h-[36px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-2.5 text-xs text-[#F5EFE2]"
                  >
                    <option value="tanh">tanh</option>
                    <option value="leaky_relu">leaky_relu</option>
                  </select>
                </label>

                <label className="space-y-1 text-xs">
                  <span className="font-semibold text-[#D9C7A3]">Warmstart Games (--warmstart-games)</span>
                  <input
                    type="number"
                    min={0}
                    value={warmstartGames}
                    onChange={(e) => setWarmstartGames(Number(e.target.value))}
                    className="w-full min-h-[36px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-3 text-xs font-mono-num text-[#F5EFE2]"
                  />
                </label>

                <label className="space-y-1 text-xs">
                  <span className="font-semibold text-[#D9C7A3]">TD Games (--games)</span>
                  <input
                    type="number"
                    min={0}
                    value={tdGames}
                    onChange={(e) => setTdGames(Number(e.target.value))}
                    className="w-full min-h-[36px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-3 text-xs font-mono-num text-[#F5EFE2]"
                  />
                </label>

                <label className="space-y-1 text-xs">
                  <span className="font-semibold text-[#D9C7A3]">Lambda (--lambda)</span>
                  <input
                    type="number"
                    step="0.05"
                    min={0}
                    max={1}
                    value={lambdaVal}
                    onChange={(e) => setLambdaVal(Number(e.target.value))}
                    className="w-full min-h-[36px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-3 text-xs font-mono-num text-[#F5EFE2]"
                  />
                </label>

                <label className="space-y-1 text-xs">
                  <span className="font-semibold text-[#D9C7A3]">TD Alpha (--alpha)</span>
                  <input
                    type="number"
                    step="0.0001"
                    min={0}
                    value={alphaVal}
                    onChange={(e) => setAlphaVal(Number(e.target.value))}
                    className="w-full min-h-[36px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-3 text-xs font-mono-num text-[#F5EFE2]"
                  />
                </label>

                <label className="space-y-1 text-xs">
                  <span className="font-semibold text-[#D9C7A3]">Warmstart Alpha (--warmstart-alpha)</span>
                  <input
                    type="number"
                    step="0.0001"
                    min={0}
                    value={warmstartAlphaVal}
                    onChange={(e) => setWarmstartAlphaVal(Number(e.target.value))}
                    className="w-full min-h-[36px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-3 text-xs font-mono-num text-[#F5EFE2]"
                  />
                </label>

                <label className="space-y-1 text-xs">
                  <span className="font-semibold text-[#D9C7A3]">Batch Size (--batch-size)</span>
                  <input
                    type="number"
                    min={1}
                    value={batchSize}
                    onChange={(e) => setBatchSize(Number(e.target.value))}
                    className="w-full min-h-[36px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-3 text-xs font-mono-num text-[#F5EFE2]"
                  />
                </label>

                <label className="space-y-1 text-xs">
                  <span className="font-semibold text-[#D9C7A3]">Distill Weight (--distill)</span>
                  <input
                    type="number"
                    step="0.05"
                    min={0}
                    max={1}
                    value={distillWeight}
                    onChange={(e) => setDistillWeight(Number(e.target.value))}
                    className="w-full min-h-[36px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-3 text-xs font-mono-num text-[#F5EFE2]"
                  />
                </label>

                <label className="space-y-1 text-xs">
                  <span className="font-semibold text-[#D9C7A3]">Eval Games (--eval-games)</span>
                  <input
                    type="number"
                    min={0}
                    value={evalGames}
                    onChange={(e) => setEvalGames(Number(e.target.value))}
                    className="w-full min-h-[36px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-3 text-xs font-mono-num text-[#F5EFE2]"
                  />
                </label>

                <label className="space-y-1 text-xs">
                  <span className="font-semibold text-[#D9C7A3]">Workers (--workers)</span>
                  <input
                    type="number"
                    min={1}
                    value={trainWorkers}
                    onChange={(e) => setTrainWorkers(Number(e.target.value))}
                    className="w-full min-h-[36px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-3 text-xs font-mono-num text-[#F5EFE2]"
                  />
                </label>

                <label className="space-y-1 text-xs">
                  <span className="font-semibold text-[#D9C7A3]">Seed (--seed)</span>
                  <input
                    type="number"
                    value={trainSeed}
                    onChange={(e) => setTrainSeed(Number(e.target.value))}
                    className="w-full min-h-[36px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-3 text-xs font-mono-num text-[#F5EFE2]"
                  />
                </label>

                <label className="space-y-1 text-xs">
                  <span className="font-semibold text-[#D9C7A3]">Log Every (--log-every)</span>
                  <input
                    type="number"
                    min={1}
                    value={logEvery}
                    onChange={(e) => setLogEvery(Number(e.target.value))}
                    className="w-full min-h-[36px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-3 text-xs font-mono-num text-[#F5EFE2]"
                  />
                </label>

                <label className="flex items-center gap-2 pt-5 text-xs font-semibold text-[#D9C7A3] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={evalOnly}
                    onChange={(e) => setEvalOnly(e.target.checked)}
                    className="accent-[#C88A1E]"
                  />
                  <span>Eval Only (--eval-only)</span>
                </label>
              </div>

              <label className="block space-y-1 text-xs">
                <span className="font-semibold text-[#D9C7A3]">Run Notes (Optional)</span>
                <input
                  type="text"
                  value={trainNotes}
                  onChange={(e) => setTrainNotes(e.target.value)}
                  placeholder="Describe hyperparameters or goal..."
                  className="w-full min-h-[36px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-3 text-xs text-[#F5EFE2]"
                />
              </label>

              <div className="rounded-lg border border-[#D9C7A3]/15 bg-[#1C1714] p-2.5 text-[11px] font-mono-num text-[#B8A996] break-all">
                <div className="text-[10px] uppercase tracking-wider text-[#F6C945] mb-1">
                  Equivalent CLI Command
                </div>
                {cliPreview}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={Boolean(trainJob?.running)}
                  onClick={() => void handleStartTraining()}
                  className="flex-1 min-h-[42px] rounded-lg bg-[#C88A1E] text-[#1C1714] text-sm font-bold hover:bg-[#d89928] disabled:opacity-45 inline-flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Play className="w-4 h-4 fill-current" />
                  <span>{trainJob?.running ? 'Training in Progress...' : 'Start Training'}</span>
                </button>
                {trainJob?.running && (
                  <button
                    type="button"
                    onClick={() => void handleStopTraining()}
                    className="min-h-[42px] px-4 rounded-lg bg-[#8E2920] text-[#F5EFE2] text-sm font-bold hover:bg-[#a63329] inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <Square className="w-4 h-4 fill-current" />
                    <span>Stop</span>
                  </button>
                )}
              </div>
            </section>

            {/* Right: Live Progress, Loss Chart & Console */}
            <section className="rounded-xl border border-[#D9C7A3]/20 bg-[#27201B] p-4 flex flex-col gap-3 min-h-[460px]">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-display text-base font-bold text-[#F6C945] flex items-center gap-1.5">
                  <Activity className="w-4 h-4" />
                  <span>Training Progress</span>
                </h3>
                {trainJob && (
                  <span className="font-mono-num text-[11px] text-[#C8B9A6]">
                    {trainJob.running
                      ? `Running ${trainJob.currentVariant ?? ''}`
                      : trainJob.exitCode === 0
                      ? 'Completed'
                      : `Exited (${trainJob.exitCode ?? '?'})`}
                  </span>
                )}
              </div>

              {trainJob?.latestProgress && (
                <div className="rounded-lg border border-[#D9C7A3]/15 bg-[#1C1714] p-3 space-y-2">
                  <div className="flex items-center justify-between text-xs font-mono-num">
                    <span className="text-[#F5EFE2]">
                      [{trainJob.latestProgress.variant}] {trainJob.latestProgress.phase}
                    </span>
                    <span className="text-[#F6C945]">
                      {trainJob.latestProgress.done}/{trainJob.latestProgress.total} · loss{' '}
                      {trainJob.latestProgress.loss.toFixed(4)}
                      {trainJob.latestProgress.vsHeurRate !== undefined
                        ? ` · vsHeur ${(trainJob.latestProgress.vsHeurRate * 100).toFixed(1)}%`
                        : ''}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-[#27201B] overflow-hidden">
                    <div
                      className="h-full bg-[#C88A1E] transition-all"
                      style={{
                        width: `${Math.min(
                          100,
                          (trainJob.latestProgress.done / Math.max(1, trainJob.latestProgress.total)) *
                            100
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              )}

              {trainJob && trainJob.metrics.length > 1 && (
                <div className="rounded-lg border border-[#D9C7A3]/15 bg-[#1C1714] p-2.5">
                  <div className="text-[10px] font-mono-num text-[#B8A996] mb-1">
                    Window Loss Trajectory ({trainJob.metrics.length} checkpoints)
                  </div>
                  <svg viewBox="0 0 400 90" className="w-full h-24">
                    {(() => {
                      const pts = trainJob.metrics.slice(-80);
                      const losses = pts.map((p) => p.windowLoss);
                      const maxL = Math.max(0.01, ...losses);
                      const minL = Math.min(...losses);
                      const span = Math.max(0.005, maxL - minL);
                      const poly = pts
                        .map((p, i) => {
                          const x = (i / Math.max(1, pts.length - 1)) * 392 + 4;
                          const y = 84 - ((p.windowLoss - minL) / span) * 74;
                          return `${x.toFixed(1)},${y.toFixed(1)}`;
                        })
                        .join(' ');
                      return (
                        <polyline
                          fill="none"
                          stroke="#F6C945"
                          strokeWidth="2"
                          points={poly}
                        />
                      );
                    })()}
                  </svg>
                </div>
              )}

              {trainJob?.error && (
                <div className="rounded-lg border border-[#8E2920] bg-[#361614] px-3 py-2 text-xs text-[#F4B4AC]">
                  {trainJob.error}
                </div>
              )}

              <div className="flex-1 min-h-[240px] max-h-[420px] overflow-y-auto rounded-lg border border-[#D9C7A3]/15 bg-[#14100E] p-3 font-mono-num text-[11px] text-[#D9C7A3] space-y-1">
                {trainJob?.logs.length ? (
                  trainJob.logs.map((line, i) => <div key={i}>{line}</div>)
                ) : (
                  <div className="text-[#7D7061]">
                    Configure parameters and click Start Training to stream live progress logs here.
                  </div>
                )}
              </div>
            </section>
          </div>
        )}

        {/* TAB 3: COMPARE & BENCHMARK */}
        {tab === 'benchmark' && (
          <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-5">
            <section className="rounded-xl border border-[#D9C7A3]/20 bg-[#27201B] p-4 space-y-4">
              <h2 className="font-display text-lg font-bold text-[#F5EFE2]">
                Compare Models &amp; Weights
              </h2>

              <div className="grid grid-cols-2 gap-2.5">
                <label className="space-y-1 text-xs">
                  <span className="font-semibold text-[#D9C7A3]">Mode</span>
                  <select
                    value={benchMode}
                    onChange={(e) => setBenchMode(e.target.value as BenchMode)}
                    className="w-full min-h-[36px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-2 text-xs text-[#F5EFE2]"
                  >
                    <option value="round-robin">Round-Robin</option>
                    <option value="matchup">Matchup</option>
                    <option value="gauntlet">Gauntlet</option>
                  </select>
                </label>

                <label className="space-y-1 text-xs">
                  <span className="font-semibold text-[#D9C7A3]">Variant</span>
                  <select
                    value={benchVariant}
                    onChange={(e) => setBenchVariant(e.target.value as GameVariant)}
                    className="w-full min-h-[36px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-2 text-xs text-[#F5EFE2]"
                  >
                    <option value="1v1">1v1</option>
                    <option value="1v1v1">1v1v1</option>
                    <option value="2v2">2v2</option>
                  </select>
                </label>

                <label className="space-y-1 text-xs">
                  <span className="font-semibold text-[#D9C7A3]">Games / Matchup</span>
                  <input
                    type="number"
                    min={2}
                    step={2}
                    value={benchGames}
                    onChange={(e) => setBenchGames(Number(e.target.value))}
                    className="w-full min-h-[36px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-2.5 text-xs font-mono-num text-[#F5EFE2]"
                  />
                </label>

                <label className="space-y-1 text-xs">
                  <span className="font-semibold text-[#D9C7A3]">Workers</span>
                  <input
                    type="number"
                    min={1}
                    value={benchWorkers}
                    onChange={(e) => setBenchWorkers(Number(e.target.value))}
                    className="w-full min-h-[36px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-2.5 text-xs font-mono-num text-[#F5EFE2]"
                  />
                </label>
              </div>

              <label className="block space-y-1 text-xs">
                <span className="font-semibold text-[#D9C7A3]">Seed</span>
                <input
                  type="number"
                  value={benchSeed}
                  onChange={(e) => setBenchSeed(Number(e.target.value))}
                  className="w-full min-h-[36px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-2.5 text-xs font-mono-num text-[#F5EFE2]"
                />
              </label>

              <div className="space-y-2 pt-1 border-t border-[#D9C7A3]/15">
                <div className="text-xs font-semibold text-[#F6C945]">Add Contestant</div>
                <div className="grid grid-cols-[1fr_92px] gap-1.5">
                  <select
                    value={pickModelId}
                    onChange={(e) => setPickModelId(e.target.value)}
                    className="min-h-[34px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-2 text-xs text-[#F5EFE2]"
                  >
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} {m.id === primaryModelId ? '★' : ''}
                      </option>
                    ))}
                  </select>
                  <select
                    value={pickTier}
                    onChange={(e) => setPickTier(e.target.value as BackendTier)}
                    className="min-h-[34px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-1.5 text-xs text-[#F5EFE2]"
                  >
                    {TD_TIERS.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={addModelContestant}
                    className="min-h-[34px] rounded-lg border border-[#C88A1E]/55 bg-[#3A2D19] text-xs font-semibold text-[#F6C945] hover:bg-[#4d3b21] cursor-pointer"
                  >
                    + Add Model
                  </button>
                  <button
                    type="button"
                    onClick={addHeuristicContestant}
                    className="min-h-[34px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] text-xs font-semibold text-[#E5DAC5] hover:border-[#F6C945] cursor-pointer"
                  >
                    + Add Heuristic
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="text-xs font-semibold text-[#D9C7A3]">
                  Lineup ({contestants.length})
                </div>
                {contestants.map((c, idx) => (
                  <div
                    key={c.key}
                    className="flex items-center justify-between gap-2 rounded-lg border border-[#D9C7A3]/15 bg-[#1C1714] px-2.5 py-1.5 text-xs"
                  >
                    <span className="truncate">
                      <strong className="font-mono-num text-[#F6C945] mr-1.5">
                        #{idx + 1}
                      </strong>
                      {c.label}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setContestants((prev) => prev.filter((item) => item.key !== c.key))
                      }
                      aria-label={`Remove ${c.label}`}
                      className="text-[#E89B90] hover:text-[#F5EFE2] cursor-pointer shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={Boolean(benchJob?.running) || contestants.length < 2}
                  onClick={() => void handleStartBenchmark()}
                  className="flex-1 min-h-[42px] rounded-lg bg-[#C88A1E] text-[#1C1714] text-sm font-bold hover:bg-[#d89928] disabled:opacity-45 inline-flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Play className="w-4 h-4 fill-current" />
                  <span>{benchJob?.running ? 'Benchmarking...' : 'Run Benchmark'}</span>
                </button>
                {benchJob?.running && (
                  <button
                    type="button"
                    onClick={() => void handleStopBenchmark()}
                    className="min-h-[42px] px-3.5 rounded-lg bg-[#8E2920] text-[#F5EFE2] text-xs font-bold cursor-pointer"
                  >
                    Stop
                  </button>
                )}
              </div>
            </section>

            {/* Results & Charts */}
            <section className="rounded-xl border border-[#D9C7A3]/20 bg-[#27201B] p-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-display text-base font-bold text-[#F6C945]">
                  Comparison Results &amp; Charts
                </h3>
                {benchJob?.result && (
                  <button
                    type="button"
                    onClick={handleDownloadBenchmarkPng}
                    className="min-h-[34px] px-3 rounded-lg bg-[#C88A1E] text-[#1C1714] text-xs font-bold hover:bg-[#d89928] inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <ImageIcon className="w-3.5 h-3.5" />
                    <span>Save Chart Picture (PNG)</span>
                  </button>
                )}
              </div>

              {benchJob?.running && benchJob.progress && (
                <div className="rounded-lg border border-[#D9C7A3]/15 bg-[#1C1714] p-3 space-y-2">
                  <div className="flex justify-between text-xs font-mono-num">
                    <span className="text-[#F5EFE2]">
                      Pair {benchJob.progress.pairIndex}/{benchJob.progress.totalPairs}:{' '}
                      {benchJob.progress.pairLabel}
                    </span>
                    <span className="text-[#F6C945]">
                      {benchJob.progress.doneGames}/{benchJob.progress.totalGames} games
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-[#27201B] overflow-hidden">
                    <div
                      className="h-full bg-[#C88A1E] transition-all"
                      style={{
                        width: `${Math.min(
                          100,
                          (benchJob.progress.doneGames /
                            Math.max(1, benchJob.progress.totalGames)) *
                            100
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              )}

              {benchJob?.error && (
                <div className="rounded-lg border border-[#8E2920] bg-[#361614] px-3 py-2 text-xs text-[#F4B4AC]">
                  {benchJob.error}
                </div>
              )}

              {benchJob?.result ? (
                <div className="space-y-4">
                  {/* Leaderboard Bars */}
                  <div className="space-y-2">
                    {benchJob.result.leaderboard.map((row, idx) => {
                      const pct = row.winRate * 100;
                      const ci = row.ci95 * 100;
                      return (
                        <div
                          key={row.id}
                          className="rounded-lg border border-[#D9C7A3]/15 bg-[#1C1714] p-2.5 space-y-1.5"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                            <span className="font-semibold text-[#F5EFE2]">
                              <span className="font-mono-num text-[#F6C945] mr-1.5">
                                #{idx + 1}
                              </span>
                              {row.label}
                            </span>
                            <span className="font-mono-num text-[#E5DAC5]">
                              <strong className="text-[#F6C945]">
                                {pct.toFixed(1)}%
                              </strong>{' '}
                              (±{ci.toFixed(1)}%) · {row.wins}W-{row.losses}L-{row.draws}D · Avg{' '}
                              {row.avgTurns.toFixed(1)}t
                            </span>
                          </div>
                          <div className="relative h-3 rounded-full bg-[#27201B] overflow-hidden">
                            <div
                              className={`h-full ${idx === 0 ? 'bg-[#C88A1E]' : 'bg-[#588157]'}`}
                              style={{ width: `${Math.max(1, pct)}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Round-Robin Matrix */}
                  {benchJob.result.mode === 'round-robin' && (
                    <div className="overflow-x-auto rounded-lg border border-[#D9C7A3]/15 bg-[#1C1714] p-3">
                      <div className="text-xs font-semibold text-[#F6C945] mb-2">
                        Win-Rate Matrix (Row vs Column)
                      </div>
                      <table className="w-full text-xs font-mono-num">
                        <thead>
                          <tr className="text-left text-[#C8B9A6] border-b border-[#D9C7A3]/15">
                            <th className="py-1.5 pr-3">Model</th>
                            {benchJob.result.leaderboard.map((col) => (
                              <th key={col.id} className="py-1.5 px-2 text-right">
                                {col.label.slice(0, 14)}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {benchJob.result.leaderboard.map((row) => (
                            <tr key={row.id} className="border-b border-[#D9C7A3]/10">
                              <td className="py-1.5 pr-3 font-sans font-semibold text-[#F5EFE2]">
                                {row.label}
                              </td>
                              {benchJob.result!.leaderboard.map((col) => {
                                const cell = benchJob.result!.matrix.find(
                                  (m) => m.rowId === row.id && m.colId === col.id
                                );
                                const v = cell?.winRate;
                                return (
                                  <td key={col.id} className="py-1.5 px-2 text-right">
                                    {v === null || v === undefined ? '—' : `${v.toFixed(1)}%`}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Pairwise Details + Victory Breakdown */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="rounded-lg border border-[#D9C7A3]/15 bg-[#1C1714] p-3 space-y-1.5">
                      <div className="text-xs font-semibold text-[#F6C945]">Matchup Details</div>
                      {benchJob.result.matchups.map((m, i) => (
                        <div key={i} className="text-xs font-mono-num text-[#D9C7A3]">
                          <span className="text-[#F5EFE2]">{m.labelA}</span> vs{' '}
                          <span className="text-[#F5EFE2]">{m.labelB}</span>
                          {m.labelC ? ` vs ${m.labelC}` : ''}: {m.winsA}W-{m.winsB}L
                          {m.labelC ? `-${m.winsC}C` : ''}-{m.draws}D ({(m.winRateA * 100).toFixed(1)}%)
                        </div>
                      ))}
                    </div>

                    <div className="rounded-lg border border-[#D9C7A3]/15 bg-[#1C1714] p-3 space-y-1.5">
                      <div className="text-xs font-semibold text-[#F6C945]">Victory Methods</div>
                      {Object.entries(benchJob.result.reasons)
                        .sort((a, b) => b[1] - a[1])
                        .map(([k, count]) => (
                          <div
                            key={k}
                            className="flex justify-between text-xs font-mono-num text-[#D9C7A3]"
                          >
                            <span>{k}</span>
                            <span className="text-[#F6C945]">
                              {count} (
                              {((count / Math.max(1, benchJob.result!.totalGames)) * 100).toFixed(1)}
                              %)
                            </span>
                          </div>
                        ))}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-[#9E8F7E] py-8 text-center">
                  Add 2 or more models / Heuristic contestants on the left and click Run Benchmark to compare win rates and export PNG summary charts.
                </p>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
};
