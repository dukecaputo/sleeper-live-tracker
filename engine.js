/**
 * Universal Real-Time Sleeper Fantasy Tracker, Sportsbook + Prediction Market Valuation Engine,
 * and Block-Cholesky Correlated Monte Carlo Lineup Optimizer.
 *
 * Works identically in the Browser (Direct CORS to Sleeper, One Week Season Sportsbook Feed,
 * and ESPN DraftKings Scoreboard APIs) and in Node.js / Serverless.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SleeperTrackerEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_LEAGUE_ID = '1312258310212165632';
  const OWS_SPORTSBOOK_URL = 'https://oneweekseason.com/wp-json/ows-stacks/v1/sportsbook-feed';
  const ESPN_SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
  const cache = new Map();

  async function fetchJson(url, options = {}, ttlMs = 8000) {
    const method = options.method || 'GET';
    const body = options.body || '';
    const cacheKey = `${method}:${url}:${body}`;
    const now = Date.now();

    if (ttlMs > 0 && cache.has(cacheKey)) {
      const entry = cache.get(cacheKey);
      if (now - entry.ts < ttlMs) {
        return entry.data;
      }
    }

    const fetchOpts = {
      method,
      headers: {
        Accept: 'application/json',
        ...(options.headers || {})
      }
    };
    if (body) fetchOpts.body = body;
    if (ttlMs <= 10000 && typeof window !== 'undefined') {
      fetchOpts.cache = 'no-store';
    }

    const res = await fetch(url, fetchOpts);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    const data = await res.json();
    cache.set(cacheKey, { ts: Date.now(), data });
    return data;
  }

  function normalizePlayerName(name) {
    return (name || '')
      .toLowerCase()
      .replace(/\s+(jr\.?|sr\.?|iii|ii|iv|v)$/i, '')
      .replace(/[^a-z0-9]/g, '');
  }

  function normalizeTeamCode(team) {
    if (!team) return 'FA';
    const t = team.toUpperCase();
    if (t === 'LA') return 'LAR';
    if (t === 'JAC') return 'JAX';
    if (t === 'WSH') return 'WAS';
    return t;
  }

  function computeCustomPoints(stats, scoringSettings) {
    if (!stats || !scoringSettings) return 0;
    let total = 0;
    for (const [key, weight] of Object.entries(scoringSettings)) {
      const val = stats[key];
      if (val !== undefined && val !== null && !Number.isNaN(val)) {
        total += val * weight;
      }
    }
    return total;
  }

  /**
   * Convert Sportsbook Player Prop Lines (py, ptd, int, ry, rec, recy, td)
   * directly into THIS Sleeper league's custom scoring_settings!
   */
  function computeLeaguePointsFromSportsbookLine(pos, line, scoringSettings) {
    if (!line || !scoringSettings) return null;
    const py = Number(line.py || 0);
    const ptd = Number(line.ptd || 0);
    const intVal = Number(line.int || 0);
    const ry = Number(line.ry || 0);
    const rec = Number(line.rec || 0);
    const recy = Number(line.recy || 0);
    const td = Number(line.td || 0);

    // Ensure there is actually a posted prop line
    if (py === 0 && ptd === 0 && ry === 0 && rec === 0 && recy === 0 && td === 0) {
      return null;
    }

    let pts = 0;
    if (pos === 'QB') {
      // NFL average yards per completion ~ 11.15 -> estimate completions for pass_cmp bonus
      const estCompletions = py > 0 ? py / 11.15 : 0;
      pts += py * (scoringSettings.pass_yd ?? 0.04);
      pts += estCompletions * (scoringSettings.pass_cmp ?? 0.0);
      pts += ptd * (scoringSettings.pass_td ?? 4.0);
      pts += intVal * (scoringSettings.pass_int ?? -2.0);
      pts += ry * (scoringSettings.rush_yd ?? 0.1);
      pts += td * (scoringSettings.rush_td ?? 6.0);
      pts += 0.20 * (scoringSettings.fum_lost ?? -2.0);
      pts += 0.08 * (scoringSettings.pass_2pt ?? 2.0);
    } else {
      pts += ry * (scoringSettings.rush_yd ?? 0.1);
      pts += rec * (scoringSettings.rec ?? 0.5);
      pts += recy * (scoringSettings.rec_yd ?? 0.1);
      pts += td * (scoringSettings.rec_td ?? 6.0);
      const fumRate = pos === 'RB' ? 0.08 : 0.04;
      pts += fumRate * (scoringSettings.fum_lost ?? -2.0);
      pts += 0.03 * (scoringSettings.rec_2pt ?? 2.0);
    }
    return Math.max(0, Number(pts.toFixed(2)));
  }

  function parseClockSeconds(clockStr) {
    if (!clockStr || typeof clockStr !== 'string') return 0;
    const parts = clockStr.trim().split(':');
    if (parts.length === 2) {
      const mins = parseInt(parts[0], 10) || 0;
      const secs = parseInt(parts[1], 10) || 0;
      return Math.max(0, Math.min(900, mins * 60 + secs));
    }
    return 0;
  }

  /**
   * Analyze NFL game state + enrich with Sportsbook Over/Under, Spread, Implied Team Totals,
   * and Sleeper/Kalshi CFTC Prediction Market Win Probabilities.
   */
  function analyzeGameState(gameObj, externalOddsMap = {}) {
    if (!gameObj) {
      return {
        status: 'bye',
        linearRemFrac: 0,
        effectiveRemFrac: 0,
        elapsedFrac: 1,
        quarter: 0,
        clock: 'BYE',
        homeTeam: null,
        awayTeam: null,
        homeScore: 0,
        awayScore: 0,
        possession: null,
        redZone: null,
        downDistance: null,
        yardLine: null,
        spread: {},
        vegasTotal: 45.0,
        homeSpread: 0,
        homeImpliedTotal: 22.5,
        awayImpliedTotal: 22.5,
        homePredMarketWinProb: 0.5,
        awayPredMarketWinProb: 0.5,
        otProb: 0
      };
    }

    const meta = gameObj.metadata || {};
    const status = gameObj.status || 'complete';
    const homeTeam = normalizeTeamCode(meta.home_team || gameObj.home);
    const awayTeam = normalizeTeamCode(meta.away_team || gameObj.away);
    const homeScore = Number(meta.home_score ?? 0);
    const awayScore = Number(meta.away_score ?? 0);

    // Extract Sportsbook Spread & Prediction Market Moneyline from Sleeper + OWS + ESPN
    const ext = externalOddsMap[homeTeam] || externalOddsMap[awayTeam] || {};
    const slpSpreadObj = meta.spread || meta.pickem_spread || {};
    const homeSpread = slpSpreadObj[homeTeam] !== undefined
      ? Number(slpSpreadObj[homeTeam])
      : (ext.homeTeam === homeTeam && ext.homeSpread !== undefined ? Number(ext.homeSpread) : 0);

    const vegasTotal = ext.total && ext.total > 20 ? Number(ext.total) : 45.5;
    // Home spread is negative when Home is favored (e.g., -3 means Home expected to score 3 more than Away)
    const homeImpliedTotal = Number(((vegasTotal - homeSpread) / 2).toFixed(2));
    const awayImpliedTotal = Number(((vegasTotal + homeSpread) / 2).toFixed(2));

    // Sleeper CFTC Prediction Market Contract probabilities (`moneyline` object in metadata)
    const ml = meta.moneyline || {};
    const rawHomePm = Number(ml[homeTeam] || 0);
    const rawAwayPm = Number(ml[awayTeam] || 0);
    let homePredMarketWinProb = 0.5;
    let awayPredMarketWinProb = 0.5;
    if (rawHomePm > 0 && rawAwayPm > 0) {
      const sumPm = rawHomePm + rawAwayPm;
      homePredMarketWinProb = Number((rawHomePm / sumPm).toFixed(4));
      awayPredMarketWinProb = Number((rawAwayPm / sumPm).toFixed(4));
    } else {
      // Fallback implied win probability from spread (~3.1% per point of spread)
      homePredMarketWinProb = Number(Math.min(0.95, Math.max(0.05, 0.5 - homeSpread * 0.031)).toFixed(4));
      awayPredMarketWinProb = Number((1 - homePredMarketWinProb).toFixed(4));
    }

    const baseMarketFields = {
      vegasTotal,
      homeSpread,
      homeImpliedTotal,
      awayImpliedTotal,
      homePredMarketWinProb,
      awayPredMarketWinProb,
      rawPredictionMarket: rawHomePm > 0 ? { [homeTeam]: rawHomePm, [awayTeam]: rawAwayPm } : null
    };

    if (status === 'complete' || meta.is_over) {
      return {
        gameId: gameObj.game_id,
        status: 'complete',
        linearRemFrac: 0,
        effectiveRemFrac: 0,
        elapsedFrac: 1,
        quarter: meta.quarter_num || 4,
        clock: 'FINAL',
        homeTeam,
        awayTeam,
        homeScore,
        awayScore,
        possession: null,
        redZone: null,
        downDistance: null,
        yardLine: null,
        spread: meta.spread || {},
        otProb: 0,
        ...baseMarketFields
      };
    }

    if (status === 'pre_game' || !meta.has_started) {
      let clockLabel = 'PRE';
      if (meta.date_time) {
        try {
          const dt = new Date(meta.date_time);
          const day = dt.toLocaleDateString('en-US', { weekday: 'short' });
          const tm = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
          clockLabel = `${day} ${tm}`;
        } catch (_) {
          clockLabel = 'PRE';
        }
      }
      return {
        gameId: gameObj.game_id,
        status: 'pre_game',
        linearRemFrac: 1.0,
        effectiveRemFrac: 1.0,
        elapsedFrac: 0.0,
        quarter: 0,
        clock: clockLabel,
        dateTime: meta.date_time || null,
        homeTeam,
        awayTeam,
        homeScore: 0,
        awayScore: 0,
        possession: null,
        redZone: null,
        downDistance: null,
        yardLine: null,
        spread: meta.spread || {},
        otProb: 0.05,
        ...baseMarketFields
      };
    }

    const q = Number(meta.quarter_num || 1);
    const qSecRem = parseClockSeconds(meta.time_remaining || '15:00');
    let totalSecRem = q <= 4 ? (4 - q) * 900 + qSecRem : Math.min(600, qSecRem);

    const linearRemFrac = Math.max(0, Math.min(1, totalSecRem / 3600));
    const elapsedFrac = Math.max(0, 1 - linearRemFrac);

    const qWeights = [0.22, 0.28, 0.22, 0.28];
    let effectiveRem = 0;
    if (q <= 4) {
      for (let futureQ = q + 1; futureQ <= 4; futureQ++) {
        effectiveRem += qWeights[futureQ - 1];
      }
      const qFrac = qSecRem / 900;
      let currentQEffectiveFrac = qFrac;
      if (q === 2 || q === 4) {
        const twoMinSec = Math.min(240, qSecRem);
        const normalSec = Math.max(0, qSecRem - 240);
        currentQEffectiveFrac = (twoMinSec * 1.32 + normalSec * 0.88) / 900;
      }
      effectiveRem += qWeights[q - 1] * currentQEffectiveFrac;
    } else {
      effectiveRem = 0.08 * (qSecRem / 600);
    }

    const scoreDiff = Math.abs(homeScore - awayScore);
    const otProb = q <= 4 ? 0.065 * Math.exp(-scoreDiff / 6.5) * (0.5 + 0.5 * elapsedFrac) : 0;
    effectiveRem = Math.min(1.04, effectiveRem + otProb * 0.075);

    return {
      gameId: gameObj.game_id,
      status: 'in_game',
      linearRemFrac,
      effectiveRemFrac: effectiveRem,
      elapsedFrac,
      quarter: q,
      clock: meta.time_remaining || '0:00',
      homeTeam,
      awayTeam,
      homeScore,
      awayScore,
      possession: meta.possession || null,
      redZone: meta.red_zone || null,
      downDistance: meta.down_and_distance || null,
      yardLine: meta.yard_line || null,
      yardLineTerritory: meta.yard_line_territory || null,
      channel: meta.channel || null,
      spread: meta.spread || {},
      otProb,
      ...baseMarketFields
    };
  }

  function canonicalPos(pos) {
    if (!pos) return 'WR';
    const p = pos.toUpperCase();
    if (p === 'QB') return 'QB';
    if (p === 'RB' || p === 'FB') return 'RB';
    if (p === 'WR') return 'WR';
    if (p === 'TE') return 'TE';
    if (['DL', 'DE', 'DT', 'EDGE'].includes(p)) return 'DL';
    if (['LB', 'ILB', 'OLB', 'MLB'].includes(p)) return 'LB';
    if (['DB', 'CB', 'S', 'FS', 'SS'].includes(p)) return 'DB';
    return 'WR';
  }

  function isEligibleForSlot(playerObj, slot) {
    const cPos = playerObj.canonicalPos;
    const rawList = (playerObj.fantasyPositions || [playerObj.position]).map(canonicalPos);
    const hasPos = (target) => cPos === target || rawList.includes(target);

    switch (slot) {
      case 'QB': return hasPos('QB');
      case 'RB': return hasPos('RB');
      case 'WR': return hasPos('WR');
      case 'TE': return hasPos('TE');
      case 'FLEX': return hasPos('RB') || hasPos('WR') || hasPos('TE');
      case 'SUPER_FLEX': return hasPos('QB') || hasPos('RB') || hasPos('WR') || hasPos('TE');
      case 'DL': return hasPos('DL');
      case 'LB': return hasPos('LB');
      case 'DB': return hasPos('DB');
      case 'IDP_FLEX': return hasPos('DL') || hasPos('LB') || hasPos('DB');
      default: return true;
    }
  }

  /**
   * Model a single player, incorporating:
   *  - Sleeper Rotowire pre-game projection (custom league scoring)
   *  - Live Sportsbook Player Prop projection (translated to custom league scoring)
   *  - Prediction Market Win Probability & Vegas Implied Team Total environment adjustment
   *  - Live in-game Bayesian usage, game script, and Red Zone micro-states
   */
  function modelPlayer(playerId, actualPts, projEntry, statEntry, gameState, scoringSettings, sbPropEntry = null, marketWeight = 0.75) {
    const pInfo = (projEntry && projEntry.player) || (statEntry && statEntry.player) || {};
    const projStats = (projEntry && projEntry.stats) || {};
    const liveStats = (statEntry && statEntry.stats) || {};

    const firstName = pInfo.first_name || 'Empty';
    const lastName = pInfo.last_name || (String(playerId) === '0' ? 'Slot' : `#${playerId}`);
    const fullName = String(playerId) === '0' ? 'Empty Slot' : `${firstName} ${lastName}`.trim();
    const rawPos = pInfo.position || 'WR';
    const fantasyPositions = pInfo.fantasy_positions || [rawPos];
    const pos = canonicalPos(rawPos);
    const team = normalizeTeamCode((projEntry && projEntry.team) || (statEntry && statEntry.team) || pInfo.team || 'FA');
    const opponent = normalizeTeamCode((projEntry && projEntry.opponent) || (statEntry && statEntry.opponent) || '');
    const injuryStatus = pInfo.injury_status || null;

    const sleeperPregameProj = computeCustomPoints(projStats, scoringSettings);
    const currentPts = (actualPts !== undefined && actualPts !== null)
      ? Number(actualPts)
      : computeCustomPoints(liveStats, scoringSettings);

    // Team Market Context (Implied Total, Spread, Prediction Market Win %)
    const isHome = gameState && gameState.homeTeam === team;
    const teamImpliedTotal = gameState
      ? (isHome ? gameState.homeImpliedTotal : gameState.awayImpliedTotal)
      : 22.5;
    const oppImpliedTotal = gameState
      ? (isHome ? gameState.awayImpliedTotal : gameState.homeImpliedTotal)
      : 22.5;
    const teamSpread = gameState
      ? (isHome ? gameState.homeSpread : -gameState.homeSpread)
      : 0;
    const predMarketWinProb = gameState
      ? (isHome ? gameState.homePredMarketWinProb : gameState.awayPredMarketWinProb)
      : 0.5;
    const vegasTotal = gameState ? gameState.vegasTotal : 45.0;

    // Sportsbook Prop Implied Points in this league's scoring
    const sbLine = sbPropEntry ? sbPropEntry.line : null;
    const rawSbProj = sbLine ? computeLeaguePointsFromSportsbookLine(pos, sbLine, scoringSettings) : null;

    // Prediction Market & Vegas Implied Team Total environment adjustment for players without direct prop lines (e.g. MNF or IDP)
    let marketImpliedPregame = sleeperPregameProj;
    let marketSourceLabel = 'Sleeper Base';
    if (rawSbProj !== null && rawSbProj > 0) {
      // Blend direct sportsbook player props with prediction-market win script modifier
      const pmDelta = predMarketWinProb - Math.min(0.95, Math.max(0.05, 0.5 - teamSpread * 0.031));
      const pmScriptBoost = pos === 'RB' ? (1 + pmDelta * 0.18) : (['QB', 'WR', 'TE'].includes(pos) ? (1 + pmDelta * 0.08) : 1.0);
      const pureMarketEst = rawSbProj * pmScriptBoost;
      marketImpliedPregame = marketWeight * pureMarketEst + (1 - marketWeight) * sleeperPregameProj;
      marketSourceLabel = 'Sportsbook Props + PM';
    } else if (sleeperPregameProj > 0 && gameState && gameState.status !== 'bye') {
      // Adjust baseline projection using Vegas Implied Team Total & Prediction Market Win %
      const isIdp = ['DL', 'LB', 'DB'].includes(pos);
      if (!isIdp) {
        // NFL average implied team total is ~22.5 pts; scale sensitively (~35% elasticity)
        const totalRatio = Math.max(0.78, Math.min(1.25, Math.pow(teamImpliedTotal / 22.5, 0.35)));
        const roleScript = pos === 'RB'
          ? (predMarketWinProb >= 0.55 ? 1.03 : (predMarketWinProb <= 0.42 ? 0.96 : 1.0))
          : (predMarketWinProb <= 0.44 ? 1.03 : 1.0);
        marketImpliedPregame = sleeperPregameProj * totalRatio * roleScript;
        marketSourceLabel = `Vegas/PM Implied (${teamImpliedTotal.toFixed(1)} pts)`;
      } else {
        // IDP adjustments based on opponent implied total & game script
        const oppPassHeavy = predMarketWinProb >= 0.56 ? 1.04 : 1.0;
        const gamePace = Math.max(0.92, Math.min(1.10, vegasTotal / 45.0));
        marketImpliedPregame = sleeperPregameProj * (pos === 'DL' ? oppPassHeavy : gamePace);
        marketSourceLabel = 'Game Pace + PM Script';
      }
    }

    const isBye = String(playerId) === '0' || !gameState || gameState.status === 'bye' || (!opponent && (!gameState || !gameState.homeTeam));
    if (isBye || gameState.status === 'complete') {
      const finalStatus = isBye ? 'bye' : 'complete';
      return {
        playerId,
        fullName,
        shortName: String(playerId) === '0' ? 'Empty' : `${firstName.charAt(0)}. ${lastName}`,
        position: rawPos,
        fantasyPositions,
        canonicalPos: pos,
        team,
        opponent,
        injuryStatus,
        gameStatus: finalStatus,
        gameId: isBye ? null : gameState.gameId,
        quarter: isBye ? 0 : gameState.quarter,
        clock: isBye ? 'BYE' : 'FINAL',
        gameScore: isBye ? 'BYE WEEK' : 'FINAL',
        hasPossession: false,
        inRedZone: false,
        currentPts: isBye ? 0 : currentPts,
        pregameProj: isBye ? 0 : Number(marketImpliedPregame.toFixed(2)),
        sleeperPregameProj: isBye ? 0 : Number(sleeperPregameProj.toFixed(2)),
        sportsbookProj: rawSbProj,
        sportsbookLine: sbLine,
        marketSourceLabel: isBye ? 'BYE' : 'Final',
        teamImpliedTotal,
        oppImpliedTotal,
        vegasTotal,
        teamSpread,
        predMarketWinProb,
        sleeperProj: isBye ? 0 : currentPts,
        improvedProj: isBye ? 0 : currentPts,
        remMeanSleeper: 0,
        remMeanImproved: 0,
        remSdSleeper: 0,
        remSdImproved: 0,
        skewness: 0,
        factors: {
          linearRemFrac: 0,
          effectiveRemFrac: 0,
          bayesUsageMult: 1,
          gameScriptMult: 1,
          driveBonus: 0,
          reasons: isBye ? ['On BYE / Empty'] : []
        }
      };
    }

    const isOut = ['Out', 'IR', 'Doubtful', 'Suspension', 'COV'].includes(injuryStatus);
    const linearRem = isOut ? 0 : gameState.linearRemFrac;
    const effectiveRem = isOut ? 0 : gameState.effectiveRemFrac;
    const elapsed = gameState.elapsedFrac;

    const remMeanSleeper = sleeperPregameProj * linearRem;
    const sleeperProj = currentPts + remMeanSleeper;

    const reasons = [];
    let bayesUsageMult = 1.0;
    let gameScriptMult = 1.0;
    let driveBonus = 0.0;

    if (rawSbProj !== null) {
      const sbDiff = marketImpliedPregame - sleeperPregameProj;
      if (Math.abs(sbDiff) >= 0.6) {
        reasons.push(`Market ${sbDiff >= 0 ? '+' : ''}${sbDiff.toFixed(1)} vs Slp`);
      }
    }

    if (isOut) {
      reasons.push(`Status: ${injuryStatus}`);
    } else if (gameState.status === 'in_game' && marketImpliedPregame > 0.5) {
      const isIdp = ['DL', 'LB', 'DB'].includes(pos);
      const tmSnaps = isIdp ? (liveStats.tm_def_snp || 0) : (liveStats.tm_off_snp || 0);
      const plSnaps = isIdp ? (liveStats.def_snp || 0) : (liveStats.off_snp || 0);

      let obsOpportunity = 0;
      let expOpportunityFull = 0;
      if (pos === 'QB') {
        obsOpportunity = (liveStats.pass_att || 0) + (liveStats.rush_att || 0) * 1.5;
        expOpportunityFull = (projStats.pass_att || 30) + (projStats.rush_att || 3) * 1.5;
      } else if (pos === 'RB') {
        obsOpportunity = (liveStats.rush_att || 0) + (liveStats.rec_tgt || liveStats.rec || 0) * 1.6;
        expOpportunityFull = (projStats.rush_att || 10) + (projStats.rec || 2) * 1.9;
      } else if (pos === 'WR' || pos === 'TE') {
        obsOpportunity = (liveStats.rec_tgt || (liveStats.rec || 0) * 1.45) + (liveStats.rush_att || 0);
        expOpportunityFull = (projStats.rec || 3) * 1.55 + (projStats.rush_att || 0);
      } else {
        obsOpportunity = (liveStats.idp_tkl || 0) + (liveStats.idp_qb_hit || 0) * 1.5 + (liveStats.idp_pass_def || 0) * 1.5;
        expOpportunityFull = (projStats.idp_tkl || 4) + (projStats.idp_qb_hit || 0.5) * 1.5 + (projStats.idp_pass_def || 0.3) * 1.5;
      }

      if (elapsed >= 0.18) {
        const expOppSoFar = Math.max(0.5, expOpportunityFull * elapsed);
        const rawVolRatio = obsOpportunity / expOppSoFar;
        const clampedRatio = Math.max(0.35, Math.min(1.75, rawVolRatio));
        const kappa = 1.45;
        bayesUsageMult = (kappa * 1.0 + elapsed * clampedRatio) / (kappa + elapsed);

        if (tmSnaps >= 18 && plSnaps === 0 && currentPts === 0 && obsOpportunity === 0) {
          bayesUsageMult = Math.max(0.12, Math.pow(1 - elapsed, 2.2));
          reasons.push('0 snaps recorded so far');
        } else if (bayesUsageMult >= 1.07) {
          reasons.push(`High live usage (+${Math.round((bayesUsageMult - 1) * 100)}%)`);
        } else if (bayesUsageMult <= 0.93) {
          reasons.push(`Low live usage (${Math.round((bayesUsageMult - 1) * 100)}%)`);
        }
      }

      const teamScore = isHome ? gameState.homeScore : gameState.awayScore;
      const oppScore = isHome ? gameState.awayScore : gameState.homeScore;
      const scoreDiff = teamScore - oppScore;

      const scriptWeight = Math.min(1.0, 0.35 + 0.85 * elapsed);
      if (scoreDiff <= -4) {
        const trailMag = Math.min(1.0, Math.abs(scoreDiff) / 16);
        if (pos === 'QB' || pos === 'WR' || pos === 'TE') {
          gameScriptMult = 1.0 + 0.16 * trailMag * scriptWeight;
          if (gameScriptMult >= 1.05) reasons.push(`Trailing script (+${Math.round((gameScriptMult - 1) * 100)}% pass vol)`);
        } else if (pos === 'RB') {
          const recShare = (projStats.rec || 0) / Math.max(1, (projStats.rush_att || 10) + (projStats.rec || 0));
          gameScriptMult = 1.0 - (0.14 * (1 - recShare * 1.5)) * trailMag * scriptWeight;
        } else if (pos === 'LB' || pos === 'DB') {
          gameScriptMult = 1.0 + 0.06 * trailMag * scriptWeight;
        }
      } else if (scoreDiff >= 6) {
        const leadMag = Math.min(1.0, scoreDiff / 16);
        if (pos === 'RB') {
          gameScriptMult = 1.0 + 0.16 * leadMag * scriptWeight;
          if (gameScriptMult >= 1.05) reasons.push(`Positive run script (+${Math.round((gameScriptMult - 1) * 100)}%)`);
        } else if (pos === 'QB' || pos === 'WR' || pos === 'TE') {
          gameScriptMult = 1.0 - 0.11 * leadMag * scriptWeight;
        } else if (pos === 'DL') {
          gameScriptMult = 1.0 + 0.12 * leadMag * scriptWeight;
          if (gameScriptMult >= 1.05) reasons.push('Pass-rush script boost');
        }
      }

      const isIdpPos = ['DL', 'LB', 'DB'].includes(pos);
      if (!isIdpPos && gameState.possession === team) {
        if (gameState.redZone === team) {
          const tdShare = Math.min(0.65, Math.max(0.08, marketImpliedPregame / 24));
          driveBonus = pos === 'QB' ? 0.68 : (0.55 * tdShare + 0.18);
          reasons.push('Live in Red Zone');
        } else {
          driveBonus = pos === 'QB' ? 0.22 : 0.14 * Math.min(1, marketImpliedPregame / 14);
          reasons.push('Has possession');
        }
      } else if (isIdpPos && gameState.possession && gameState.possession !== team) {
        driveBonus = 0.12;
      }

      if (effectiveRem - linearRem >= 0.025) {
        reasons.push('2-min/OT pace boost');
      }
    }

    const remMeanImproved = isOut
      ? 0
      : Math.max(0, marketImpliedPregame * effectiveRem * bayesUsageMult * gameScriptMult + driveBonus);
    const improvedProj = currentPts + remMeanImproved;

    const posVolatility = {
      QB: { cv: 0.40, baseSd: 2.2, skew: 0.55 },
      RB: { cv: 0.52, baseSd: 2.0, skew: 0.95 },
      WR: { cv: 0.62, baseSd: 2.1, skew: 1.15 },
      TE: { cv: 0.66, baseSd: 1.8, skew: 1.25 },
      DL: { cv: 0.74, baseSd: 1.5, skew: 1.35 },
      LB: { cv: 0.52, baseSd: 1.4, skew: 0.85 },
      DB: { cv: 0.66, baseSd: 1.4, skew: 1.15 }
    }[pos] || { cv: 0.60, baseSd: 1.8, skew: 1.0 };

    const fullGameSd = marketImpliedPregame > 0.2
      ? Math.sqrt(Math.pow(posVolatility.cv * marketImpliedPregame, 2) + Math.pow(posVolatility.baseSd, 2))
      : 0;

    const remSdSleeper = fullGameSd * Math.pow(linearRem, 0.85);
    const remSdImproved = isOut
      ? 0
      : fullGameSd * Math.sqrt(effectiveRem * bayesUsageMult * gameScriptMult) + (driveBonus > 0.3 ? 0.65 : 0);

    const dynamicSkew = effectiveRem > 0
      ? Math.min(2.4, posVolatility.skew / Math.pow(Math.max(0.12, effectiveRem), 0.28))
      : 0;

    return {
      playerId,
      fullName,
      shortName: `${firstName.charAt(0)}. ${lastName}`,
      position: rawPos,
      fantasyPositions,
      canonicalPos: pos,
      team,
      opponent,
      injuryStatus,
      gameStatus: gameState.status,
      gameId: gameState.gameId,
      quarter: gameState.quarter,
      clock: gameState.clock,
      gameScore: gameState.status === 'in_game'
        ? `${gameState.awayTeam} ${gameState.awayScore} - ${gameState.homeTeam} ${gameState.homeScore}`
        : (gameState.status === 'pre_game' ? `${gameState.awayTeam} @ ${gameState.homeTeam}` : 'FINAL'),
      hasPossession: gameState.possession === team,
      inRedZone: gameState.redZone === team,
      currentPts,
      pregameProj: Number(marketImpliedPregame.toFixed(2)),
      sleeperPregameProj: Number(sleeperPregameProj.toFixed(2)),
      sportsbookProj: rawSbProj,
      sportsbookLine: sbLine,
      marketSourceLabel,
      teamImpliedTotal,
      oppImpliedTotal,
      vegasTotal,
      teamSpread,
      predMarketWinProb,
      sleeperProj: Number(sleeperProj.toFixed(2)),
      improvedProj: Number(improvedProj.toFixed(2)),
      remMeanSleeper: Number(remMeanSleeper.toFixed(3)),
      remMeanImproved: Number(remMeanImproved.toFixed(3)),
      remSdSleeper: Number(remSdSleeper.toFixed(3)),
      remSdImproved: Number(remSdImproved.toFixed(3)),
      skewness: Number(dynamicSkew.toFixed(3)),
      factors: {
        linearRemFrac: linearRem,
        effectiveRemFrac: effectiveRem,
        bayesUsageMult,
        gameScriptMult,
        driveBonus,
        reasons
      }
    };
  }

  class FastRNG {
    constructor(seed = 1337) {
      this.state = seed >>> 0;
      this.spare = null;
      this.hasSpare = false;
    }
    nextUniform() {
      let t = (this.state += 0x6D2B79F5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    nextGaussian() {
      if (this.hasSpare) {
        this.hasSpare = false;
        return this.spare;
      }
      let u, v, s;
      do {
        u = this.nextUniform() * 2 - 1;
        v = this.nextUniform() * 2 - 1;
        s = u * u + v * v;
      } while (s >= 1 || s === 0);
      const mul = Math.sqrt((-2.0 * Math.log(s)) / s);
      this.spare = v * mul;
      this.hasSpare = true;
      return u * mul;
    }
  }

  function sampleSkewedRemaining(z, mu, sd, skew) {
    if (mu <= 0.001 && sd <= 0.001) return 0;
    const alpha = Math.min(0.36, Math.max(0.05, skew * 0.22));
    const normFactor = Math.sqrt(1 + 2 * alpha * alpha);
    const zEff = z < -1 / (2 * alpha) ? -1 / (2 * alpha) : z;
    const x = (zEff + alpha * (zEff * zEff - 1)) / normFactor;
    return mu + sd * x;
  }

  /**
   * Pairwise NFL Player Correlation Model (incorporating Vegas Game Total, Spread,
   * Stack Synergy, and Within-Team Target / Red-Zone TD Cannibalization).
   */
  function computePairwisePlayerCorrelation(pA, pB) {
    if (!pA || !pB || pA.playerId === pB.playerId) return 1.0;
    if (!pA.gameId || !pB.gameId || pA.gameId !== pB.gameId) return 0.0;

    const sameTeam = pA.team === pB.team;
    const posA = pA.canonicalPos;
    const posB = pB.canonicalPos;
    const isIdpA = ['DL', 'LB', 'DB'].includes(posA);
    const isIdpB = ['DL', 'LB', 'DB'].includes(posB);

    const vegasTotal = pA.vegasTotal || 45.5;
    const spreadMag = Math.abs(pA.teamSpread || 3.0);
    const totalDelta = Math.max(-0.25, Math.min(0.35, (vegasTotal - 45.0) / 14.0));
    const closenessBonus = Math.max(-0.15, Math.min(0.15, (7.0 - spreadMag) / 14.0));
    const shootoutFactor = 0.08 * totalDelta + 0.05 * closenessBonus;

    // 1. Offensive Skill Player Pairs
    if (!isIdpA && !isIdpB) {
      if (sameTeam) {
        // QB + WR / TE Stack: strong positive passing correlation
        if ((posA === 'QB' && (posB === 'WR' || posB === 'TE')) ||
            (posB === 'QB' && (posA === 'WR' || posA === 'TE'))) {
          const isUnderdog = (pA.teamSpread || 0) >= 3.0;
          const baseStack = (posA === 'TE' || posB === 'TE') ? 0.34 : 0.38;
          return Number(Math.min(0.65, baseStack + 0.5 * shootoutFactor + (isUnderdog ? 0.03 : 0)).toFixed(3));
        }
        // QB + RB on same team: mild shared drive efficiency offset by rushing vs passing TD split
        if ((posA === 'QB' && posB === 'RB') || (posB === 'QB' && posA === 'RB')) {
          return Number((0.08 + 0.25 * shootoutFactor).toFixed(3));
        }
        // Two RBs on same team: strong carry & goal-line cannibalization
        if (posA === 'RB' && posB === 'RB') {
          return -0.24;
        }
        // Same-team RB + WR / RB + TE: run-vs-pass script & red-zone TD cannibalization
        if (posA === 'RB' || posB === 'RB') {
          return -0.14;
        }
        // Same-team WR + WR or WR + TE: target & red-zone TD cannibalization
        return -0.11;
      } else {
        // Opposing team offensive players in the same game
        if (posA === 'RB' && posB === 'RB') {
          // Opposing RBs have negative game-script correlation (one team leading/running = other trailing/passing)
          return -0.10;
        }
        if (posA === 'RB' || posB === 'RB') {
          return -0.03;
        }
        // Opposing passing attacks (QB/WR/TE vs Opp QB/WR/TE) correlate positively in shootouts!
        return Number((0.14 + 0.85 * shootoutFactor).toFixed(3));
      }
    }

    // 2. IDP Correlations
    if (isIdpA && isIdpB) {
      return sameTeam ? -0.05 : 0.04;
    }

    const idpPos = isIdpA ? posA : posB;
    const offPos = isIdpA ? posB : posA;
    if (sameTeam) {
      // Pass rusher (DL) benefits when own offense scores & leads -> opponent forced to pass
      if (idpPos === 'DL' && ['QB', 'RB', 'WR'].includes(offPos)) return 0.10;
      return 0.02;
    } else {
      // Opposing team IDP vs Offense
      if (idpPos === 'DL' && offPos === 'QB') return -0.12;
      if ((idpPos === 'LB' || idpPos === 'DB') && ['RB', 'WR', 'TE'].includes(offPos)) return 0.09;
      return 0.0;
    }
  }

  /**
   * Compute exact lower-triangular Cholesky factor L of a symmetric correlation matrix `corr`
   * using robust Modified Cholesky with diagonal damping to guarantee Positive Definiteness.
   */
  function computeCholeskyFactor(corr) {
    const n = corr.length;
    const L = Array.from({ length: n }, () => new Float64Array(n));

    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        let sum = corr[i][j];
        for (let k = 0; k < j; k++) {
          sum -= L[i][k] * L[j][k];
        }
        if (i === j) {
          L[i][j] = Math.sqrt(Math.max(0.01, sum));
        } else {
          L[i][j] = sum / L[j][j];
        }
      }
      // Normalize row i to unit Euclidean norm so marginal variance is identically 1.0!
      let rowNormSq = 0;
      for (let j = 0; j <= i; j++) rowNormSq += L[i][j] * L[i][j];
      const invNorm = 1 / Math.sqrt(Math.max(1e-8, rowNormSq));
      for (let j = 0; j <= i; j++) L[i][j] *= invNorm;
    }
    return L;
  }

  function runJointLeagueSimulation(rostersData, numSims = 10000) {
    const rng = new FastRNG(20261031);
    const numTeams = rostersData.length;

    // Collect all unique active starter players across the 10 rosters, grouped by NFL gameId
    const playersById = new Map();
    const gameBuckets = new Map();

    for (const r of rostersData) {
      for (const p of r.starters) {
        if (p.remMeanImproved > 0.001 || p.remSdImproved > 0.001) {
          if (!playersById.has(p.playerId)) {
            playersById.set(p.playerId, p);
            const gKey = p.gameId || `solo_${p.playerId}`;
            if (!gameBuckets.has(gKey)) gameBuckets.set(gKey, []);
            gameBuckets.get(gKey).push(p);
          }
        }
      }
    }

    // Build per-game Block-Cholesky correlation matrices
    const gameBlocks = [];
    const playerSimSlot = new Map();
    let totalActivePlayers = 0;

    for (const [gKey, bucket] of gameBuckets.entries()) {
      const m = bucket.length;
      const corr = Array.from({ length: m }, () => new Float64Array(m));
      for (let i = 0; i < m; i++) {
        corr[i][i] = 1.0;
        for (let j = i + 1; j < m; j++) {
          const c = computePairwisePlayerCorrelation(bucket[i], bucket[j]);
          corr[i][j] = c;
          corr[j][i] = c;
        }
      }
      const L = computeCholeskyFactor(corr);
      const globalIndices = new Int32Array(m);
      for (let i = 0; i < m; i++) {
        const gIdx = totalActivePlayers++;
        globalIndices[i] = gIdx;
        playerSimSlot.set(bucket[i].playerId, gIdx);
      }
      gameBlocks.push({ m, L, players: bucket, globalIndices });
    }

    const compiledTeams = rostersData.map((r, tIdx) => {
      const starterSimIndices = [];
      const activePlayers = [];
      for (const p of r.starters) {
        if (p.remMeanImproved > 0.001 || p.remSdImproved > 0.001) {
          starterSimIndices.push(playerSimSlot.get(p.playerId));
          activePlayers.push(p);
        }
      }
      return {
        tIdx,
        rosterId: r.rosterId,
        matchupId: r.matchupId,
        currentPts: r.currentPts,
        starterSimIndices: new Int32Array(starterSimIndices),
        activePlayers
      };
    });

    const matchupMap = new Map();
    for (let i = 0; i < numTeams; i++) {
      const mid = rostersData[i].matchupId;
      if (!matchupMap.has(mid)) matchupMap.set(mid, []);
      matchupMap.get(mid).push(i);
    }
    const oppIndex = new Int32Array(numTeams).fill(-1);
    for (const pair of matchupMap.values()) {
      if (pair.length === 2) {
        oppIndex[pair[0]] = pair[1];
        oppIndex[pair[1]] = pair[0];
      }
    }

    const h2hWinsImp = new Float64Array(numTeams);
    const h2hWinsSlp = new Float64Array(numTeams);
    const medianWinsImp = new Float64Array(numTeams);
    const medianWinsSlp = new Float64Array(numTeams);
    const winBothImp = new Float64Array(numTeams);
    const winOneImp = new Float64Array(numTeams);
    const winZeroImp = new Float64Array(numTeams);

    const scoreSumImp = new Float64Array(numTeams);
    const scoreSqSumImp = new Float64Array(numTeams);
    const teamSamplesImp = Array.from({ length: numTeams }, () => new Float64Array(numSims));
    const medianSamplesImp = new Float64Array(numSims);
    const medianSamplesSlp = new Float64Array(numSims);

    const playerRemImp = new Float64Array(totalActivePlayers);
    const playerRemSlp = new Float64Array(totalActivePlayers);
    const epsBuf = new Float64Array(32);

    const trialScoresImp = new Float64Array(numTeams);
    const trialScoresSlp = new Float64Array(numTeams);
    const sortedImp = new Float64Array(numTeams);
    const sortedSlp = new Float64Array(numTeams);

    for (let s = 0; s < numSims; s++) {
      // 1. Sample correlated player outcomes block-by-block per NFL game
      for (let b = 0; b < gameBlocks.length; b++) {
        const blk = gameBlocks[b];
        const m = blk.m;
        const L = blk.L;
        for (let i = 0; i < m; i++) epsBuf[i] = rng.nextGaussian();
        for (let i = 0; i < m; i++) {
          let zCorr = 0;
          const rowL = L[i];
          for (let j = 0; j <= i; j++) zCorr += rowL[j] * epsBuf[j];
          const pl = blk.players[i];
          const gIdx = blk.globalIndices[i];
          playerRemImp[gIdx] = sampleSkewedRemaining(zCorr, pl.remMeanImproved, pl.remSdImproved, pl.skewness);
          playerRemSlp[gIdx] = pl.remMeanSleeper + pl.remSdSleeper * epsBuf[i];
        }
      }

      // 2. Sum each team's simulated score
      for (let i = 0; i < numTeams; i++) {
        const ct = compiledTeams[i];
        let remImp = 0;
        let remSlp = 0;
        const indices = ct.starterSimIndices;
        for (let k = 0; k < indices.length; k++) {
          const idx = indices[k];
          remImp += playerRemImp[idx];
          remSlp += playerRemSlp[idx];
        }
        const totImp = ct.currentPts + remImp;
        const totSlp = ct.currentPts + remSlp;
        trialScoresImp[i] = totImp;
        trialScoresSlp[i] = totSlp;
        sortedImp[i] = totImp;
        sortedSlp[i] = totSlp;

        teamSamplesImp[i][s] = totImp;
        scoreSumImp[i] += totImp;
        scoreSqSumImp[i] += totImp * totImp;
      }

      sortedImp.sort();
      sortedSlp.sort();
      const midRight = Math.floor(numTeams / 2);
      const midLeft = Math.max(0, midRight - 1);
      const medImp = 0.5 * (sortedImp[midLeft] + sortedImp[midRight]);
      const medSlp = 0.5 * (sortedSlp[midLeft] + sortedSlp[midRight]);
      medianSamplesImp[s] = medImp;
      medianSamplesSlp[s] = medSlp;

      for (let i = 0; i < numTeams; i++) {
        const opp = oppIndex[i];
        let wonH2HImp = 0;
        if (opp >= 0) {
          if (trialScoresImp[i] > trialScoresImp[opp]) wonH2HImp = 1;
          else if (trialScoresImp[i] === trialScoresImp[opp]) wonH2HImp = 0.5;

          if (trialScoresSlp[i] > trialScoresSlp[opp]) h2hWinsSlp[i] += 1;
          else if (trialScoresSlp[i] === trialScoresSlp[opp]) h2hWinsSlp[i] += 0.5;
        }
        h2hWinsImp[i] += wonH2HImp;

        let wonMedImp = 0;
        if (trialScoresImp[i] > medImp) wonMedImp = 1;
        else if (trialScoresImp[i] === medImp) wonMedImp = 0.5;
        medianWinsImp[i] += wonMedImp;

        if (trialScoresSlp[i] > medSlp) medianWinsSlp[i] += 1;
        else if (trialScoresSlp[i] === medSlp) medianWinsSlp[i] += 0.5;

        if (wonH2HImp === 1 && wonMedImp === 1) winBothImp[i] += 1;
        else if (wonH2HImp === 0 && wonMedImp === 0) winZeroImp[i] += 1;
        else winOneImp[i] += 1;
      }
    }

    medianSamplesImp.sort();
    const medianMeanImp = medianSamplesImp.reduce((a, b) => a + b, 0) / numSims;
    const medianSdImp = Math.sqrt(
      medianSamplesImp.reduce((acc, v) => acc + (v - medianMeanImp) ** 2, 0) / numSims
    );

    const midR = Math.floor(numTeams / 2);
    const midL = Math.max(0, midR - 1);
    const staticSleeperProjs = rostersData.map((r) => r.sleeperTotalProj).sort((a, b) => a - b);
    const sleeperStaticMedian = 0.5 * ((staticSleeperProjs[midL] || 0) + (staticSleeperProjs[midR] || 0));

    const staticImprovedProjs = rostersData.map((r) => r.improvedTotalProj).sort((a, b) => a - b);
    const improvedStaticMedian = 0.5 * ((staticImprovedProjs[midL] || 0) + (staticImprovedProjs[midR] || 0));

    const minMed = medianSamplesImp[Math.floor(numSims * 0.005)];
    const maxMed = medianSamplesImp[Math.floor(numSims * 0.995)];
    const numBins = 24;
    const binWidth = Math.max(0.25, (maxMed - minMed) / numBins);
    const medianHistogram = [];
    for (let b = 0; b < numBins; b++) {
      medianHistogram.push({
        binStart: Number((minMed + b * binWidth).toFixed(2)),
        binEnd: Number((minMed + (b + 1) * binWidth).toFixed(2)),
        binMid: Number((minMed + (b + 0.5) * binWidth).toFixed(2)),
        count: 0,
        density: 0
      });
    }
    for (let s = 0; s < numSims; s++) {
      const val = medianSamplesImp[s];
      const bIdx = Math.min(numBins - 1, Math.max(0, Math.floor((val - minMed) / binWidth)));
      medianHistogram[bIdx].count++;
    }
    for (const bin of medianHistogram) {
      bin.density = Number((bin.count / numSims).toFixed(4));
    }

    const teamSimResults = rostersData.map((r, i) => {
      const samples = teamSamplesImp[i];
      samples.sort();
      const meanSim = scoreSumImp[i] / numSims;
      const sdSim = Math.sqrt(Math.max(0, scoreSqSumImp[i] / numSims - meanSim * meanSim));

      const h2hProbImp = Math.min(0.999, Math.max(0.001, h2hWinsImp[i] / numSims));
      const h2hProbSlp = Math.min(0.999, Math.max(0.001, h2hWinsSlp[i] / numSims));
      const medProbImp = Math.min(0.999, Math.max(0.001, medianWinsImp[i] / numSims));
      const medProbSlp = Math.min(0.999, Math.max(0.001, medianWinsSlp[i] / numSims));

      const opp = oppIndex[i];
      const selfDone = compiledTeams[i].starterSimIndices.length === 0;
      const oppDone = opp >= 0 ? compiledTeams[opp].starterSimIndices.length === 0 : true;
      const finalH2hImp = (selfDone && oppDone && opp >= 0)
        ? (r.currentPts > rostersData[opp].currentPts ? 1.0 : (r.currentPts < rostersData[opp].currentPts ? 0.0 : 0.5))
        : h2hProbImp;
      const finalH2hSlp = (selfDone && oppDone && opp >= 0) ? finalH2hImp : h2hProbSlp;

      return {
        rosterId: r.rosterId,
        simMean: Number(meanSim.toFixed(2)),
        simSd: Number(sdSim.toFixed(2)),
        p10: Number(samples[Math.floor(numSims * 0.10)].toFixed(2)),
        p25: Number(samples[Math.floor(numSims * 0.25)].toFixed(2)),
        p50: Number(samples[Math.floor(numSims * 0.50)].toFixed(2)),
        p75: Number(samples[Math.floor(numSims * 0.75)].toFixed(2)),
        p90: Number(samples[Math.floor(numSims * 0.90)].toFixed(2)),
        h2hWinProbImproved: Number(finalH2hImp.toFixed(4)),
        h2hWinProbSleeper: Number(finalH2hSlp.toFixed(4)),
        medianWinProbImproved: Number(medProbImp.toFixed(4)),
        medianWinProbSleeper: Number(medProbSlp.toFixed(4)),
        prob2_0: Number((winBothImp[i] / numSims).toFixed(4)),
        prob1_1: Number((winOneImp[i] / numSims).toFixed(4)),
        prob0_2: Number((winZeroImp[i] / numSims).toFixed(4)),
        expectedWeeklyWins: Number((finalH2hImp + medProbImp).toFixed(3))
      };
    });

    return {
      numSims,
      leagueMedian: {
        expectedMedianImproved: Number(medianMeanImp.toFixed(2)),
        staticMedianImproved: Number(improvedStaticMedian.toFixed(2)),
        staticMedianSleeper: Number(sleeperStaticMedian.toFixed(2)),
        medianDiffVsSleeper: Number((medianMeanImp - sleeperStaticMedian).toFixed(2)),
        sd: Number(medianSdImp.toFixed(2)),
        p10: Number(medianSamplesImp[Math.floor(numSims * 0.10)].toFixed(2)),
        p25: Number(medianSamplesImp[Math.floor(numSims * 0.25)].toFixed(2)),
        p50: Number(medianSamplesImp[Math.floor(numSims * 0.50)].toFixed(2)),
        p75: Number(medianSamplesImp[Math.floor(numSims * 0.75)].toFixed(2)),
        p90: Number(medianSamplesImp[Math.floor(numSims * 0.90)].toFixed(2)),
        histogram: medianHistogram
      },
      teamSimResults
    };
  }

  /**
   * SIMULATION-BASED MATCHUP & MEDIAN LINEUP OPTIMIZER
   *
   * Given a target `rosterId`:
   * 1. Pre-simulates 10,000 Common-Random-Number (CRN) correlated outcomes across ALL candidate players
   *    on `rosterId` (both starters and bench) AND all starters on the other 9 teams in the league
   *    using the exact Block-Cholesky Pairwise Correlation Matrix!
   * 2. Generates legal candidate lineups (varying competitive QB/SFLEX, RB/WR/TE/FLEX, and IDP choices).
   * 3. Evaluates every candidate lineup on the exact same 10,000 simulated slates against:
   *      - The H2H Opponent's correlated simulated score
   *      - The 9 other teams' simulated scores for the Top-5 League Median cutoff
   * 4. Also evaluates any custom "Pick K of N" subset decision (e.g., "Which 2 of these 3 players is best
   *    when 2 play on the same team?")!
   */
  function runSimulationLineupOptimizer(stateData, targetRosterId = 3, options = {}) {
    const startMs = Date.now();
    const numSims = options.numSims || 8000;
    const objective = options.objective || 'expected_wins'; // 'expected_wins' | 'h2h' | 'median' | 'sweep_2_0' | 'points'

    const rostersData = stateData.rostersData || [];
    const targetTeamIdx = rostersData.findIndex((r) => r.rosterId === Number(targetRosterId));
    if (targetTeamIdx < 0) return null;

    const targetRoster = rostersData[targetTeamIdx];
    const oppRoster = rostersData.find((r) => r.matchupId === targetRoster.matchupId && r.rosterId !== targetRoster.rosterId) || null;
    const slots = stateData.league.starterSlots || [];

    // Gather all unique players on targetRoster (starters + bench) with positive projection or completed points
    const allRosterPlayersMap = new Map();
    for (const p of [...(targetRoster.rawStarters || targetRoster.starters), ...(targetRoster.rawBench || targetRoster.bench)]) {
      if (p && p.playerId !== '0' && (p.improvedProj > 0.2 || p.currentPts > 0)) {
        allRosterPlayersMap.set(p.playerId, p);
      }
    }
    const rosterPool = Array.from(allRosterPlayersMap.values());

    // Build global set of active players across ALL 10 teams + targetRoster's bench candidates for CRN Cholesky simulation
    const simPlayersById = new Map();
    const gameBuckets = new Map();

    const registerSimPlayer = (p) => {
      if (!p || p.playerId === '0') return;
      if (p.remMeanImproved > 0.001 || p.remSdImproved > 0.001) {
        if (!simPlayersById.has(p.playerId)) {
          simPlayersById.set(p.playerId, p);
          const gKey = p.gameId || `solo_${p.playerId}`;
          if (!gameBuckets.has(gKey)) gameBuckets.set(gKey, []);
          gameBuckets.get(gKey).push(p);
        }
      }
    };

    for (const p of rosterPool) registerSimPlayer(p);
    for (const r of rostersData) {
      for (const p of r.starters) registerSimPlayer(p);
    }

    const gameBlocks = [];
    const playerSimSlot = new Map();
    let totalActiveSimPlayers = 0;

    for (const [, bucket] of gameBuckets.entries()) {
      const m = bucket.length;
      const corr = Array.from({ length: m }, () => new Float64Array(m));
      for (let i = 0; i < m; i++) {
        corr[i][i] = 1.0;
        for (let j = i + 1; j < m; j++) {
          const c = computePairwisePlayerCorrelation(bucket[i], bucket[j]);
          corr[i][j] = c;
          corr[j][i] = c;
        }
      }
      const L = computeCholeskyFactor(corr);
      const globalIndices = new Int32Array(m);
      for (let i = 0; i < m; i++) {
        const gIdx = totalActiveSimPlayers++;
        globalIndices[i] = gIdx;
        playerSimSlot.set(bucket[i].playerId, gIdx);
      }
      gameBlocks.push({ m, L, players: bucket, globalIndices });
    }

    // Generate 10,000 CRN realizations for every player and for the other 9 teams
    const rng = new FastRNG(20261031);
    const playerTotalMatrix = Array.from({ length: totalActiveSimPlayers }, () => new Float32Array(numSims));
    const epsBuf = new Float64Array(40);

    for (let s = 0; s < numSims; s++) {
      for (let b = 0; b < gameBlocks.length; b++) {
        const blk = gameBlocks[b];
        const m = blk.m;
        const L = blk.L;
        for (let i = 0; i < m; i++) epsBuf[i] = rng.nextGaussian();
        for (let i = 0; i < m; i++) {
          let zCorr = 0;
          const rowL = L[i];
          for (let j = 0; j <= i; j++) zCorr += rowL[j] * epsBuf[j];
          const pl = blk.players[i];
          const gIdx = blk.globalIndices[i];
          const rem = sampleSkewedRemaining(zCorr, pl.remMeanImproved, pl.remSdImproved, pl.skewness);
          playerTotalMatrix[gIdx][s] = pl.currentPts + rem;
        }
      }
    }

    // Compute the 9 other teams' total scores in each trial s, and determine:
    //  - Opponent's score in trial s: oppTrialScores[s]
    //  - The 5th-highest score among the OTHER 9 teams in trial s: fifthOtherScore[s]
    //    (Why? In a 10-team league, Target Team finishes in the Top 5 if and only if
    //     Target Team's score > the 5th-highest score among the other 9 teams!)
    const otherTeamsIndices = [];
    let oppOtherIdx = -1;
    for (let i = 0; i < rostersData.length; i++) {
      if (i === targetTeamIdx) continue;
      if (oppRoster && rostersData[i].rosterId === oppRoster.rosterId) {
        oppOtherIdx = otherTeamsIndices.length;
      }
      otherTeamsIndices.push(i);
    }

    const otherTeamsSimData = otherTeamsIndices.map((rIdx) => {
      const r = rostersData[rIdx];
      let lockedPts = 0;
      const activeSimIds = [];
      for (const p of r.starters) {
        const sIdx = playerSimSlot.get(p.playerId);
        if (sIdx !== undefined) {
          activeSimIds.push(sIdx);
        } else {
          lockedPts += p.currentPts;
        }
      }
      return { lockedPts, activeSimIds: new Int32Array(activeSimIds) };
    });

    const oppTrialScores = new Float32Array(numSims);
    const fifthOtherScore = new Float32Array(numSims);
    const nineBuf = new Float32Array(otherTeamsSimData.length);

    for (let s = 0; s < numSims; s++) {
      for (let k = 0; k < otherTeamsSimData.length; k++) {
        const ot = otherTeamsSimData[k];
        let tot = ot.lockedPts;
        const ids = ot.activeSimIds;
        for (let j = 0; j < ids.length; j++) {
          tot += playerTotalMatrix[ids[j]][s];
        }
        nineBuf[k] = tot;
        if (k === oppOtherIdx) oppTrialScores[s] = tot;
      }
      nineBuf.sort();
      // In ascending order of 9 other teams (indices 0..8):
      // Index 4 is the 5th-highest score among the other 9 teams!
      // If Target Team beats nineBuf[4], at most 4 other teams scored higher -> Target Team is Top 5!
      fifthOtherScore[s] = nineBuf[Math.max(0, nineBuf.length - 5)];
    }

    // Helper to evaluate ANY 14-player lineup array in ~0.2ms using precomputed CRN matrices!
    function evaluateCandidateLineup(lineupPlayers) {
      let lockedSum = 0;
      let expectedPts = 0;
      let sleeperPts = 0;
      const simIds = [];

      for (const p of lineupPlayers) {
        if (!p || p.playerId === '0') continue;
        expectedPts += p.improvedProj;
        sleeperPts += p.sleeperProj;
        const sIdx = playerSimSlot.get(p.playerId);
        if (sIdx !== undefined) {
          simIds.push(sIdx);
        } else {
          lockedSum += p.currentPts;
        }
      }

      const activeIds = new Int32Array(simIds);
      let h2hWins = 0;
      let medWins = 0;
      let bothWins = 0;
      let zeroWins = 0;
      let sumScore = 0;
      let sumSqScore = 0;
      let sumDiffSq = 0;
      const samples = new Float32Array(numSims);

      for (let s = 0; s < numSims; s++) {
        let score = lockedSum;
        for (let j = 0; j < activeIds.length; j++) {
          score += playerTotalMatrix[activeIds[j]][s];
        }
        samples[s] = score;
        sumScore += score;
        sumSqScore += score * score;

        const oppS = oppTrialScores[s];
        const diff = score - oppS;
        sumDiffSq += diff * diff;

        const wonH2H = score > oppS ? 1 : (score === oppS ? 0.5 : 0);
        const wonMed = score > fifthOtherScore[s] ? 1 : (score === fifthOtherScore[s] ? 0.5 : 0);
        h2hWins += wonH2H;
        medWins += wonMed;
        if (wonH2H === 1 && wonMed === 1) bothWins++;
        else if (wonH2H === 0 && wonMed === 0) zeroWins++;
      }

      samples.sort();
      const meanSim = sumScore / numSims;
      const sdSim = Math.sqrt(Math.max(0, sumSqScore / numSims - meanSim * meanSim));
      const h2hProb = h2hWins / numSims;
      const medProb = medWins / numSims;
      const prob2_0 = bothWins / numSims;
      const prob0_2 = zeroWins / numSims;
      const prob1_1 = Math.max(0, 1 - prob2_0 - prob0_2);
      const expWins = h2hProb + medProb;

      return {
        expectedPts: Number(expectedPts.toFixed(2)),
        sleeperPts: Number(sleeperPts.toFixed(2)),
        simMean: Number(meanSim.toFixed(2)),
        simSd: Number(sdSim.toFixed(2)),
        p10: Number(samples[Math.floor(numSims * 0.10)].toFixed(2)),
        p50: Number(samples[Math.floor(numSims * 0.50)].toFixed(2)),
        p90: Number(samples[Math.floor(numSims * 0.90)].toFixed(2)),
        h2hWinProb: Number(h2hProb.toFixed(4)),
        medianWinProb: Number(medProb.toFixed(4)),
        prob2_0: Number(prob2_0.toFixed(4)),
        prob1_1: Number(prob1_1.toFixed(4)),
        prob0_2: Number(prob0_2.toFixed(4)),
        expectedWeeklyWins: Number(expWins.toFixed(4))
      };
    }

    // Generate candidate offensive + IDP lineups systematically:
    // Lock any player whose game is already 'complete' or 'in_game' in their current starter slot!
    const rawStarters = targetRoster.rawStarters || targetRoster.starters;
    const lockedSlots = new Array(slots.length).fill(null);
    const lockedPlayerIds = new Set();

    for (let i = 0; i < slots.length; i++) {
      const st = rawStarters[i];
      if (st && st.playerId !== '0' && (st.gameStatus === 'complete' || st.gameStatus === 'in_game')) {
        lockedSlots[i] = st;
        lockedPlayerIds.add(st.playerId);
      }
    }

    // Candidate pool by position for unlocked slots (excluding BYE and Out/IR)
    const activePool = rosterPool.filter((p) => {
      if (lockedPlayerIds.has(p.playerId)) return false;
      const isOut = ['Out', 'IR', 'Doubtful', 'Suspension', 'COV'].includes(p.injuryStatus);
      return p.gameStatus !== 'bye' && !isOut && p.improvedProj > 0.5;
    }).sort((a, b) => b.improvedProj - a.improvedProj);

    const qbs = activePool.filter((p) => p.canonicalPos === 'QB').slice(0, 4);
    const rbs = activePool.filter((p) => p.canonicalPos === 'RB').slice(0, 6);
    const wrs = activePool.filter((p) => p.canonicalPos === 'WR').slice(0, 7);
    const tes = activePool.filter((p) => p.canonicalPos === 'TE').slice(0, 3);
    const idps = activePool.filter((p) => ['DL', 'LB', 'DB'].includes(p.canonicalPos)).slice(0, 6);

    // Backtracking generator for top distinct legal offensive + IDP combinations
    const candidateLineups = [];
    const seenLineupSets = new Set();

    // Sort candidate pool per slot
    const slotPools = slots.map((slot, idx) => {
      if (lockedSlots[idx]) return [lockedSlots[idx]];
      const eligible = activePool.filter((p) => isEligibleForSlot(p, slot));
      // Keep top candidates per slot so branching stays compact & covers all close decisions
      const limit = (slot === 'FLEX' || slot === 'SUPER_FLEX') ? 6 : (slot === 'WR' || slot === 'RB' ? 5 : 3);
      return eligible.slice(0, limit);
    });

    // Greedy baseline max-projection lineup first
    function buildGreedyLineup(scoreKey = 'improvedProj') {
      const used = new Set(lockedPlayerIds);
      const lineup = [...lockedSlots];
      // Fill tighter single-position slots first, then FLEX / SUPER_FLEX / IDP_FLEX
      const slotOrder = slots
        .map((s, i) => ({ s, i, priority: s.includes('FLEX') ? 2 : 1 }))
        .sort((a, b) => a.priority - b.priority);

      for (const { s, i } of slotOrder) {
        if (lineup[i]) continue;
        const candidates = activePool
          .filter((p) => !used.has(p.playerId) && isEligibleForSlot(p, s))
          .sort((a, b) => b[scoreKey] - a[scoreKey]);
        if (candidates.length > 0) {
          lineup[i] = { ...candidates[0], slot: s };
          used.add(candidates[0].playerId);
        } else {
          lineup[i] = rawStarters[i] || { playerId: '0', fullName: 'Empty Slot', slot: s, currentPts: 0, improvedProj: 0, sleeperProj: 0 };
        }
      }
      return lineup;
    }

    const maxPtsLineup = buildGreedyLineup('improvedProj');
    const maxPtsBenchmark = maxPtsLineup.reduce((acc, p) => acc + (p ? p.improvedProj : 0), 0);

    // Search combinations near the top projection frontier (within 8.5 points of max mean projection)
    const currentAssignment = new Array(slots.length);
    const usedInSearch = new Set(lockedPlayerIds);

    // Precompute max possible remaining points from slot idx..end for branch-and-bound pruning
    const maxSlotProj = slotPools.map((pool) => (pool.length > 0 ? pool[0].improvedProj : 0));
    const suffixMax = new Float64Array(slots.length + 1);
    for (let i = slots.length - 1; i >= 0; i--) {
      suffixMax[i] = suffixMax[i + 1] + maxSlotProj[i];
    }

    function searchLineups(slotIdx, runningProj) {
      if (candidateLineups.length >= 160) return;
      if (runningProj + suffixMax[slotIdx] < maxPtsBenchmark - 8.5) return;

      if (slotIdx === slots.length) {
        const idsKey = currentAssignment
          .map((p) => p.playerId)
          .slice()
          .sort()
          .join(',');
        if (!seenLineupSets.has(idsKey)) {
          seenLineupSets.add(idsKey);
          candidateLineups.push(currentAssignment.map((p, i) => ({ ...p, slot: slots[i] })));
        }
        return;
      }

      if (lockedSlots[slotIdx]) {
        currentAssignment[slotIdx] = lockedSlots[slotIdx];
        searchLineups(slotIdx + 1, runningProj + lockedSlots[slotIdx].improvedProj);
        return;
      }

      const pool = slotPools[slotIdx];
      if (!pool || pool.length === 0) {
        const fallback = { playerId: '0', fullName: 'Empty Slot', slot: slots[slotIdx], currentPts: 0, improvedProj: 0, sleeperProj: 0 };
        currentAssignment[slotIdx] = fallback;
        searchLineups(slotIdx + 1, runningProj);
        return;
      }

      let triedAny = false;
      for (let k = 0; k < pool.length; k++) {
        const cand = pool[k];
        if (usedInSearch.has(cand.playerId)) continue;
        triedAny = true;
        usedInSearch.add(cand.playerId);
        currentAssignment[slotIdx] = cand;
        searchLineups(slotIdx + 1, runningProj + cand.improvedProj);
        usedInSearch.delete(cand.playerId);
      }
      if (!triedAny) {
        const fallback = { playerId: '0', fullName: 'Empty Slot', slot: slots[slotIdx], currentPts: 0, improvedProj: 0, sleeperProj: 0 };
        currentAssignment[slotIdx] = fallback;
        searchLineups(slotIdx + 1, runningProj);
      }
    }

    searchLineups(0, 0);

    // Ensure Current Set Lineup and Sleeper Max-Proj Lineup are also evaluated for comparison
    const currentSetMetrics = evaluateCandidateLineup(rawStarters);
    const sleeperMaxLineup = buildGreedyLineup('sleeperProj');
    const sleeperMaxMetrics = evaluateCandidateLineup(sleeperMaxLineup);

    // Evaluate all candidate lineups on the 10,000 CRN simulations
    const evaluatedCandidates = candidateLineups.map((lineup) => {
      const metrics = evaluateCandidateLineup(lineup);
      // Analyze internal correlations & opponent correlations in this lineup
      const stackPairs = [];
      const cannibalPairs = [];
      const oppCorrelations = [];

      for (let i = 0; i < lineup.length; i++) {
        const pA = lineup[i];
        if (!pA || pA.playerId === '0') continue;
        for (let j = i + 1; j < lineup.length; j++) {
          const pB = lineup[j];
          if (!pB || pB.playerId === '0') continue;
          const c = computePairwisePlayerCorrelation(pA, pB);
          if (c >= 0.12) {
            stackPairs.push({ pA: pA.shortName, pB: pB.shortName, teamA: pA.team, teamB: pB.team, corr: c });
          } else if (c <= -0.10) {
            cannibalPairs.push({ pA: pA.shortName, pB: pB.shortName, team: pA.team, corr: c });
          }
        }
        if (oppRoster) {
          for (const oppP of oppRoster.starters) {
            if (!oppP || oppP.playerId === '0') continue;
            const cOpp = computePairwisePlayerCorrelation(pA, oppP);
            if (Math.abs(cOpp) >= 0.10) {
              oppCorrelations.push({
                ownPlayer: pA.shortName,
                oppPlayer: oppP.shortName,
                team: pA.team,
                corr: cOpp
              });
            }
          }
        }
      }

      return {
        lineup,
        metrics,
        stackPairs,
        cannibalPairs,
        oppCorrelations
      };
    });

    // Sort candidate lineups by the selected optimization objective
    const sortFn = (a, b) => {
      if (objective === 'h2h') return b.metrics.h2hWinProb - a.metrics.h2hWinProb || b.metrics.expectedPts - a.metrics.expectedPts;
      if (objective === 'median') return b.metrics.medianWinProb - a.metrics.medianWinProb || b.metrics.expectedPts - a.metrics.expectedPts;
      if (objective === 'sweep_2_0') return b.metrics.prob2_0 - a.metrics.prob2_0 || b.metrics.expectedWeeklyWins - a.metrics.expectedWeeklyWins;
      if (objective === 'points') return b.metrics.expectedPts - a.metrics.expectedPts;
      return b.metrics.expectedWeeklyWins - a.metrics.expectedWeeklyWins || b.metrics.expectedPts - a.metrics.expectedPts;
    };

    evaluatedCandidates.sort(sortFn);
    const rawOptimalCandidate = evaluatedCandidates[0] || { lineup: maxPtsLineup, metrics: evaluateCandidateLineup(maxPtsLineup), stackPairs: [], cannibalPairs: [], oppCorrelations: [] };

    // Align optimal lineup slot assignments with current starters so continuing starters stay in their original slots whenever valid
    function alignLineupSlotsWithCurrent(optLineup, currStarters) {
      const realPlayers = optLineup.filter((p) => p && p.playerId && p.playerId !== '0');
      const bestSlotAssign = new Array(slots.length).fill(null);
      let bestMatchScore = -1;

      // Sort players so more constrained positions are placed first
      const orderedPlayers = [...realPlayers].sort((a, b) => {
        const eligA = slots.filter((s) => isEligibleForSlot(a, s)).length;
        const eligB = slots.filter((s) => isEligibleForSlot(b, s)).length;
        return eligA - eligB;
      });

      const currentSlotAssignment = new Array(slots.length).fill(null);

      function backtrackAssign(pIdx, matchScore) {
        if (matchScore + (orderedPlayers.length - pIdx) * 10 <= bestMatchScore) return;
        if (pIdx === orderedPlayers.length) {
          if (matchScore > bestMatchScore) {
            bestMatchScore = matchScore;
            for (let s = 0; s < slots.length; s++) {
              bestSlotAssign[s] = currentSlotAssignment[s];
            }
          }
          return;
        }

        const p = orderedPlayers[pIdx];
        // Prefer slots where p is currently starting in currStarters
        const candidateSlots = [];
        for (let s = 0; s < slots.length; s++) {
          if (currentSlotAssignment[s] !== null) continue;
          if (!isEligibleForSlot(p, slots[s])) continue;
          const isExactSlot = currStarters[s] && currStarters[s].playerId === p.playerId;
          const isSameSlotType = p.slot === slots[s];
          const gain = isExactSlot ? 10 : (isSameSlotType ? 2 : 0);
          candidateSlots.push({ s, gain });
        }
        candidateSlots.sort((a, b) => b.gain - a.gain);

        for (const { s, gain } of candidateSlots) {
          currentSlotAssignment[s] = { ...p, slot: slots[s] };
          backtrackAssign(pIdx + 1, matchScore + gain);
          currentSlotAssignment[s] = null;
        }
      }

      backtrackAssign(0, 0);

      if (bestMatchScore >= 0) {
        return slots.map((slotName, idx) =>
          bestSlotAssign[idx] || { playerId: '0', fullName: 'Empty Slot', shortName: 'Empty', team: 'FA', position: slotName, slot: slotName, currentPts: 0, improvedProj: 0, sleeperProj: 0 }
        );
      }
      return optLineup;
    }

    const alignedOptimalLineup = alignLineupSlotsWithCurrent(rawOptimalCandidate.lineup, rawStarters);
    const optimalCandidate = {
      ...rawOptimalCandidate,
      lineup: alignedOptimalLineup
    };

    // Identify true swaps between Optimal Lineup and Current Set Lineup
    const optimalStarterIds = new Set(optimalCandidate.lineup.map((p) => p.playerId).filter((id) => id !== '0'));
    const currentStarterIds = new Set(rawStarters.map((p) => p.playerId).filter((id) => id !== '0'));

    const recommendedSwaps = [];
    for (let i = 0; i < slots.length; i++) {
      const currP = rawStarters[i];
      const optP = optimalCandidate.lineup[i];
      if (!optP) continue;
      const currId = currP ? currP.playerId : '0';
      const optId = optP ? optP.playerId : '0';
      if (currId !== optId) {
        // Build human-readable quantitative reasons for this swap
        const reasons = [];
        const projDelta = Number(((optP.improvedProj || 0) - (currP ? currP.improvedProj || 0 : 0)).toFixed(2));
        if (currId === '0' || (currP && currP.gameStatus === 'bye') || (currP && ['Out', 'IR', 'Doubtful'].includes(currP.injuryStatus))) {
          reasons.push(`Fills open/inactive ${slots[i]} slot (+${projDelta.toFixed(2)} pts)`);
        } else if (projDelta > 0) {
          reasons.push(`+${projDelta.toFixed(2)} blended market projection edge`);
        }
        if (optP.sportsbookProj && optP.sportsbookProj > optP.sleeperProj + 0.4) {
          reasons.push(`Sportsbook props (${optP.sportsbookProj.toFixed(1)}) bullish vs Sleeper (${optP.sleeperProj.toFixed(1)})`);
        }
        // Check if optP stacks with another optimal starter
        for (const otherP of optimalCandidate.lineup) {
          if (!otherP || otherP.playerId === '0' || otherP.playerId === optP.playerId) continue;
          const c = computePairwisePlayerCorrelation(optP, otherP);
          if (c >= 0.14) {
            reasons.push(`Positive correlation stack with ${otherP.shortName} (ρ = +${c.toFixed(2)})`);
          }
        }
        // Check if currP had negative cannibalization with another optimal starter
        if (currP && currId !== '0') {
          for (const otherP of optimalCandidate.lineup) {
            if (!otherP || otherP.playerId === '0' || otherP.playerId === optP.playerId) continue;
            const cOld = computePairwisePlayerCorrelation(currP, otherP);
            if (cOld <= -0.10) {
              reasons.push(`Avoids ${currP.team} same-team cannibalization with ${otherP.shortName} (ρ = ${cOld.toFixed(2)})`);
            }
          }
        }

        recommendedSwaps.push({
          slotIndex: i,
          slot: slots[i],
          outPlayer: currP,
          inPlayer: optP,
          isTrueAddition: !currentStarterIds.has(optId),
          isTrueRemoval: currId === '0' || !optimalStarterIds.has(currId),
          projDelta,
          reasons,
          summaryReason: reasons.join(' • ') || 'Optimizes joint simulation win probability'
        });
      }
    }

    // Helper to check if a set of active players can legally fit into the league's 14 starter slots
    function checkLineupSlotValidity(activePlayersList) {
      const realList = activePlayersList.filter((p) => p && p.playerId && p.playerId !== '0');
      const usedSlot = new Array(slots.length).fill(false);
      // Sort most constrained players first
      const sorted = [...realList].sort((a, b) => {
        const cA = slots.filter((s) => isEligibleForSlot(a, s)).length;
        const cB = slots.filter((s) => isEligibleForSlot(b, s)).length;
        return cA - cB;
      });
      function matchPlayer(idx) {
        if (idx === sorted.length) return true;
        const p = sorted[idx];
        for (let s = 0; s < slots.length; s++) {
          if (!usedSlot[s] && isEligibleForSlot(p, slots[s])) {
            usedSlot[s] = true;
            if (matchPlayer(idx + 1)) return true;
            usedSlot[s] = false;
          }
        }
        return false;
      }
      const isValid = matchPlayer(0);
      return {
        isValid,
        note: isValid ? 'Valid 14-Slot Roster Fit' : 'Exceeds Positional Slot Cap (e.g. >4 RBs)'
      };
    }

    // Build smart presets for the "Best K of N" Same-Team / Close-Projection Conflict Analyzer
    const skillPool = activePool.filter((p) => ['RB', 'WR', 'TE'].includes(p.canonicalPos));
    const qbPool = activePool.filter((p) => p.canonicalPos === 'QB');
    const tePool = activePool.filter((p) => p.canonicalPos === 'TE');

    // Detect same-team pairs among borderline skill players (ranked #3..#11)
    const borderlineSkill = skillPool.slice(2, Math.min(10, skillPool.length));
    let sameTeamTriadIds = null;
    for (let i = 0; i < borderlineSkill.length; i++) {
      for (let j = i + 1; j < borderlineSkill.length; j++) {
        if (borderlineSkill[i].team === borderlineSkill[j].team) {
          const p1 = borderlineSkill[i];
          const p2 = borderlineSkill[j];
          const avgProj = 0.5 * (p1.improvedProj + p2.improvedProj);
          // Prefer a 3rd player from a different team who is the top bench contender (or borderline starter)
          // and whose position ensures all 2-of-3 combinations are slot-valid
          const baseWithoutPair = optimalCandidate.lineup.filter(
            (p) => p && p.playerId !== '0' && p.playerId !== p1.playerId && p.playerId !== p2.playerId
          );
          const otherCands = borderlineSkill
            .filter((p) => p.playerId !== p1.playerId && p.playerId !== p2.playerId && p.team !== p1.team)
            .sort((a, b) => {
              // Prefer bench contenders so 2 of the 3 are starters and 1 is the top bench challenger
              const aInOpt = optimalStarterIds.has(a.playerId) ? 1 : 0;
              const bInOpt = optimalStarterIds.has(b.playerId) ? 1 : 0;
              const aValidAll = (
                checkLineupSlotValidity([...baseWithoutPair, p1, a]).isValid &&
                checkLineupSlotValidity([...baseWithoutPair, p2, a]).isValid
              ) ? 0 : 1;
              const bValidAll = (
                checkLineupSlotValidity([...baseWithoutPair, p1, b]).isValid &&
                checkLineupSlotValidity([...baseWithoutPair, p2, b]).isValid
              ) ? 0 : 1;
              if (aValidAll !== bValidAll) return aValidAll - bValidAll;
              if (aInOpt !== bInOpt) return aInOpt - bInOpt;
              return Math.abs(a.improvedProj - avgProj) - Math.abs(b.improvedProj - avgProj);
            });
          const thirdCand = otherCands[0];
          if (thirdCand) {
            sameTeamTriadIds = [p1.playerId, p2.playerId, thirdCand.playerId];
            break;
          }
        }
      }
      if (sameTeamTriadIds) break;
    }

    const rbWrPool = activePool.filter((p) => ['RB', 'WR'].includes(p.canonicalPos));
    const flexCluster5Ids = rbWrPool.slice(4, 9).map((p) => p.playerId);
    // For 2-of-4 (WR3 + FLEX2), take lowest RB starter + lowest WR starter + top RB bench + top WR bench
    const rbStarters = rbWrPool.filter((p) => p.canonicalPos === 'RB' && optimalStarterIds.has(p.playerId));
    const wrStarters = rbWrPool.filter((p) => p.canonicalPos === 'WR' && optimalStarterIds.has(p.playerId));
    const rbBench = rbWrPool.filter((p) => p.canonicalPos === 'RB' && !optimalStarterIds.has(p.playerId));
    const wrBench = rbWrPool.filter((p) => p.canonicalPos === 'WR' && !optimalStarterIds.has(p.playerId));
    const flexCluster4Ids = [
      rbStarters[rbStarters.length - 1]?.playerId,
      wrStarters[wrStarters.length - 1]?.playerId,
      rbBench[0]?.playerId,
      wrBench[0]?.playerId
    ].filter(Boolean);

    const analyzerPresets = [];
    if (sameTeamTriadIds && sameTeamTriadIds.length === 3) {
      const triadNames = sameTeamTriadIds.map((id) => allRosterPlayersMap.get(String(id))?.shortName).filter(Boolean);
      analyzerPresets.push({
        id: 'same_team_2_of_3',
        label: `Best 2 of 3 (Same-Team Conflict: ${triadNames.join(' / ')})`,
        playerIds: sameTeamTriadIds,
        chooseK: 2
      });
    }
    if (flexCluster5Ids.length >= 4) {
      analyzerPresets.push({
        id: 'flex_cluster_3_of_5',
        label: `Best 3 of ${flexCluster5Ids.length} (Borderline WR / FLEX Cluster)`,
        playerIds: flexCluster5Ids,
        chooseK: 3
      });
    }
    if (flexCluster4Ids.length >= 4) {
      analyzerPresets.push({
        id: 'flex_cluster_2_of_4',
        label: `Best 2 of 4 (WR3 + FLEX2 Decision)`,
        playerIds: flexCluster4Ids,
        chooseK: 2
      });
    }
    if (qbPool.length >= 3) {
      analyzerPresets.push({
        id: 'qb_superflex_2_of_n',
        label: `Best 2 of ${qbPool.length} (QB + Superflex Decision)`,
        playerIds: qbPool.map((p) => p.playerId),
        chooseK: 2
      });
    }
    if (tePool.length >= 2) {
      analyzerPresets.push({
        id: 'te_1_of_2',
        label: `Best 1 of ${tePool.length} (Tight End Decision)`,
        playerIds: tePool.map((p) => p.playerId),
        chooseK: 1
      });
    }

    // "Best K of N" Subset / Same-Team Conflict Analyzer:
    let subsetPoolIds = options.subsetPlayerIds || null;
    let subsetChooseK = options.subsetChooseK || null;

    if (!subsetPoolIds || subsetPoolIds.length < 2) {
      // Default to Preset 0 (Best 2 of 3 Same-Team Conflict if present, otherwise Borderline WR/FLEX cluster)
      if (analyzerPresets.length > 0) {
        subsetPoolIds = analyzerPresets[0].playerIds;
        subsetChooseK = analyzerPresets[0].chooseK;
      } else if (flexCluster5Ids.length >= 4) {
        subsetPoolIds = flexCluster5Ids;
        subsetChooseK = 3;
      } else {
        const fallbackSkill = skillPool.slice(2, 7);
        subsetPoolIds = fallbackSkill.map((p) => p.playerId);
        subsetChooseK = Math.min(2, Math.max(1, fallbackSkill.length - 1));
      }
    } else if (!subsetChooseK) {
      subsetChooseK = Math.min(2, Math.max(1, subsetPoolIds.length - 1));
    }

    const subsetPlayers = subsetPoolIds
      .map((id) => allRosterPlayersMap.get(String(id)))
      .filter(Boolean);

    subsetChooseK = Math.min(subsetPlayers.length, Math.max(1, Number(subsetChooseK) || 2));

    // Construct an exact fixed core of (activeStarterCount - K) players outside `subsetPlayers`
    // so that every C(N, K) combination is evaluated on the exact same 14-slot lineup baseline!
    const subsetIdSet = new Set(subsetPlayers.map((p) => p.playerId));
    const activeOptimalStarters = optimalCandidate.lineup.filter((p) => p && p.playerId && p.playerId !== '0');
    const targetCoreSize = Math.max(0, activeOptimalStarters.length - subsetChooseK);

    let fixedCoreLineup = activeOptimalStarters.filter((p) => !subsetIdSet.has(p.playerId));

    if (fixedCoreLineup.length > targetCoreSize) {
      // Need to vacate (fixedCoreLineup.length - targetCoreSize) slots from fixedCoreLineup:
      // Prefer vacating the lowest-projected unlocked starters that share positions with subsetPlayers
      const subsetPosSet = new Set(subsetPlayers.map((p) => p.canonicalPos));
      fixedCoreLineup.sort((a, b) => {
        const aLocked = lockedPlayerIds.has(a.playerId) ? 1 : 0;
        const bLocked = lockedPlayerIds.has(b.playerId) ? 1 : 0;
        if (aLocked !== bLocked) return bLocked - aLocked;
        const aSamePos = subsetPosSet.has(a.canonicalPos) ? 0 : 1;
        const bSamePos = subsetPosSet.has(b.canonicalPos) ? 0 : 1;
        if (aSamePos !== bSamePos) return bSamePos - aSamePos;
        return b.improvedProj - a.improvedProj;
      });
      fixedCoreLineup = fixedCoreLineup.slice(0, targetCoreSize);
    } else if (fixedCoreLineup.length < targetCoreSize) {
      // Need to backfill (targetCoreSize - fixedCoreLineup.length) players from activePool outside subsetIdSet
      const coreIds = new Set(fixedCoreLineup.map((p) => p.playerId));
      const subsetPosSet = new Set(subsetPlayers.map((p) => p.canonicalPos));
      const backfillCandidates = activePool
        .filter((p) => !subsetIdSet.has(p.playerId) && !coreIds.has(p.playerId))
        .sort((a, b) => {
          const aSamePos = subsetPosSet.has(a.canonicalPos) ? 1 : 0;
          const bSamePos = subsetPosSet.has(b.canonicalPos) ? 1 : 0;
          if (aSamePos !== bSamePos) return bSamePos - aSamePos;
          return b.improvedProj - a.improvedProj;
        });
      for (const cand of backfillCandidates) {
        if (fixedCoreLineup.length >= targetCoreSize) break;
        fixedCoreLineup.push(cand);
        coreIds.add(cand.playerId);
      }
    }

    const subsetComparison = [];

    function generateSubsets(arr, k, start = 0, curr = []) {
      if (curr.length === k) {
        const combined = [...fixedCoreLineup, ...curr];
        const m = evaluateCandidateLineup(combined);
        // Compute internal pairwise correlations within `curr` AND with `fixedCoreLineup`
        const pairCorrs = [];
        let sameTeamCount = 0;
        for (let i = 0; i < curr.length; i++) {
          for (let j = i + 1; j < curr.length; j++) {
            const c = computePairwisePlayerCorrelation(curr[i], curr[j]);
            if (curr[i].team === curr[j].team) sameTeamCount++;
            pairCorrs.push({
              pair: `${curr[i].shortName} (${curr[i].team}) + ${curr[j].shortName} (${curr[j].team})`,
              sameTeam: curr[i].team === curr[j].team,
              sameGame: Boolean(curr[i].gameId && curr[i].gameId === curr[j].gameId),
              corr: c
            });
          }
        }
        // Also check correlations between `curr` and locked core starters (e.g. QB-WR stack or RB-WR cannibalization)
        const coreCorrs = [];
        for (const p of curr) {
          for (const coreP of fixedCoreLineup) {
            const c = computePairwisePlayerCorrelation(p, coreP);
            if (Math.abs(c) >= 0.10) {
              if (p.team === coreP.team && c < 0) sameTeamCount++;
              coreCorrs.push({
                pair: `${p.shortName} (${p.team}) ↔ ${coreP.shortName} (${coreP.team})`,
                sameTeam: p.team === coreP.team,
                corr: c
              });
            }
          }
        }

        const isOptimalCombo = curr.every((p) => optimalStarterIds.has(p.playerId));
        const slotFit = checkLineupSlotValidity(combined);

        subsetComparison.push({
          players: curr.map((p) => ({
            playerId: p.playerId,
            shortName: p.shortName,
            fullName: p.fullName,
            team: p.team,
            position: p.position,
            improvedProj: p.improvedProj,
            sleeperProj: p.sleeperProj,
            sportsbookProj: p.sportsbookProj
          })),
          label: curr.map((p) => `${p.shortName} (${p.team} ${p.position})`).join(' + '),
          subsetExpectedPts: Number(curr.reduce((a, b) => a + b.improvedProj, 0).toFixed(2)),
          subsetSleeperPts: Number(curr.reduce((a, b) => a + b.sleeperProj, 0).toFixed(2)),
          sameTeamCount,
          pairCorrs,
          coreCorrs,
          isOptimalCombo,
          slotFit,
          metrics: m
        });
        return;
      }
      for (let i = start; i < arr.length; i++) {
        curr.push(arr[i]);
        generateSubsets(arr, k, i + 1, curr);
        curr.pop();
      }
    }

    if (subsetPlayers.length >= subsetChooseK && subsetChooseK >= 1) {
      generateSubsets(subsetPlayers, subsetChooseK);
      subsetComparison.sort((a, b) => {
        const validA = a.slotFit?.isValid ? 1 : 0;
        const validB = b.slotFit?.isValid ? 1 : 0;
        if (validA !== validB) return validB - validA;
        return sortFn(a, b);
      });
    }

    // Build full correlation matrix for all active skill/QB candidates on the target roster for visual display
    const displayPool = activePool.slice(0, 12);
    const rosterCorrMatrix = {
      players: displayPool.map((p) => ({
        playerId: p.playerId,
        shortName: p.shortName,
        fullName: p.fullName,
        team: p.team,
        position: p.position,
        improvedProj: p.improvedProj,
        sleeperProj: p.sleeperProj,
        sportsbookProj: p.sportsbookProj
      })),
      matrix: displayPool.map((pA) =>
        displayPool.map((pB) => computePairwisePlayerCorrelation(pA, pB))
      )
    };

    return {
      computeTimeMs: Date.now() - startMs,
      numSims,
      objective,
      targetRosterId: targetRoster.rosterId,
      targetTeamName: targetRoster.teamName,
      oppTeamName: oppRoster ? oppRoster.teamName : 'Opponent',
      oppProjectedPts: oppRoster ? oppRoster.improvedTotalProj : 0,
      currentStarters: rawStarters,
      currentSetMetrics,
      sleeperMaxLineup,
      sleeperMaxMetrics,
      optimalCandidate,
      topCandidates: evaluatedCandidates.slice(0, 8),
      recommendedSwaps,
      subsetAnalyzer: {
        presets: analyzerPresets,
        availableCandidates: activePool,
        selectedPlayerIds: subsetPlayers.map((p) => p.playerId),
        chooseK: subsetChooseK,
        fixedCorePlayers: fixedCoreLineup.map((p) => ({
          playerId: p.playerId,
          shortName: p.shortName,
          team: p.team,
          position: p.position,
          improvedProj: p.improvedProj
        })),
        combinations: subsetComparison
      },
      rosterCorrMatrix,
      allRosterPlayers: rosterPool.sort((a, b) => b.improvedProj - a.improvedProj)
    };
  }

  function recomputeLeagueFromRosters(baseData, rostersData) {
    for (const r of rostersData) {
      let currentPtsSum = 0;
      let pregameTotalProj = 0;
      let sleeperTotalProj = 0;
      let improvedTotalProj = 0;
      let playersCompleted = 0;
      let playersInProgress = 0;
      let playersYetToPlay = 0;
      let playersOnByeOrOut = 0;
      let totalRemLinear = 0;

      for (const m of r.starters) {
        currentPtsSum += m.currentPts;
        pregameTotalProj += m.pregameProj;
        sleeperTotalProj += m.sleeperProj;
        improvedTotalProj += m.improvedProj;
        totalRemLinear += m.factors.linearRemFrac;

        const isOut = ['Out', 'IR', 'Doubtful', 'Suspension', 'COV'].includes(m.injuryStatus);
        if (m.gameStatus === 'bye' || (isOut && m.gameStatus !== 'complete')) {
          playersOnByeOrOut++;
        }
        if (m.gameStatus === 'in_game') playersInProgress++;
        else if (m.gameStatus === 'pre_game') playersYetToPlay++;
        else playersCompleted++;
      }

      r.currentPts = Number(currentPtsSum.toFixed(2));
      r.pregameTotalProj = Number(pregameTotalProj.toFixed(2));
      r.sleeperTotalProj = Number(sleeperTotalProj.toFixed(2));
      r.improvedTotalProj = Number(improvedTotalProj.toFixed(2));
      r.projDeltaVsSleeper = Number((improvedTotalProj - sleeperTotalProj).toFixed(2));
      r.playersCompleted = playersCompleted;
      r.playersInProgress = playersInProgress;
      r.playersYetToPlay = playersYetToPlay;
      r.playersOnByeOrOut = playersOnByeOrOut;
      r.pctComplete = Number((((r.starters.length - totalRemLinear) / Math.max(1, r.starters.length)) * 100).toFixed(1));
    }

    const simOutput = runJointLeagueSimulation(rostersData, 10000);
    const simByRoster = new Map(simOutput.teamSimResults.map((s) => [s.rosterId, s]));
    for (const r of rostersData) {
      r.simulation = simByRoster.get(r.rosterId);
    }

    const matchupsById = new Map();
    for (const r of rostersData) {
      if (!matchupsById.has(r.matchupId)) matchupsById.set(r.matchupId, []);
      matchupsById.get(r.matchupId).push(r);
    }

    const matchupCards = Array.from(matchupsById.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([matchupId, pair]) => ({
        matchupId,
        teamA: pair[0],
        teamB: pair[1] || null
      }));

    const medianLeaderboard = [...rostersData]
      .sort((a, b) => b.improvedTotalProj - a.improvedTotalProj || b.currentPts - a.currentPts)
      .map((r, idx) => ({
        rank: idx + 1,
        rosterId: r.rosterId,
        matchupId: r.matchupId,
        teamName: r.teamName,
        ownerName: r.ownerName,
        avatarUrl: r.avatarUrl,
        record: `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''}`,
        currentPts: r.currentPts,
        sleeperTotalProj: r.sleeperTotalProj,
        improvedTotalProj: r.improvedTotalProj,
        projDeltaVsSleeper: r.projDeltaVsSleeper,
        vsExpectedMedian: Number((r.improvedTotalProj - simOutput.leagueMedian.expectedMedianImproved).toFixed(2)),
        playersCompleted: r.playersCompleted,
        playersInProgress: r.playersInProgress,
        playersYetToPlay: r.playersYetToPlay,
        playersOnByeOrOut: r.playersOnByeOrOut,
        autoSubCount: r.autoSubCount || 0,
        pctComplete: r.pctComplete,
        simulation: r.simulation
      }));

    return {
      ...baseData,
      rostersData,
      leagueMedian: simOutput.leagueMedian,
      matchups: matchupCards,
      medianLeaderboard
    };
  }

  function applyAutoSubForByeOrOut(rostersData) {
    return rostersData.map((r) => {
      const clonedStarters = r.rawStarters.map((p) => ({ ...p, autoSubFor: null }));
      const availableBench = r.rawBench.map((p) => ({ ...p }));
      const usedBenchIds = new Set();
      let autoSubCount = 0;

      for (let i = 0; i < clonedStarters.length; i++) {
        const st = clonedStarters[i];
        const isOut = ['Out', 'IR', 'Doubtful', 'Suspension', 'COV'].includes(st.injuryStatus);
        const needsSub = st.gameStatus === 'bye' || (isOut && st.gameStatus === 'pre_game');
        if (!needsSub) continue;

        const slot = st.slot;
        let bestCandidate = null;
        for (const b of availableBench) {
          if (usedBenchIds.has(b.playerId)) continue;
          const bOut = ['Out', 'IR', 'Doubtful', 'Suspension', 'COV'].includes(b.injuryStatus);
          if (b.gameStatus === 'bye' || bOut || b.improvedProj <= 0.5) continue;
          if (isEligibleForSlot(b, slot)) {
            if (!bestCandidate || b.improvedProj > bestCandidate.improvedProj) {
              bestCandidate = b;
            }
          }
        }

        if (bestCandidate) {
          usedBenchIds.add(bestCandidate.playerId);
          const reasonTag = st.gameStatus === 'bye' ? 'BYE' : st.injuryStatus;
          clonedStarters[i] = {
            ...bestCandidate,
            slot,
            autoSubFor: `${st.shortName} (${reasonTag})`
          };
          autoSubCount++;
        }
      }

      const remainingBench = availableBench.filter((b) => !usedBenchIds.has(b.playerId));
      return {
        ...r,
        starters: clonedStarters,
        bench: remainingBench,
        autoSubCount
      };
    });
  }

  async function getLeagueLiveState(leagueId = DEFAULT_LEAGUE_ID, requestedWeek = null, forceRefresh = false, autoSubByeOut = false, marketWeight = 0.75) {
    const startMs = Date.now();
    const ttl = forceRefresh ? 0 : 8000;

    const [nflState, league, users, rosters, owsFeed, espnBoard] = await Promise.all([
      fetchJson('https://api.sleeper.app/v1/state/nfl', {}, ttl),
      fetchJson(`https://api.sleeper.app/v1/league/${leagueId}`, {}, ttl * 4),
      fetchJson(`https://api.sleeper.app/v1/league/${leagueId}/users`, {}, ttl * 2),
      fetchJson(`https://api.sleeper.app/v1/league/${leagueId}/rosters`, {}, ttl),
      fetchJson(OWS_SPORTSBOOK_URL, {}, 120000).catch(() => null),
      fetchJson(ESPN_SCOREBOARD_URL, {}, 60000).catch(() => null)
    ]);

    const season = league.season || nflState.season || '2026';
    const currentNflWeek = Number(nflState.display_week || nflState.week || league.settings?.leg || 8);
    const activeWeek = Number(requestedWeek || currentNflWeek);

    const canonicalPosQuery = 'position[]=DB&position[]=DL&position[]=LB&position[]=QB&position[]=RB&position[]=TE&position[]=WR&season_type=regular';
    const graphqlQuery = JSON.stringify({
      query: `query batch_scores { scores(sport: "nfl", season_type: "regular", season: "${season}", week: ${activeWeek}) { game_id status metadata date start_time } }`
    });

    const [matchups, projections, stats, scoresResp] = await Promise.all([
      fetchJson(`https://api.sleeper.app/v1/league/${leagueId}/matchups/${activeWeek}`, {}, ttl),
      fetchJson(`https://api.sleeper.com/projections/nfl/${season}/${activeWeek}?${canonicalPosQuery}`, {}, ttl * 4),
      fetchJson(`https://api.sleeper.com/stats/nfl/${season}/${activeWeek}?${canonicalPosQuery}`, {}, ttl),
      fetchJson('https://api.sleeper.com/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: graphqlQuery
      }, ttl)
    ]);

    // Build external game odds & sportsbook player prop maps (when activeWeek matches OWS/ESPN week)
    const externalOddsMap = {};
    const sbPropsByName = new Map();

    if (espnBoard && Array.isArray(espnBoard.events)) {
      for (const ev of espnBoard.events) {
        const comp = ev.competitions?.[0];
        const odds = comp?.odds?.[0];
        if (!comp || !odds) continue;
        const competitors = comp.competitors || [];
        const homeComp = competitors.find((c) => c.homeAway === 'home');
        const awayComp = competitors.find((c) => c.homeAway === 'away');
        const homeAbbr = normalizeTeamCode(homeComp?.team?.abbreviation);
        const awayAbbr = normalizeTeamCode(awayComp?.team?.abbreviation);
        if (homeAbbr && awayAbbr) {
          const entry = {
            homeTeam: homeAbbr,
            awayTeam: awayAbbr,
            total: Number(odds.overUnder || 45.5),
            homeSpread: Number(odds.spread || 0)
          };
          externalOddsMap[homeAbbr] = entry;
          externalOddsMap[awayAbbr] = entry;
        }
      }
    }

    if (owsFeed && Number(owsFeed.week) === activeWeek) {
      for (const g of (owsFeed.games || [])) {
        const homeAbbr = normalizeTeamCode(g.home);
        const awayAbbr = normalizeTeamCode(g.away);
        const favAbbr = normalizeTeamCode(g.fav);
        const spreadMag = Math.abs(Number(g.spread || 0));
        const homeSpread = favAbbr === homeAbbr ? -spreadMag : (favAbbr === awayAbbr ? spreadMag : 0);
        const entry = {
          homeTeam: homeAbbr,
          awayTeam: awayAbbr,
          total: Number(g.total || 45.5),
          homeSpread
        };
        externalOddsMap[homeAbbr] = entry;
        externalOddsMap[awayAbbr] = entry;
      }
      for (const p of (owsFeed.players || [])) {
        sbPropsByName.set(normalizePlayerName(p.n), p);
      }
    }

    const scoresList = scoresResp?.data?.scores || [];
    const gameStatesByTeam = {};
    const allGames = [];

    for (const g of scoresList) {
      const gs = analyzeGameState(g, externalOddsMap);
      allGames.push(gs);
      if (gs.homeTeam) gameStatesByTeam[gs.homeTeam] = gs;
      if (gs.awayTeam) gameStatesByTeam[gs.awayTeam] = gs;
    }

    const projMap = new Map();
    if (Array.isArray(projections)) {
      for (const p of projections) projMap.set(String(p.player_id), p);
    }
    const statMap = new Map();
    if (Array.isArray(stats)) {
      for (const s of stats) statMap.set(String(s.player_id), s);
    }

    const userMap = new Map(users.map((u) => [u.user_id, u]));
    const rosterMap = new Map(rosters.map((r) => [r.roster_id, r]));
    const scoringSettings = league.scoring_settings || {};
    const starterSlots = (league.roster_positions || []).filter((p) => p !== 'BN');

    let rostersData = matchups.map((m) => {
      const r = rosterMap.get(m.roster_id) || {};
      const u = userMap.get(r.owner_id) || {};
      const teamName = u.metadata?.team_name || u.display_name || `Team ${m.roster_id}`;
      const ownerName = u.display_name || `User ${m.roster_id}`;
      const avatarUrl = u.metadata?.avatar || (u.avatar ? `https://sleepercdn.com/avatars/thumbs/${u.avatar}` : null);

      const starterIds = (m.starters && m.starters.length ? m.starters : (r.starters || [])).map(String);
      const allPlayerIds = (m.players && m.players.length ? m.players : (r.players || [])).map(String);
      const starterPts = m.starters_points || [];
      const playersPoints = m.players_points || {};

      const buildModeledPlayer = (pidStr, actualPts, slotName) => {
        const pEntry = projMap.get(pidStr);
        const sEntry = statMap.get(pidStr);
        const pInfo = pEntry?.player || sEntry?.player || {};
        const fullName = `${pInfo.first_name || ''} ${pInfo.last_name || ''}`.trim();
        const sbEntry = sbPropsByName.get(normalizePlayerName(fullName)) || null;
        const team = normalizeTeamCode(pEntry?.team || sEntry?.team || pInfo.team || 'FA');
        const gs = gameStatesByTeam[team] || null;
        const modeled = modelPlayer(pidStr, actualPts, pEntry, sEntry, gs, scoringSettings, sbEntry, marketWeight);
        modeled.slot = slotName;
        return modeled;
      };

      const starters = starterIds.map((pidStr, idx) => {
        const actualPts = starterPts[idx] !== undefined ? starterPts[idx] : (playersPoints[pidStr] ?? 0);
        return buildModeledPlayer(pidStr, actualPts, starterSlots[idx] || 'FLEX');
      });

      const starterSet = new Set(starterIds.filter((id) => id !== '0'));
      const benchIds = allPlayerIds.filter((pid) => !starterSet.has(pid));
      const bench = benchIds
        .map((pidStr) => buildModeledPlayer(pidStr, playersPoints[pidStr] ?? 0, 'BN'))
        .sort((a, b) => b.improvedProj - a.improvedProj);

      return {
        rosterId: m.roster_id,
        matchupId: m.matchup_id,
        teamName,
        ownerName,
        avatarUrl,
        division: r.settings?.division || 1,
        wins: r.settings?.wins || 0,
        losses: r.settings?.losses || 0,
        ties: r.settings?.ties || 0,
        fptsSeason: Number(((r.settings?.fpts || 0) + (r.settings?.fpts_decimal || 0) / 100).toFixed(2)),
        rawStarters: starters,
        rawBench: bench,
        starters,
        bench,
        autoSubCount: 0
      };
    });

    if (autoSubByeOut) {
      rostersData = applyAutoSubForByeOrOut(rostersData);
    }

    const baseData = {
      timestamp: new Date().toISOString(),
      computeTimeMs: Date.now() - startMs,
      autoSubByeOut,
      marketWeight,
      sportsbookWeekLoaded: owsFeed ? Number(owsFeed.week) : null,
      league: {
        leagueId: league.league_id,
        name: league.name,
        season,
        week: activeWeek,
        currentNflWeek,
        playoffWeekStart: league.settings?.playoff_week_start || 14,
        totalRosters: league.total_rosters,
        leagueAverageMatch: Boolean(league.settings?.league_average_match),
        divisions: {
          1: league.metadata?.division_1 || 'Division 1',
          2: league.metadata?.division_2 || 'Division 2'
        },
        starterSlots
      },
      nflGames: allGames
    };

    const result = recomputeLeagueFromRosters(baseData, rostersData);
    result.computeTimeMs = Date.now() - startMs;
    return result;
  }

  return {
    DEFAULT_LEAGUE_ID,
    getLeagueLiveState,
    recomputeLeagueFromRosters,
    applyAutoSubForByeOrOut,
    runJointLeagueSimulation,
    runSimulationLineupOptimizer,
    computePairwisePlayerCorrelation,
    isEligibleForSlot
  };
});
