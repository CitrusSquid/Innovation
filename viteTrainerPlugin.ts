import type { Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TD_FEATURE_VERSION } from './src/engine/tdFeatures';
import { validateTDModelBundle, type TDModelBundle, type TDVariantWeights } from './src/engine/tdNetwork';
import type { GameVariant } from './src/engine/types';

const ALL_VARIANTS: readonly GameVariant[] = ['1v1', '1v1v1', '2v2'];

export interface VariantMetaInfo {
  activation: string;
  layerSizes: [number, number, number, number];
  warmstartGames: number;
  trainedGames: number;
  trainedAt: string;
  benchmarkWinRate?: number;
  fileSizeKB: number;
}

export interface StoredModelMeta {
  id: string;
  name: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  resumedFrom?: string;
  variants: Partial<Record<GameVariant, VariantMetaInfo>>;
  lastTrainConfig?: Record<string, unknown>;
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
  result: unknown | null;
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function readJsonBody<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 64 * 1024 * 1024) {
      throw new Error('Request payload exceeds 64MB limit.');
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

function slugifyId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  return `${base || 'td-model'}-${stamp}`;
}

function isSafeModelId(id: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(id) && !id.includes('..');
}

function extractVariantMeta(vw: TDVariantWeights, fileBytes: number): VariantMetaInfo {
  return {
    activation: vw.activation,
    layerSizes: [...vw.layerSizes] as [number, number, number, number],
    warmstartGames: vw.warmstartGames,
    trainedGames: vw.trainedGames,
    trainedAt: vw.trainedAt,
    benchmarkWinRate: vw.benchmarkWinRate,
    fileSizeKB: Number((fileBytes / 1024).toFixed(1)),
  };
}

export function trainerStudioPlugin(): Plugin {
  const rootDir = __dirname;
  const modelsRoot = path.join(rootDir, 'trained-models');
  const dataRoot = path.join(rootDir, 'src', 'data');
  const primaryMarkerPath = path.join(modelsRoot, 'primary.json');

  const getPrimaryModelId = (): string => {
    try {
      if (fs.existsSync(primaryMarkerPath)) {
        const raw = JSON.parse(fs.readFileSync(primaryMarkerPath, 'utf-8')) as {
          primaryModelId?: string;
        };
        if (raw.primaryModelId && fs.existsSync(path.join(modelsRoot, raw.primaryModelId))) {
          return raw.primaryModelId;
        }
      }
    } catch {
      // ignore
    }
    return 'bundled-primary';
  };

  const setPrimaryModelId = (id: string) => {
    fs.mkdirSync(modelsRoot, { recursive: true });
    fs.writeFileSync(
      primaryMarkerPath,
      JSON.stringify({ primaryModelId: id, updatedAt: new Date().toISOString() }, null, 2),
      'utf-8'
    );
  };

  const refreshModelMetaFromDisk = (modelDir: string, fallbackName: string): StoredModelMeta | null => {
    if (!fs.existsSync(modelDir) || !fs.statSync(modelDir).isDirectory()) return null;
    const id = path.basename(modelDir);
    const metaPath = path.join(modelDir, 'meta.json');
    let existing: Partial<StoredModelMeta> = {};
    if (fs.existsSync(metaPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Partial<StoredModelMeta>;
      } catch {
        existing = {};
      }
    }

    const variants: Partial<Record<GameVariant, VariantMetaInfo>> = {};
    for (const v of ALL_VARIANTS) {
      const fPath = path.join(modelDir, `tdWeights.${v}.json`);
      if (!fs.existsSync(fPath)) continue;
      try {
        const rawText = fs.readFileSync(fPath, 'utf-8');
        const checked = validateTDModelBundle(JSON.parse(rawText));
        if (checked.valid && checked.bundle?.variants[v]) {
          variants[v] = extractVariantMeta(checked.bundle.variants[v]!, Buffer.byteLength(rawText));
        }
      } catch {
        // skip corrupt file
      }
    }

    const now = new Date().toISOString();
    const meta: StoredModelMeta = {
      id,
      name: existing.name || fallbackName || id,
      notes: existing.notes ?? '',
      createdAt: existing.createdAt || now,
      updatedAt: existing.updatedAt || now,
      ...(existing.resumedFrom ? { resumedFrom: existing.resumedFrom } : {}),
      ...(existing.lastTrainConfig ? { lastTrainConfig: existing.lastTrainConfig } : {}),
      variants,
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
    return meta;
  };

  const ensureBundledSeeded = () => {
    fs.mkdirSync(modelsRoot, { recursive: true });
    const bundledDir = path.join(modelsRoot, 'bundled-primary');
    if (!fs.existsSync(bundledDir)) {
      fs.mkdirSync(bundledDir, { recursive: true });
      for (const v of ALL_VARIANTS) {
        const src = path.join(dataRoot, `tdWeights.${v}.json`);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(bundledDir, `tdWeights.${v}.json`));
        }
      }
      const meta: StoredModelMeta = {
        id: 'bundled-primary',
        name: 'Bundled Primary (Default)',
        notes: 'Initial bundled weights snapshot preserved before custom training runs.',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        variants: {},
      };
      fs.writeFileSync(path.join(bundledDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
      refreshModelMetaFromDisk(bundledDir, meta.name);
      if (!fs.existsSync(primaryMarkerPath)) {
        setPrimaryModelId('bundled-primary');
      }
    }
  };

  const listAllModels = (): { primaryModelId: string; models: StoredModelMeta[] } => {
    ensureBundledSeeded();
    const primaryModelId = getPrimaryModelId();
    const entries = fs.readdirSync(modelsRoot, { withFileTypes: true });
    const models: StoredModelMeta[] = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const meta = refreshModelMetaFromDisk(path.join(modelsRoot, ent.name), ent.name);
      if (meta) models.push(meta);
    }
    models.sort((a, b) => {
      if (a.id === primaryModelId) return -1;
      if (b.id === primaryModelId) return 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    return { primaryModelId, models };
  };

  const resolveTsxCommand = (): { cmd: string; prefixArgs: string[]; useShell: boolean } => {
    // Run tsx's JS CLI directly via the active Node binary with shell: false.
    // This prevents Windows cmd.exe from splitting project paths that contain spaces
    // or parentheses (e.g. "my-project (1)") when invoking .cmd shims.
    const tsxPkgPath = path.join(rootDir, 'node_modules', 'tsx', 'package.json');
    if (fs.existsSync(tsxPkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(tsxPkgPath, 'utf-8')) as {
          bin?: string | Record<string, string>;
        };
        const relBin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.tsx;
        if (relBin) {
          const cliPath = path.resolve(path.dirname(tsxPkgPath), relBin);
          if (fs.existsSync(cliPath)) {
            return { cmd: process.execPath, prefixArgs: [cliPath], useShell: false };
          }
        }
      } catch {
        // Fall through to direct cli.mjs check
      }
    }
    const directCli = path.join(rootDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (fs.existsSync(directCli)) {
      return { cmd: process.execPath, prefixArgs: [directCli], useShell: false };
    }
    if (process.platform !== 'win32') {
      const localBin = path.join(rootDir, 'node_modules', '.bin', 'tsx');
      if (fs.existsSync(localBin)) {
        return { cmd: localBin, prefixArgs: [], useShell: false };
      }
      return { cmd: 'npx', prefixArgs: ['tsx'], useShell: false };
    }
    return { cmd: 'npx.cmd', prefixArgs: ['tsx'], useShell: true };
  };

  let activeTrainChild: ChildProcess | null = null;
  let trainCancelRequested = false;
  let trainJob: TrainJobState | null = null;

  let activeBenchChild: ChildProcess | null = null;
  let benchJob: BenchmarkJobState | null = null;

  const parseProgressLine = (variant: GameVariant, line: string): TrainMetricPoint | null => {
    // Matches: [1v1] td-selfplay 100/2000 | loss=0.1234 (win=0.1100) | avgTurns=22.5 | vsHeur 18W-11L-1D (61.7%) | ...
    const m = /\[(1v1v1|1v1|2v2)\]\s+(warmstart|td-selfplay)\s+(\d+)\/(\d+)\s+\|\s+loss=([\d.]+)\s+\(win=([\d.]+)\)\s+\|\s+avgTurns=([\d.]+)/.exec(
      line
    );
    if (!m) return null;
    const vsHeur = /vsHeur\s+\d+W-\d+L-\d+D\s+\(([\d.]+)%\)/.exec(line);
    return {
      variant: (m[1] as GameVariant) || variant,
      phase: m[2] as 'warmstart' | 'td-selfplay',
      done: Number(m[3]),
      total: Number(m[4]),
      loss: Number(m[5]),
      windowLoss: Number(m[6]),
      avgTurns: Number(m[7]),
      ...(vsHeur ? { vsHeurRate: Number(vsHeur[1]) / 100 } : {}),
    };
  };

  return {
    name: 'td-trainer-studio-dev-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const rawUrl = req.url ?? '';
        if (!rawUrl.startsWith('/__trainer_api/')) {
          return next();
        }
        const [pathname] = rawUrl.split('?');
        const method = (req.method ?? 'GET').toUpperCase();

        try {
          if (pathname === '/__trainer_api/system' && method === 'GET') {
            return sendJson(res, 200, {
              cpuCount: os.cpus().length,
              defaultTrainWorkers: Math.min(4, Math.max(1, os.cpus().length)),
              defaultBenchWorkers: Math.min(8, Math.max(1, os.cpus().length - 1 || 1)),
            });
          }

          if (pathname === '/__trainer_api/models' && method === 'GET') {
            return sendJson(res, 200, listAllModels());
          }

          if (pathname === '/__trainer_api/models/import' && method === 'POST') {
            const body = await readJsonBody<{
              name?: string;
              notes?: string;
              bundles?: Array<{ fileName?: string; content: string }>;
            }>(req);

            if (!body.bundles || body.bundles.length === 0) {
              return sendJson(res, 400, { error: 'No weight JSON files provided.' });
            }

            const mergedVariants: Partial<Record<GameVariant, TDVariantWeights>> = {};
            for (const b of body.bundles) {
              const checked = validateTDModelBundle(JSON.parse(b.content));
              if (!checked.valid || !checked.bundle) {
                return sendJson(res, 400, {
                  error: `${b.fileName || 'Bundle'}: ${checked.error ?? 'Invalid bundle'}`,
                });
              }
              Object.assign(mergedVariants, checked.bundle.variants);
            }

            const variantKeys = Object.keys(mergedVariants) as GameVariant[];
            if (variantKeys.length === 0) {
              return sendJson(res, 400, { error: 'Imported JSON contains no valid variants.' });
            }

            const modelName = (body.name || 'Imported Model').trim();
            const id = slugifyId(modelName);
            const dir = path.join(modelsRoot, id);
            fs.mkdirSync(dir, { recursive: true });

            for (const v of variantKeys) {
              const singleBundle: TDModelBundle = {
                schemaVersion: 1,
                featureVersion: TD_FEATURE_VERSION,
                variants: { [v]: mergedVariants[v]! },
              };
              fs.writeFileSync(
                path.join(dir, `tdWeights.${v}.json`),
                JSON.stringify(singleBundle),
                'utf-8'
              );
            }

            const now = new Date().toISOString();
            const meta: StoredModelMeta = {
              id,
              name: modelName,
              notes: (body.notes || '').trim(),
              createdAt: now,
              updatedAt: now,
              variants: {},
            };
            fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
            const refreshed = refreshModelMetaFromDisk(dir, modelName);
            return sendJson(res, 200, { model: refreshed, ...listAllModels() });
          }

          const modelActionMatch = /^\/__trainer_api\/models\/([^/]+)\/([a-z-]+)(?:\/(1v1v1|1v1|2v2))?$/.exec(
            pathname
          );
          if (modelActionMatch) {
            const modelId = decodeURIComponent(modelActionMatch[1]);
            if (!isSafeModelId(modelId)) {
              return sendJson(res, 400, { error: 'Invalid model ID.' });
            }
            const action = modelActionMatch[2];
            const variantArg = modelActionMatch[3] as GameVariant | undefined;
            const modelDir = path.join(modelsRoot, modelId);

            if (!fs.existsSync(modelDir)) {
              return sendJson(res, 404, { error: `Model "${modelId}" not found.` });
            }

            if (action === 'set-primary' && method === 'POST') {
              let copiedCount = 0;
              for (const v of ALL_VARIANTS) {
                const src = path.join(modelDir, `tdWeights.${v}.json`);
                if (fs.existsSync(src)) {
                  fs.copyFileSync(src, path.join(dataRoot, `tdWeights.${v}.json`));
                  copiedCount += 1;
                }
              }
              if (copiedCount === 0) {
                return sendJson(res, 400, {
                  error: 'Model has no valid variant weights to promote to primary.',
                });
              }
              setPrimaryModelId(modelId);
              return sendJson(res, 200, {
                ok: true,
                copiedVariants: copiedCount,
                ...listAllModels(),
              });
            }

            if (action === 'clone' && method === 'POST') {
              const body = await readJsonBody<{ name?: string; notes?: string }>(req);
              const srcMeta = refreshModelMetaFromDisk(modelDir, modelId);
              const newName = (body.name || `${srcMeta?.name || modelId} Copy`).trim();
              const newId = slugifyId(newName);
              const newDir = path.join(modelsRoot, newId);
              fs.mkdirSync(newDir, { recursive: true });
              for (const v of ALL_VARIANTS) {
                const src = path.join(modelDir, `tdWeights.${v}.json`);
                if (fs.existsSync(src)) {
                  fs.copyFileSync(src, path.join(newDir, `tdWeights.${v}.json`));
                }
              }
              const now = new Date().toISOString();
              const meta: StoredModelMeta = {
                id: newId,
                name: newName,
                notes: (body.notes ?? srcMeta?.notes ?? '').trim(),
                createdAt: now,
                updatedAt: now,
                resumedFrom: modelId,
                variants: {},
              };
              fs.writeFileSync(path.join(newDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
              const refreshed = refreshModelMetaFromDisk(newDir, newName);
              return sendJson(res, 200, { model: refreshed, ...listAllModels() });
            }

            if (action === 'rename' && method === 'POST') {
              const body = await readJsonBody<{ name?: string; notes?: string }>(req);
              const meta = refreshModelMetaFromDisk(modelDir, modelId);
              if (!meta) return sendJson(res, 404, { error: 'Model metadata not found.' });
              if (body.name?.trim()) meta.name = body.name.trim();
              if (body.notes !== undefined) meta.notes = body.notes.trim();
              meta.updatedAt = new Date().toISOString();
              fs.writeFileSync(path.join(modelDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
              return sendJson(res, 200, { model: meta, ...listAllModels() });
            }

            if (action === 'export' && method === 'GET' && variantArg) {
              const fPath = path.join(modelDir, `tdWeights.${variantArg}.json`);
              if (!fs.existsSync(fPath)) {
                return sendJson(res, 404, { error: `Variant ${variantArg} not present.` });
              }
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.setHeader(
                'Content-Disposition',
                `attachment; filename="${modelId}.tdWeights.${variantArg}.json"`
              );
              res.end(fs.readFileSync(fPath, 'utf-8'));
              return;
            }
          }

          const deleteMatch = /^\/__trainer_api\/models\/([^/]+)$/.exec(pathname);
          if (deleteMatch && method === 'DELETE') {
            const modelId = decodeURIComponent(deleteMatch[1]);
            if (!isSafeModelId(modelId)) {
              return sendJson(res, 400, { error: 'Invalid model ID.' });
            }
            if (modelId === getPrimaryModelId()) {
              return sendJson(res, 400, {
                error: 'Cannot delete the active Primary model. Select another Primary model first.',
              });
            }
            const modelDir = path.join(modelsRoot, modelId);
            if (!fs.existsSync(modelDir)) {
              return sendJson(res, 404, { error: 'Model not found.' });
            }
            fs.rmSync(modelDir, { recursive: true, force: true });
            return sendJson(res, 200, listAllModels());
          }

          // Start TD training into a brand new model folder (never deleting previous weights!)
          if (pathname === '/__trainer_api/train/start' && method === 'POST') {
            if (activeTrainChild || trainJob?.running) {
              return sendJson(res, 409, { error: 'A training job is already running.' });
            }

            const body = await readJsonBody<{
              modelName?: string;
              notes?: string;
              resumeModelId?: string;
              variant?: GameVariant | 'all';
              activation?: 'tanh' | 'leaky_relu';
              warmstartGames?: number;
              games?: number;
              lambda?: number;
              alpha?: number;
              warmstartAlpha?: number;
              batchSize?: number;
              distillWeight?: number;
              evalGames?: number;
              workers?: number;
              seed?: number;
              logEvery?: number;
              evalOnly?: boolean;
            }>(req);

            if (body.resumeModelId && !isSafeModelId(body.resumeModelId)) {
              return sendJson(res, 400, { error: 'Invalid resume model ID.' });
            }

            ensureBundledSeeded();
            const variants: GameVariant[] =
              !body.variant || body.variant === 'all' ? ['1v1', '1v1v1', '2v2'] : [body.variant];

            const modelName = (body.modelName || `TD Run (${variants.join(',')})`).trim();
            const modelId = slugifyId(modelName);
            const targetDir = path.join(modelsRoot, modelId);
            fs.mkdirSync(targetDir, { recursive: true });

            // If resuming from an existing model, pre-copy any un-trained variants so the new model keeps complete coverage
            const resumeDir = body.resumeModelId ? path.join(modelsRoot, body.resumeModelId) : null;
            if (resumeDir && fs.existsSync(resumeDir)) {
              for (const v of ALL_VARIANTS) {
                const srcFile = path.join(resumeDir, `tdWeights.${v}.json`);
                if (fs.existsSync(srcFile)) {
                  fs.copyFileSync(srcFile, path.join(targetDir, `tdWeights.${v}.json`));
                }
              }
            }

            const now = new Date().toISOString();
            const initialMeta: StoredModelMeta = {
              id: modelId,
              name: modelName,
              notes: (body.notes ?? '').trim(),
              createdAt: now,
              updatedAt: now,
              ...(body.resumeModelId ? { resumedFrom: body.resumeModelId } : {}),
              lastTrainConfig: body,
              variants: {},
            };
            fs.writeFileSync(
              path.join(targetDir, 'meta.json'),
              JSON.stringify(initialMeta, null, 2),
              'utf-8'
            );

            trainCancelRequested = false;
            trainJob = {
              id: `train_${Date.now()}`,
              running: true,
              modelId,
              modelName,
              variants,
              currentVariant: variants[0] ?? null,
              startedAt: now,
              finishedAt: null,
              exitCode: null,
              error: null,
              logs: [
                `Starting training into new model "${modelName}" (${modelId})`,
                body.resumeModelId
                  ? `Resuming from existing model "${body.resumeModelId}" (existing weights preserved untouched)`
                  : 'Initializing fresh funnel weights (existing weights untouched)',
              ],
              metrics: [],
              latestProgress: null,
            };

            const { cmd, prefixArgs, useShell } = resolveTsxCommand();
            const runSequence = async () => {
              try {
                for (let i = 0; i < variants.length; i++) {
                  if (trainCancelRequested) break;
                  const v = variants[i];
                  if (trainJob) trainJob.currentVariant = v;

                  const outPath = path.join(targetDir, `tdWeights.${v}.json`);
                  const args = [
                    ...prefixArgs,
                    path.join(rootDir, 'scripts', 'train-td.ts'),
                    '--variant',
                    v,
                    '--activation',
                    body.activation ?? 'tanh',
                    '--warmstart-games',
                    String(Math.max(0, Math.floor(body.warmstartGames ?? 5000))),
                    '--games',
                    String(Math.max(0, Math.floor(body.games ?? 2000))),
                    '--lambda',
                    String(body.lambda ?? 0.7),
                    '--alpha',
                    String(body.alpha ?? 0.0003),
                    '--warmstart-alpha',
                    String(body.warmstartAlpha ?? 0.0008),
                    '--batch-size',
                    String(Math.max(1, Math.floor(body.batchSize ?? 32))),
                    '--distill',
                    String(body.distillWeight ?? 0.55),
                    '--eval-games',
                    String(Math.max(0, Math.floor(body.evalGames ?? 40))),
                    '--workers',
                    String(Math.max(1, Math.floor(body.workers ?? Math.min(4, os.cpus().length)))),
                    '--seed',
                    String(Math.floor((body.seed ?? 202611) + i * 10000)),
                    '--log-every',
                    String(Math.max(1, Math.floor(body.logEvery ?? 100))),
                    '--log-file',
                    path.join(targetDir, 'tdTraining.log'),
                    '--out',
                    outPath,
                  ];

                  if (resumeDir && fs.existsSync(path.join(resumeDir, `tdWeights.${v}.json`))) {
                    args.push('--resume', path.join(resumeDir, `tdWeights.${v}.json`));
                  }
                  if (body.evalOnly) {
                    args.push('--eval-only');
                  }

                  const code = await new Promise<number>((resolve) => {
                    let settled = false;
                    const finish = (exitCode: number) => {
                      if (settled) return;
                      settled = true;
                      activeTrainChild = null;
                      resolve(exitCode);
                    };

                    const child = spawn(cmd, args, {
                      cwd: rootDir,
                      shell: useShell,
                      stdio: ['ignore', 'pipe', 'pipe'],
                    });
                    activeTrainChild = child;

                    let buf = '';
                    const handleText = (chunk: Buffer) => {
                      buf += chunk.toString('utf-8');
                      const lines = buf.split(/\r?\n/);
                      buf = lines.pop() ?? '';
                      for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || !trainJob) continue;
                        trainJob.logs.push(trimmed);
                        if (trainJob.logs.length > 500) {
                          trainJob.logs.splice(0, trainJob.logs.length - 500);
                        }
                        const pt = parseProgressLine(v, trimmed);
                        if (pt) {
                          trainJob.latestProgress = pt;
                          trainJob.metrics.push(pt);
                          if (trainJob.metrics.length > 600) {
                            trainJob.metrics.splice(0, trainJob.metrics.length - 600);
                          }
                        }
                      }
                    };

                    child.stdout?.on('data', handleText);
                    child.stderr?.on('data', handleText);
                    child.on('error', (err) => {
                      if (trainJob) {
                        trainJob.logs.push(`Failed to launch trainer: ${err.message}`);
                      }
                      finish(1);
                    });
                    child.on('close', (exitCode) => {
                      if (buf.trim() && trainJob) {
                        trainJob.logs.push(buf.trim());
                      }
                      finish(exitCode ?? 1);
                    });
                  });

                  if (code !== 0) {
                    if (trainJob) {
                      trainJob.exitCode = code;
                      trainJob.error = trainCancelRequested
                        ? 'Training cancelled by user.'
                        : `Trainer exited with code ${code} on variant ${v}.`;
                    }
                    break;
                  }

                  refreshModelMetaFromDisk(targetDir, modelName);
                }

                if (trainJob) {
                  refreshModelMetaFromDisk(targetDir, modelName);
                  if (trainJob.exitCode === null) {
                    trainJob.exitCode = trainCancelRequested ? 130 : 0;
                  }
                  if (trainCancelRequested && !trainJob.error) {
                    trainJob.error = 'Training cancelled by user.';
                  }
                  trainJob.running = false;
                  trainJob.finishedAt = new Date().toISOString();
                }
              } catch (err) {
                if (trainJob) {
                  trainJob.running = false;
                  trainJob.finishedAt = new Date().toISOString();
                  trainJob.exitCode = 1;
                  trainJob.error = err instanceof Error ? err.message : String(err);
                }
              }
            };

            void runSequence();
            return sendJson(res, 200, trainJob);
          }

          if (pathname === '/__trainer_api/train/status' && method === 'GET') {
            return sendJson(res, 200, { job: trainJob });
          }

          if (pathname === '/__trainer_api/train/stop' && method === 'POST') {
            trainCancelRequested = true;
            if (activeTrainChild) {
              activeTrainChild.kill('SIGTERM');
            }
            return sendJson(res, 200, { ok: true, job: trainJob });
          }

          if (pathname === '/__trainer_api/benchmark/start' && method === 'POST') {
            if (activeBenchChild || benchJob?.running) {
              return sendJson(res, 409, { error: 'A benchmark job is already running.' });
            }

            const body = await readJsonBody<{
              mode: 'matchup' | 'gauntlet' | 'round-robin';
              variant: GameVariant;
              games: number;
              seed?: number;
              workers?: number;
              contestants: Array<{
                id: string;
                label: string;
                backend: string;
                modelId?: string;
              }>;
            }>(req);

            if (!body.contestants || body.contestants.length < 2) {
              return sendJson(res, 400, { error: 'Select at least 2 contestants to compare.' });
            }

            const resolvedContestants = body.contestants.map((c) => {
              let weightsPath: string | undefined;
              if (c.backend !== 'heuristic' && c.modelId) {
                weightsPath = path.join(modelsRoot, c.modelId, `tdWeights.${body.variant}.json`);
              }
              return {
                id: c.id,
                label: c.label,
                backend: c.backend,
                ...(weightsPath ? { weightsPath } : {}),
              };
            });

            fs.mkdirSync(modelsRoot, { recursive: true });
            const jobCfgPath = path.join(modelsRoot, '.last-benchmark-job.json');
            fs.writeFileSync(
              jobCfgPath,
              JSON.stringify(
                {
                  mode: body.mode || 'matchup',
                  variant: body.variant || '1v1',
                  games: Math.max(2, Math.floor(body.games || 40)),
                  seed: Math.floor(body.seed ?? 202611),
                  workers: Math.max(
                    1,
                    Math.floor(body.workers ?? Math.min(8, Math.max(1, os.cpus().length - 1 || 1)))
                  ),
                  contestants: resolvedContestants,
                },
                null,
                2
              ),
              'utf-8'
            );

            benchJob = {
              id: `bench_${Date.now()}`,
              running: true,
              startedAt: new Date().toISOString(),
              finishedAt: null,
              exitCode: null,
              error: null,
              progress: {
                doneGames: 0,
                totalGames: Math.max(2, Math.floor(body.games || 40)),
                pairIndex: 1,
                totalPairs: 1,
                pairLabel: 'Starting...',
              },
              logs: [`Running ${body.mode} benchmark (${body.variant}, ${body.games} games/pair)`],
              result: null,
            };

            const { cmd, prefixArgs, useShell } = resolveTsxCommand();
            const child = spawn(
              cmd,
              [
                ...prefixArgs,
                path.join(rootDir, 'scripts', 'compare-models.ts'),
                '--config',
                jobCfgPath,
              ],
              {
                cwd: rootDir,
                shell: useShell,
                stdio: ['ignore', 'pipe', 'pipe'],
              }
            );
            activeBenchChild = child;

            let buf = '';
            const handleChunk = (chunk: Buffer) => {
              buf += chunk.toString('utf-8');
              const lines = buf.split(/\r?\n/);
              buf = lines.pop() ?? '';
              for (const line of lines) {
                if (!benchJob) continue;
                if (line.startsWith('__COMPARE_JSON__')) {
                  try {
                    const msg = JSON.parse(line.slice('__COMPARE_JSON__'.length)) as {
                      type: string;
                      payload: unknown;
                    };
                    if (msg.type === 'progress') {
                      benchJob.progress = msg.payload as BenchmarkJobState['progress'];
                    } else if (msg.type === 'result') {
                      benchJob.result = msg.payload;
                    }
                  } catch {
                    // ignore malformed line
                  }
                } else if (line.trim()) {
                  benchJob.logs.push(line.trim());
                }
              }
            };

            child.stdout?.on('data', handleChunk);
            child.stderr?.on('data', handleChunk);
            child.on('error', (err) => {
              activeBenchChild = null;
              if (!benchJob) return;
              benchJob.logs.push(`Failed to launch benchmark: ${err.message}`);
              benchJob.running = false;
              benchJob.finishedAt = new Date().toISOString();
              benchJob.exitCode = 1;
              benchJob.error = err.message;
            });
            child.on('close', (code) => {
              activeBenchChild = null;
              if (!benchJob) return;
              benchJob.running = false;
              benchJob.finishedAt = new Date().toISOString();
              benchJob.exitCode = code ?? 1;
              if (code !== 0 && !benchJob.error) {
                benchJob.error =
                  benchJob.logs[benchJob.logs.length - 1] ||
                  `Benchmark exited with code ${code ?? 1}.`;
              }
            });

            return sendJson(res, 200, benchJob);
          }

          if (pathname === '/__trainer_api/benchmark/status' && method === 'GET') {
            return sendJson(res, 200, { job: benchJob });
          }

          if (pathname === '/__trainer_api/benchmark/stop' && method === 'POST') {
            if (activeBenchChild) {
              activeBenchChild.kill('SIGTERM');
            }
            if (benchJob) {
              benchJob.running = false;
              benchJob.finishedAt = new Date().toISOString();
              benchJob.error = 'Benchmark cancelled by user.';
            }
            return sendJson(res, 200, { ok: true, job: benchJob });
          }

          return sendJson(res, 404, { error: 'Unknown trainer API endpoint.' });
        } catch (err) {
          return sendJson(res, 500, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    },
  };
}
