const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const engine = require('./public/engine.js');

const PORT = process.env.PORT || 3456;

if (process.argv.includes('--check')) {
  engine.getLeagueLiveState(engine.DEFAULT_LEAGUE_ID).then((data) => {
    console.log('=== LEAGUE:', data.league.name, `(Week ${data.league.week}, ${data.league.season}) ===`);
    console.log('Compute time:', data.computeTimeMs, 'ms');
    console.log('=== LEAGUE MEDIAN FORECAST ===');
    console.log('  Improved Expected Median (Joint MC):', data.leagueMedian.expectedMedianImproved, `(10th-90th: ${data.leagueMedian.p10} - ${data.leagueMedian.p90})`);
    console.log('  Sleeper Naive Static Median:        ', data.leagueMedian.staticMedianSleeper);
    console.log('  Delta vs Sleeper:                   ', data.leagueMedian.medianDiffVsSleeper);
    process.exit(0);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url, `http://localhost:${PORT}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (parsed.pathname === '/api/live') {
      try {
        const leagueId = parsed.searchParams.get('league_id') || engine.DEFAULT_LEAGUE_ID;
        const week = parsed.searchParams.get('week') || null;
        const force = parsed.searchParams.get('force') === '1';
        const autoSub = parsed.searchParams.get('autosub') === '1';
        const data = await engine.getLeagueLiveState(leagueId, week, force, autoSub);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
      } catch (err) {
        console.error('API Error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    let filePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
    const fullPath = path.join(__dirname, 'public', path.normalize(filePath).replace(/^(\.\.[\/\\])+/, ''));
    fs.readFile(fullPath, (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const ext = path.extname(fullPath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml'
      };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      res.end(content);
    });
  });

  server.listen(PORT, () => {
    console.log(`Sleeper Real-Time Tracker running at http://localhost:${PORT}`);
  });
}
