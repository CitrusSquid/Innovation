import { parentPort } from 'node:worker_threads';
import { chooseAIAction } from '../src/engine/ai';
import { projectPlayerView } from '../src/engine/playerView';
import { TD_INPUT_SIZE } from '../src/engine/tdFeatures';
import {
  createForwardWorkspace,
  type TDActivation,
  type TDFunnelModel,
} from '../src/engine/tdNetwork';
import { chooseTDActionWithModel } from '../src/engine/tdPlanner';
import {
  getMixedHeuristicSeatSet,
  playFastTrainingEpisode,
  type EpisodeResult,
} from '../src/engine/tdTrainer';
import type { GameVariant } from '../src/engine/types';

export interface SerializedModelPayload {
  variant: GameVariant;
  activation: TDActivation;
  inputSize: number;
  hidden1Size: number;
  hidden2Size: number;
  outputSize: number;
  warmstartGames: number;
  trainedGames: number;
  trainedAt: string;
  w1: Float32Array;
  b1: Float32Array;
  w2: Float32Array;
  b2: Float32Array;
  w3: Float32Array;
  b3: Float32Array;
}

export type WorkerJobRequest =
  | {
      id: number;
      mode: 'warmstart';
      variant: GameVariant;
      seeds: number[];
      recordDistill?: boolean;
    }
  | {
      id: number;
      mode: 'td';
      variant: GameVariant;
      seeds: number[];
      gameIndices: number[];
      epsilon: number;
      temperature: number;
      drawSamples: number;
      dogmaSamples: number;
      model: SerializedModelPayload;
    }
  | {
      id: number;
      mode: 'eval';
      variant: GameVariant;
      gameIndices: number[];
      seedBase: number;
      model: SerializedModelPayload;
    };

export type WorkerJobResponse =
  | {
      id: number;
      mode: 'warmstart' | 'td';
      episodes: Array<{
        seed: number;
        turns: number;
        winnerIds: string[];
        heuristicSeatIds?: string[];
        trajectories: Float32Array[][];
        targets: Float32Array[];
        distillTargets?: Float32Array[][];
      }>;
    }
  | {
      id: number;
      mode: 'eval';
      tdWins: number;
      heuristicWins: number;
      draws: number;
      totalTurns: number;
    };

function makeSeededRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function toRuntimeModel(payload: SerializedModelPayload): TDFunnelModel {
  return {
    ...payload,
  };
}

if (parentPort) {
  const featBuf = new Float32Array(TD_INPUT_SIZE);
  const wsCache = new Map<number, ReturnType<typeof createForwardWorkspace>>();
  const getWs = (outSize: number) => {
    let ws = wsCache.get(outSize);
    if (!ws) {
      ws = createForwardWorkspace(outSize);
      wsCache.set(outSize, ws);
    }
    return ws;
  };

  parentPort.on('message', (req: WorkerJobRequest) => {
    if (req.mode === 'warmstart') {
      const episodes = req.seeds.map((seed) => {
        const ep: EpisodeResult = playFastTrainingEpisode(
          req.variant,
          seed,
          (state, actorId) => chooseAIAction(projectPlayerView(state, actorId)),
          true,
          450,
          Boolean(req.recordDistill)
        );
        return {
          seed,
          turns: ep.turns,
          winnerIds: ep.winnerIds,
          trajectories: ep.trajectories,
          targets: ep.targets,
          ...(ep.distillTargets ? { distillTargets: ep.distillTargets } : {}),
        };
      });
      const resp: WorkerJobResponse = { id: req.id, mode: 'warmstart', episodes };
      parentPort!.postMessage(resp);
      return;
    }

    if (req.mode === 'td') {
      const model = toRuntimeModel(req.model);
      const ws = getWs(model.outputSize);
      const episodes = req.seeds.map((seed, idx) => {
        const gameIdx = req.gameIndices[idx];
        const heuristicSeats = getMixedHeuristicSeatSet(req.variant, gameIdx);
        const rng = makeSeededRng(seed + 777);
        const ep = playFastTrainingEpisode(
          req.variant,
          seed,
          (state, actorId) => {
            const pv = projectPlayerView(state, actorId);
            if (heuristicSeats.has(actorId)) {
              return chooseAIAction(pv);
            }
            return chooseTDActionWithModel(pv, model, undefined, {
              drawSamples: req.drawSamples,
              dogmaSamples: req.dogmaSamples,
              enableOpponentReply: true,
              epsilon: req.epsilon,
              temperature: req.temperature,
              rng,
              featureBuf: featBuf,
              workspace: ws,
            });
          },
          true
        );
        return {
          seed,
          turns: ep.turns,
          winnerIds: ep.winnerIds,
          heuristicSeatIds: Array.from(heuristicSeats),
          trajectories: ep.trajectories,
          targets: ep.targets,
        };
      });
      const resp: WorkerJobResponse = { id: req.id, mode: 'td', episodes };
      parentPort!.postMessage(resp);
      return;
    }

    if (req.mode === 'eval') {
      const model = toRuntimeModel(req.model);
      const ws = getWs(model.outputSize);
      let tdWins = 0;
      let heuristicWins = 0;
      let draws = 0;
      let totalTurns = 0;

      for (const g of req.gameIndices) {
        const pairSeed = req.seedBase + Math.floor(g / 2) * 101;
        const swap = g % 2 === 1;
        const tdIds = new Set<string>();
        if (req.variant === '1v1' || req.variant === '1v1v1') {
          tdIds.add(swap ? 'p2' : 'p1');
        } else {
          if (swap) {
            tdIds.add('p2');
            tdIds.add('p4');
          } else {
            tdIds.add('p1');
            tdIds.add('p3');
          }
        }

        const ep = playFastTrainingEpisode(
          req.variant,
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
        if (ep.winnerIds.length === 0) draws += 1;
        else if (ep.winnerIds.some((id) => tdIds.has(id))) tdWins += 1;
        else heuristicWins += 1;
      }

      const resp: WorkerJobResponse = {
        id: req.id,
        mode: 'eval',
        tdWins,
        heuristicWins,
        draws,
        totalTurns,
      };
      parentPort!.postMessage(resp);
    }
  });
}
