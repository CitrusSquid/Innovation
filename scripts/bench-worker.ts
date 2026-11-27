import { parentPort } from 'node:worker_threads';
import { hydrateTDModel, type TDVariantWeights } from '../src/engine/tdNetwork';
import {
  runHeadlessBenchmarkMatch,
  type BenchmarkMatchResult,
} from '../src/engine/tdBenchmark';
import type { CanonicalAIBackend } from '../src/engine/tdWeights';
import type { GameVariant } from '../src/engine/types';

export interface BenchWorkerTask {
  id: number;
  variant: GameVariant;
  matches: Array<{
    matchIndex: number;
    seed: number;
    playerNames: string[];
    playerAIBackends: CanonicalAIBackend[];
    modelWeightsBySeat?: Array<TDVariantWeights | undefined>;
    captureFinalState?: boolean;
  }>;
  modelWeights?: TDVariantWeights;
}

export interface BenchWorkerResponse {
  id: number;
  results: BenchmarkMatchResult[];
}

if (parentPort) {
  parentPort.on('message', (req: BenchWorkerTask) => {
    const modelOverride = req.modelWeights ? hydrateTDModel(req.modelWeights) : undefined;
    const results = req.matches.map((m) =>
      runHeadlessBenchmarkMatch({
        matchIndex: m.matchIndex,
        variant: req.variant,
        playerNames: m.playerNames,
        playerAIBackends: m.playerAIBackends,
        seed: m.seed,
        modelOverride,
        modelOverridesBySeat: m.modelWeightsBySeat?.map((w) =>
          w ? hydrateTDModel(w) : undefined
        ),
        captureFinalState: m.captureFinalState,
      })
    );
    const resp: BenchWorkerResponse = { id: req.id, results };
    parentPort!.postMessage(resp);
  });
}
