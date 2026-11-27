# Innovation 4th Edition

A fan-made digital adaptation of *Innovation* (4th Edition) by Carl Chudyk.

> This is an unofficial, non-commercial fan project created with permission from Asmadi Games. It is not affiliated with, endorsed, or supported by Asmadi Games or designer Carl Chudyk. *Innovation* is a trademark of Asmadi Games. All game rules, card names, and concepts belong to their respective owners.

## Features

- **Game Modes**: **1v1**, **3p FFA (`1v1v1`)**, and **2v2 (Team)** variants across Ages 1–11.
- **Fair, Non-Cheating AI**: Both rule-based Heuristic and `TD(λ)` neural network AI tiers do not have access to hidden information.
- The Full TD AI is the best AI model. Easy, medium, and hard all reduce its capacity to some extent by handicapping, forcing errors, etc. Heuristic functions roughly at the level of a medium TD AI.  
- **Local Pass-and-Play & AI vs AI**: Privacy curtain handoff for multi-human play and auto/manual spectator modes for AI-only matches.
- **Offline** Functions entirely offline as an all in one .html file. AI weights are bundled. Saves in `localStorage`.

## Quick Start

1. Download and run index.html in Dist folder.
- That is all

## AI Training & Benchmarking

- New AI weights may be trained. See TD_TRAINING_GUIDE.md for more information.
- Training is via the CLI or trainer.html file.
- There is an inbuilt AI Arena, you can click on the games to visualise their final state.
- Training a new AI model takes roughly an hour for 25k games on modern hardware.

CLI scripts (`npm run train:td`, `npm run bench:ai`, `npm run compare:ai`) and model weight details are documented in [TD_TRAINING_GUIDE.md](./TD_TRAINING_GUIDE.md).
