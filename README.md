# Innovation 4th Edition

A fan-made digital adaptation of *Innovation* (4th Edition) by Carl Chudyk.

> This is an unofficial, non-commercial fan project created with permission from Asmadi Games. It is not affiliated with, endorsed, or supported by Asmadi Games or designer Carl Chudyk. *Innovation* is a trademark of Asmadi Games. All game rules, card names, and concepts belong to their respective owners.

## Features

- **Game Modes**: **1v1**, **3p FFA (`1v1v1`)**, and **2v2 (Team)** variants across Ages 1–11.
- **Fair, Non-Cheating AI**: Both rule-based Heuristic and `TD(λ)` neural network AI tiers (`Easy`, `Medium`, `Hard`, `Full`) that operate strictly on sanitized `PlayerView` projections without reading hidden opponent hands, score piles, or deck order.
- **Local Pass-and-Play & AI vs AI**: Privacy curtain handoff for multi-human play and auto/manual spectator modes for AI-only matches.
- **Offline Single-File HTML & Saves**: Export a self-contained offline `.html` build, save/load local slots in `localStorage`, or export/import `.json` match states.

## Quick Start

**Prerequisites:** Node.js (v20+)

1. Install dependencies:
   ```bash
   npm install
   ```
2. Run the development server:
   ```bash
   npm run dev
   ```
3. Run type-checking and unit tests:
   ```bash
   npm run lint
   npm test
   ```
4. Build the production single-file bundle (`dist/index.html`):
   ```bash
   npm run build
   ```

## AI Training & Benchmarking

The standalone TD Training & Weights Studio (`trainer.html`) is separate from the game UI and runs in dev mode:

```bash
npm run train:gui
```

CLI scripts (`npm run train:td`, `npm run bench:ai`, `npm run compare:ai`) and model weight details are documented in [TD_TRAINING_GUIDE.md](./TD_TRAINING_GUIDE.md).
