const engine = require('../public/engine.js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=8, stale-while-revalidate=15');
  try {
    const leagueId = req.query?.league_id || engine.DEFAULT_LEAGUE_ID;
    const week = req.query?.week || null;
    const force = req.query?.force === '1';
    const autoSub = req.query?.autosub === '1';
    const data = await engine.getLeagueLiveState(leagueId, week, force, autoSub);
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
