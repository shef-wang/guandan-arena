# Guandan Practice

This repo is set up to ship as a public single-page web app on Vercel for one product only: `1 player vs 3 AI` using the built-in `legacy-v1` AI.

## Current deployment model

- The React/Vite frontend is hosted by Vercel.
- Game rules, shuffle, turn flow, and the `legacy-v1` AI all run in the user's browser.
- The public app opens directly into the game table with no mode picker or remote model setup.
- No server is required unless you later add accounts, cloud saves, matchmaking, or multiplayer.

## Deploy to Vercel

### Option 1: Dashboard

1. Push this repo to GitHub.
2. In Vercel, create a new project and import the repository.
3. Keep the detected framework as `Vite`.
4. Confirm these settings:
   - Install Command: `npm install`
   - Build Command: `npm run build`
   - Output Directory: `dist`
5. Deploy.

Vercel should detect most of these automatically for this repo.

### Option 2: Vercel CLI

```bash
npm install -g vercel
vercel
vercel --prod
```

Run those commands from the project root.

## Local checks before deploy

```bash
npm install
npm run build
```

The production build should emit static assets into `dist/`.

## Why this works without a backend

The current practice mode already runs entirely client-side:

- UI flow: `src/PracticeTable.tsx`
- Game state transitions: `src/game/state.ts`
- Built-in AI: `src/game/ai.ts`

That means each player session uses their own device for gameplay compute, which keeps hosting simple and cheap.

## When you would need a server later

Add a backend only if you want features like:

- login or user profiles
- shared cloud save data
- leaderboards
- real-time multiplayer
- anti-cheat or authoritative game state

## Notes

- The current app does not need special Vercel routing config because it serves from a single entry page and does not use URL-based client routing yet.
- If you later add React Router or shareable in-app URLs, add an SPA fallback rewrite for Vercel at that time.
