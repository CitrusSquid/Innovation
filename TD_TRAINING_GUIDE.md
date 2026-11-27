# TD(λ) Neural Network Training & Benchmarking Guide (v1.7)

This project includes a custom TypeScript Temporal-Difference (`TD(λ)`) neural evaluator (`1,229 -> 192 -> 80 -> 2/3` funnel MLP, `featureVersion: 3`) trained with mini-batch Adam (`batchSize = 32`), Heuristic value distillation during warm-start, 100% unpruned weights, and TD-native prompt + 1-ply / two-step expectiminimax lookahead.

You can also launch the standalone web GUI (`trainer.html`) in development mode with `npm run train:gui`.

---

## 1. Output & Log Files

By default, training writes **one unpruned weight file per game mode** (each saved immediately as soon as that mode finishes) plus a timestamped log file:

* `src/data/tdWeights.1v1.json` — `1v1` weights (`~2.0 MB` once trained)
* `src/data/tdWeights.1v1v1.json` — `1v1v1` weights (`~2.0 MB` once trained)
* `src/data/tdWeights.2v2.json` — `2v2` weights (`~2.0 MB` once trained)
* `src/data/tdTraining.log` — Persistent timestamped log of every 100-game checkpoint, Arena result, and file save

Each file uses the exact same bundle schema (`schemaVersion: 1`, `featureVersion: 3`) and is automatically bundled when building the app, or can be hot-loaded in the UI under **About → AI → TD AI Weights → Import Weights JSON** (multi-select is supported to load all 3 files at once).

---

## 2. Common CLI Commands

### Full Maximum-Strength Overnight Run (All 3 Modes)
Trains `1v1`, `1v1v1`, and `2v2` from scratch, saving each file as soon as its mode completes, using worker threads (e.g., `14` on a 16-core CPU) and benchmarking 200 paired Arena games per mode:

```powershell
npm run train:td -- --variant all --warmstart-games 10000 --games 6000 --lambda 0.7 --eval-games 200 --workers 14
```

> **Tip:** Disable Windows Sleep/Hibernate before leaving an unattended multi-hour run. Even if interrupted during `1v1v1` or `2v2`, any already-completed mode is already saved to its own JSON file.

### Train a Single Mode
```powershell
npm run train:td -- --variant 1v1 --warmstart-games 10000 --games 6000 --lambda 0.7 --eval-games 200 --workers 14
```

### Benchmark Existing Weights (`--eval-only`)
Automatically reads `src/data/tdWeights.1v1.json`, `tdWeights.1v1v1.json`, and `tdWeights.2v2.json`:

```powershell
npm run train:td -- --variant all --eval-only --eval-games 400 --workers 14
```

Benchmark a specific file:
```powershell
npm run train:td -- --variant 1v1 --eval-only --eval-games 1000 --resume src/data/tdWeights.1v1.json --workers 14
```

### Continue Training From Existing v3 Weights (`--resume`)
You can run additional TD self-play games (`--warmstart-games 0`) on top of an already-trained v3 file:

```powershell
npm run train:td -- --variant 1v1 --warmstart-games 0 --games 3000 --alpha 0.00015 --eval-games 200 --workers 14
```

*(Note: When `--resume` is omitted, the trainer already auto-loads existing valid v3 weights from `src/data/tdWeights.<variant>.json`. To force a clean retrain from random weights, delete or move that variant's JSON file first or use a fresh `--out` path.)*

---

## 3. CLI Flags Reference

| Flag | Default | Description |
| :--- | :--- | :--- |
| `--variant` | `all` | Mode to train or evaluate: `1v1`, `1v1v1`, `2v2`, or `all`. |
| `--warmstart-games` | `5000` | Full-strength Heuristic games used to pretrain the value network before self-play. Set `0` when continuing TD self-play. |
| `--games` | `2000` | Number of TD(λ) self-play games (includes 30% alternating full-Heuristic league games). |
| `--lambda` | `0.7` | TD(λ) trace parameter (`0.0` = pure 1-step bootstrap, `1.0` = pure game outcome Monte-Carlo). |
| `--alpha` | `0.0003` | Peak mini-batch Adam learning rate for TD self-play (anneals down to `15%` over the run). |
| `--warmstart-alpha` | `0.0008` | Peak mini-batch Adam learning rate during Heuristic warm-start. |
| `--batch-size` | `32` | Mini-batch size for gradient averaging before each Adam optimizer step. |
| `--distill` | `0.55` | Heuristic value distillation blend (`0..1`) during warm-start (`(1-w)*TD + w*softmax(H/40)`). |
| `--activation` | `tanh` | Hidden-layer activation (`tanh` or `leaky_relu`). |
| `--eval-games` | `40` | Number of paired mirror-seed Arena games vs. Heuristic AI (`0` skips evaluation). |
| `--workers` | `min(4, CPUs)` | Number of Node worker threads. Match your PC's CPU threads minus 1–2 (e.g., `14` on 16 cores) for maximum throughput. |
| `--log-every` | `100` | Print and append window metrics every `N` games. |
| `--log-file` | `src/data/tdTraining.log` | Path for persistent timestamped logs (pass `--log-file none` to disable file logging). |
| `--out` | `src/data/tdWeights.<variant>.json` | Override output path. Without `--out`, each mode saves to its own file immediately after finishing. |
| `--resume` | *(auto)* | Explicit weights JSON file to load before training or evaluating. |
| `--eval-only` | `false` | Skip training and run only the Arena benchmark vs. Heuristic AI. |
| `--seed` | `202611` | Base deterministic RNG seed (`seed` increments per variant/phase). |

---

## 4. Reading the Live Output & Arena Scores

### During Warm-Start (every 100 games)
```text
[1v1] warmstart 500/10000 | loss=0.4512 (win=0.4390) | avgTurns=49.3 | P1=51 P2=48 D=1 | 1m42s | ETA 32m18s
```
* **`loss=... (win=...)`**: Cumulative softmax cross-entropy loss across the whole phase, and (`win=`) the loss just in this latest 100-game block. Should trend smoothly downward (`~0.55 -> ~0.40` in 1v1).
* **`avgTurns`**: Average turn length of games in this window (~40–55 turns is healthy; sudden spikes toward 200+ can indicate stalling).
* **`P1=... P2=... D=...`** (`TeamA/TeamB` in `2v2`, `P1/P2/P3` in `1v1v1`): Seat win distribution across the Heuristic self-play games in this window (verifies going first/second balance).
* **`ETA`**: Estimated remaining time for the current phase.

### During TD Self-Play (every 100 games)
```text
[1v1] td-selfplay 600/5000 | loss=0.4180 (win=0.4025) | avgTurns=47.1 | vsHeur 18W-12L-0D (60.0%) | self(P1=36 P2=34 D=0) | 4m15s | ETA 31m10s
```
* **`vsHeur ...W-...L-...D (...%)`**: **Your best live progress indicator.** Every 100 games includes ~30 mixed-league games pitting the current TD net directly against full-strength Heuristic AI (alternating going first/second). Watch this percentage trend upward across training.
* **`self(...)`**: Win distribution among pure TD-vs-TD games in that window. Should stay roughly balanced across seats (`~50/50` in `1v1` and `2v2`, `~33/33/33` in `1v1v1`).

### Arena Benchmark & Parity Baselines
```text
[1v1] Arena: TD 118W - 80L - 2D (59.5% ± 6.8%, avg 48.6 turns)
```
The Arena swaps seats on identical paired seeds so deck shuffles cancel out, and evaluates the **post-serialization weights** (exact weights written to JSON):

* **Win Rate Formula:** `(tdWins + 0.5 * draws) / totalGames`
* **Confidence Interval (`± X.X%`):** 95% confidence interval (`1.96 * sqrt(p*(1-p)/N)`). Once the lower bound beats parity, the improvement is statistically solid.
* **Parity (Equal Strength vs. Heuristic AI) by Mode:**
  * **`1v1`:** **`50.0%`** (1 TD seat vs. 1 Heuristic seat) — >50% means TD beats Heuristic.
  * **`2v2`:** **`50.0%`** (2 TD teammates vs. 2 Heuristic teammates) — >50% means TD team beats Heuristic team.
  * **`1v1v1`:** **`33.3%`** (1 TD seat vs. **2** Heuristic seats) — >33.3% means TD outperforms the average Heuristic bot in 3-player free-for-all (`40%+` is a strong lead).

---

## 5. Backing Up & Using Trained Weights in the App

1. **Backup**: Copy `src/data/tdWeights.1v1.json`, `src/data/tdWeights.1v1v1.json`, and `src/data/tdWeights.2v2.json` before starting a new experimental run.
2. **Test immediately without rebuilding**: Open the app → **About → AI → TD AI Weights → Import Weights JSON**, select one, two, or all three JSON files at once, and they apply immediately in browser storage.
3. **Bake into builds**: Because the weight files live in `src/data/`, running `npm run build` automatically bundles your newly trained weights directly into `dist/index.html`.

---

## 6. Benchmarking AI Tiers (`npm run bench:ai`)

In addition to the in-app **About → AI → AI Arena** runner, you can run fast, multi-threaded CLI benchmarks across any of the 5 AI difficulty tiers:

* **`heuristic`** *(aliases: `heur`, `h`)* — Rule-based Heuristic AI
* **`td_easy`** *(aliases: `easy`, `easy_td`)* — Softmax TD sampling (`T = 1.65`, `8%` exploration), no lookahead
* **`td_medium`** *(aliases: `medium`, `med`, `medium_td`)* — Softmax TD sampling (`T = 0.7`), no lookahead
* **`td_hard`** *(aliases: `hard`, `hard_td`)* — Mild Softmax TD sampling (`T = 0.22`) with expectiminimax lookahead
* **`td_full`** *(aliases: `full`, `full_td`, `td`)* — Completely greedy TD selection (`T = 0`) with full expectiminimax lookahead

### Benchmark Modes

#### 1. Head-to-Head Matchup (`--mode matchup`, default)
Pit one AI directly against another AI (or specify `--ai3` for a 3-way `1v1v1` lineup):
```powershell
npm run bench:ai -- --mode matchup --variant 1v1 --ai1 td_full --ai2 heuristic --games 200 --workers 14
```
In `1v1v1`, you can pit three distinct AIs against each other:
```powershell
npm run bench:ai -- --mode matchup --variant 1v1v1 --ai1 td_full --ai2 td_hard --ai3 heuristic --games 120 --workers 14
```

#### 2. Ordered Gauntlet (`--mode gauntlet`)
Test one primary challenger (`--ai1` / `--challenger`) sequentially against an ordered list of opponents (`--opponents`):
```powershell
npm run bench:ai -- --mode gauntlet --variant 1v1 --ai1 td_full --opponents td_easy,td_medium,td_hard,heuristic --games 100 --workers 14
```

#### 3. Round-Robin Tournament (`--mode round-robin`)
Run every pair in `--ais` in order and print both per-pairing stats and an overall leaderboard + win-rate matrix + aggregate victory summary:
```powershell
npm run bench:ai -- --mode round-robin --variant 1v1 --ais heuristic,td_easy,td_medium,td_hard,td_full --games 100 --workers 14
```

### Benchmark CLI Flags

| Flag | Default | Description |
| :--- | :--- | :--- |
| `--mode` | `matchup` | Benchmark mode: `matchup`, `gauntlet`, or `round-robin`. |
| `--variant` | `1v1` | Game mode: `1v1`, `1v1v1`, or `2v2`. |
| `--games` | `40` | Games per pairing (paired seat swaps across identical seeds eliminate first-player and deck-shuffle bias). |
| `--ai1` / `--challenger` | `td_full` | Primary AI tier for `matchup` and `gauntlet`. |
| `--ai2` | `heuristic` | Opponent AI tier for `matchup`. |
| `--ai3` | *(`--ai2`)* | Optional 3rd seat AI tier in `1v1v1` `matchup` mode. |
| `--opponents` | all other tiers | Comma-separated ordered opponent list for `gauntlet`. |
| `--ais` | all 5 tiers | Comma-separated ordered list of participants for `round-robin`. |
| `--weights` | *(bundled)* | Optional path to a custom TD weights JSON bundle to test before overwriting `src/data/`. |
| `--workers` | `min(8, CPUs - 1)` | Number of Node worker threads (e.g., `14` on a 16-core CPU). |
| `--seed` | `202611` | Base deterministic seed for reproducible comparisons. |
| `--snapshot-every` | `0` *(off)* | Save an HTML end-game board snapshot every `X` games (`1` saves every game). |
| `--snapshot-dir` | `benchmark-snapshots` | Directory where end-game HTML snapshots are stored. |
| `--snapshot-max` | `1000` | Maximum number of `.html` snapshots kept in `--snapshot-dir` (oldest files erased first; `0` = unlimited). |

### Interpreting Benchmark Output
* **Paired fairness & live progress**: In `1v1` and `2v2`, seats alternate (`P1/P2` or `Team A/Team B`) across paired seeds; in `1v1v1`, seats rotate across 3-game seed blocks. While running, each pairing displays live game count, running win %, and average turns.
* **Win rate & 95% CI**: Computed as `(wins + 0.5 * draws) / games` with `± 95% CI`. In `1v1` and `2v2`, >`50.0%` indicates the row AI outperforms its opponent; in `1v1v1` with 2 copies of the opponent (`1 vs 2`), >`33.3%` exceeds random parity.
* **Victory methods & specific card victories**: Every matchup line and the final **Victory Methods & Card Victories Summary** report exact counts for `Achievements`, `Score (Age 12+)`, `Elimination`, and specific `Card Effect (<CardName>)` victories (e.g. `Card Effect (Bioengineering)`, `Card Effect (Self Service)`) so you can inspect game balance across AI tiers.

### CLI End-Game Snapshots (`--snapshot-every`)
Use `--snapshot-every <X>` to capture standalone `.html` end-game snapshots with zero browser/rendering dependencies:
```powershell
npm run bench:ai -- --mode round-robin --variant 1v1 --games 100 --workers 14 --snapshot-every 1 --snapshot-max 1000
```
* **Snapshot contents**: Each file records structured metadata (global game #, variant, mode, matchup, seed, turns, eventual winner player/AI/team, victory method + winning card name, and summary), visible functional icons, final 5 color stacks (card lists Bottom → Top + splay states), claimed achievements, score pile, hand cards, plus an embedded JSON metadata `<script>` block.
* **Rolling retention**: By default `--snapshot-max 1000` automatically removes the oldest `.html` files in `--snapshot-dir` once the directory exceeds `1000` snapshots.
* **Performance**: Non-CLI / browser gameplay incurs **0%** overhead. In CLI mode, writing compact HTML snapshots only touches games matching `--snapshot-every` (~`0.1–0.3 ms` per saved file, roughly ~`1–3%` total runtime overhead at `--snapshot-every 1`).

---

## 7. CLI Testing, Linting & Production Build

Run the Node unit test suites, TypeScript type-checker, and production bundle from the project root:

```bash
# Run all engine & TD unit tests
npx tsx --test src/engine/*.test.ts

# Run individual test suites
npx tsx --test src/engine/td.test.ts
npx tsx --test src/engine/engine.test.ts

# TypeScript check (lint) and production Vite build
npm run lint
npm run build
```

