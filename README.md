# Innovation 4th Edition

A fan-made digital adaptation of *Innovation* (4th Edition) by Carl Chudyk.

> This is an unofficial, non-commercial fan project created with permission from Asmadi Games. It is not affiliated with, endorsed, or supported by Asmadi Games or designer Carl Chudyk. *Innovation* is a trademark of Asmadi Games. All game rules, card names, and concepts belong to their respective owners.

## Play Online / Install as PWA

- **Live Web App & PWA**: https://citrussquid.github.io/Innovation/
  - **Desktop (Chrome / Edge)**: Click the install icon in the address bar (or **Settings → Install App**).
  - **Android (Chrome / Edge)**: Tap **Install App** in Settings or the browser menu (**Add to Home screen / Install app**).
  - **iOS (Safari)**: Tap **Share → Add to Home Screen**. Once installed, the Service Worker caches the full app for offline play with `localStorage` saves.

## Standalone Offline `.html` Download

- Download the self-contained single-file HTML directly from https://citrussquid.github.io/Innovation/index.html or use **Settings → Save Offline HTML** inside the app.
- **Desktop**: Open the `.html` file directly in any modern browser.
- **Android**: Open the `.html` file with **Chrome** or **Firefox** (avoid Android's built-in "HTML Viewer", which blocks scripts; note that `content://` downloads may restrict `localStorage`, so `.json` Save/Load is available).
- **iOS**: iOS **Files / Quick Look** disables JavaScript on local `.html` files. Use **Safari → Add to Home Screen** on the GitHub Pages PWA above for offline iOS play, or open the `.html` in a JS-capable local viewer app.

## Features

- **Game Modes**: **1v1**, **3p FFA**, and **2v2** variants.
- **Fair, Non-Cheating AI**: Both rule-based Heuristic and `TD(λ)` neural network AI tiers do not have access to hidden information.
- The Full TD AI is the best AI model. Easy, medium, and hard all reduce its capacity to some extent by handicapping, forcing errors, etc. Heuristic functions roughly at the level of a medium TD AI.
- **Local Pass-and-Play & AI vs AI**: Privacy curtain handoff for multi-human play and auto/manual spectator modes for AI-only matches.
- **Offline**: Functions entirely offline as an all-in-one `.html` file or installed PWA. AI weights are bundled. Saves in `localStorage` or `.json` files.
- **Mobile and Desktop**: Separate layouts for mobile (vertical) and widescreen desktop/tablet viewports.

## Development & Building

**Prerequisites:** Node.js (v20+)

```bash
npm install
npm run dev      # Start local dev server
npm run lint     # TypeScript check
npm test         # Run engine unit tests
npm run build    # Build PWA + single-file dist/index.html
```

## AI Training & Benchmarking

- New AI weights may be trained. See [TD_TRAINING_GUIDE.md](./TD_TRAINING_GUIDE.md) for more information.
- Training is via the CLI (`npm run train:td`) or standalone `trainer.html` (`npm run train:gui`).
- There is an inbuilt **AI Arena** under **About → AI**, where you can click on completed matches to visualize their final state.
- Training a new AI model takes roughly an hour for 25k games on modern hardware and must be done for each game mode.
