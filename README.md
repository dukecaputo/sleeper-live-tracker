# Fantasy Fortèball — Real-Time Sleeper Tracker & Monte Carlo Forecast Engine

A real-time fantasy football live tracker and **10,000-trial Correlated Monte Carlo Win Probability & League Median Forecast Engine** built for **Fantasy Fortèball** (Sleeper League ID: `1312258310212165632`).

## Key Features & Auto-Update Capabilities

1. **100% Client-Side + Serverless Hybrid Architecture (`public/engine.js`)**
   - Because Sleeper's REST (`api.sleeper.app`) and GraphQL (`api.sleeper.com/graphql`) endpoints support CORS (`Access-Control-Allow-Origin: *`), the entire 10,000-trial Monte Carlo simulation engine runs directly in the browser in ~12ms with zero backend server maintenance required.
2. **Automatic Week & Season Rollover**
   - Queries `https://api.sleeper.app/v1/state/nfl` dynamically on load and during polling.
   - Automatically selects the current active NFL week (`display_week`), populates Weeks 1–18 (including Playoffs), and rolls over automatically when Sleeper advances the week on Tuesday/Wednesday.
3. **Real-Time Lineup Changes, Waiver Claims, Trades & Scoring Sync**
   - Polls Sleeper every 10 seconds with cache-busting (`cache: 'no-store'`) on `/matchups/{week}`, `/rosters`, `/users`, `/stats`, and `/graphql`.
   - Automatically detects starter/bench swaps made in Sleeper and logs them in the **Lineup & Score Log** tab.
4. **Smart BYE / OUT Bench Auto-Sub (for Future Weeks) + Interactive What-If Swaps**
   - Properly detects `BYE` weeks and `Out`/`IR`/`Doubtful` designations.
   - When previewing future weeks (or when toggled via **⚡ Auto-Sub BYE/OUT**), automatically slots in each team's highest-projected eligible bench replacement so future-week H2H win probabilities and League Median forecasts aren't skewed by unset lineups.
   - Expand any matchup's bench and use **⇄ Test What-If Lineup Swap** to simulate any starter/bench swap in real time.

---

## Publishing Options (Zero Cost)

Because `public/` (and the root directory) is a self-contained static web app that talks directly to Sleeper's APIs in real time, you can publish it for free on any of the following platforms:

### Option 1: Instant Drag-and-Drop (Netlify Drop / Cloudflare Pages) — 30 Seconds, No CLI Needed
1. Open **[app.netlify.com/drop](https://app.netlify.com/drop)** (or Cloudflare Pages -> Upload Assets).
2. Drag and drop the **`public`** folder from `/Users/src40/.gemini/antigravity/scratch/sleeper-live-tracker/public` into the browser window.
3. You will immediately get a permanent live `https://...` URL that you can share with your league chat!

### Option 2: GitHub Pages (Automated via Included GitHub Action)
This repo is pre-configured with `.github/workflows/deploy.yml`:
```bash
cd /Users/src40/.gemini/antigravity/scratch/sleeper-live-tracker
git remote add origin https://github.com/dukecaputo/sleeper-live-tracker.git
git push -u origin main
```
Then in your GitHub repository **Settings → Pages**, set **Source** to **GitHub Actions**. Your tracker will be live at `https://dukecaputo.github.io/sleeper-live-tracker/`.

### Option 3: One-Command Vercel Deploy
```bash
cd /Users/src40/.gemini/antigravity/scratch/sleeper-live-tracker
npx vercel --prod
```
