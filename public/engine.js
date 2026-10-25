/**
 * Universal Real-Time Sleeper Fantasy Tracker & 10,000-Trial Correlated Monte Carlo Engine
 * Works identically in the Browser (Direct CORS to Sleeper REST + GraphQL APIs) and in Node.js / Serverless.
 * Automatically adapts to future NFL weeks, seasons, real-time lineup changes, waiver claims, and trades.
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
    // Bypass browser disk cache for live endpoints when ttlMs <= 10000
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

  function analyzeGameState(gameObj) {
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
        otProb: 0
      };
    }

    const meta = gameObj.metadata || {};
    const status = gameObj.status || 'complete';
    const homeTeam = meta.home_team || gameObj.home;
    const awayTeam = meta.away_team || gameObj.away;
    const homeScore = Number(meta.home_score ?? 0);
    const awayScore = Number(meta.away_score ?? 0);

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
        otProb: 0
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
        otProb: 0.05
      };
    }

    const q = Number(meta.quarter_num || 1);
    const qSecRem = parseClockSeconds(meta.time_remaining || '15:00');

    let totalSecRem = 0;
    if (q <= 4) {
      totalSecRem = (4 - q) * 900 + qSecRem;
    } else {
      totalSecRem = Math.min(600, qSecRem);
    }

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
      otProb
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

  function modelPlayer(playerId, actualPts, projEntry, statEntry, gameState, scoringSettings) {
    const pInfo = (projEntry && projEntry.player) || (statEntry && statEntry.player) || {};
    const projStats = (projEntry && projEntry.stats) || {};
    const liveStats = (statEntry && statEntry.stats) || {};

    const firstName = pInfo.first_name || 'Player';
    const lastName = pInfo.last_name || `#${playerId}`;
    const fullName = `${firstName} ${lastName}`.trim();
    const rawPos = pInfo.position || 'WR';
    const fantasyPositions = pInfo.fantasy_positions || [rawPos];
    const pos = canonicalPos(rawPos);
    const team = (projEntry && projEntry.team) || (statEntry && statEntry.team) || pInfo.team || 'FA';
    const opponent = (projEntry && projEntry.opponent) || (statEntry && statEntry.opponent) || null;
    const injuryStatus = pInfo.injury_status || null;

    const pregameProj = computeCustomPoints(projStats, scoringSettings);
    const currentPts = (actualPts !== undefined && actualPts !== null)
      ? Number(actualPts)
      : computeCustomPoints(liveStats, scoringSettings);

    // Check if player's team is on BYE this week
    const isBye = !gameState || gameState.status === 'bye' || (!opponent && (!gameState || !gameState.homeTeam));
    if (isBye || gameState.status === 'complete') {
      const finalStatus = isBye ? 'bye' : 'complete';
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
        gameStatus: finalStatus,
        gameId: isBye ? null : gameState.gameId,
        quarter: isBye ? 0 : gameState.quarter,
        clock: isBye ? 'BYE' : 'FINAL',
        gameScore: isBye ? 'BYE WEEK' : 'FINAL',
        hasPossession: false,
        inRedZone: false,
        currentPts: isBye ? 0 : currentPts,
        pregameProj: isBye ? 0 : pregameProj,
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
          reasons: isBye ? ['On BYE Week'] : []
        }
      };
    }

    const isOut = ['Out', 'IR', 'Doubtful', 'Suspension', 'COV'].includes(injuryStatus);
    const linearRem = isOut ? 0 : gameState.linearRemFrac;
    const effectiveRem = isOut ? 0 : gameState.effectiveRemFrac;
    const elapsed = gameState.elapsedFrac;

    const remMeanSleeper = pregameProj * linearRem;
    const sleeperProj = currentPts + remMeanSleeper;

    const reasons = [];
    let bayesUsageMult = 1.0;
    let gameScriptMult = 1.0;
    let driveBonus = 0.0;

    if (isOut) {
      reasons.push(`Status: ${injuryStatus}`);
    } else if (gameState.status === 'in_game' && pregameProj > 0.5) {
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

      const isHome = (team === gameState.homeTeam);
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
          const tdShare = Math.min(0.65, Math.max(0.08, pregameProj / 24));
          driveBonus = pos === 'QB' ? 0.68 : (0.55 * tdShare + 0.18);
          reasons.push('Live in Red Zone');
        } else {
          driveBonus = pos === 'QB' ? 0.22 : 0.14 * Math.min(1, pregameProj / 14);
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
      : Math.max(0, pregameProj * effectiveRem * bayesUsageMult * gameScriptMult + driveBonus);
    const improvedProj = currentPts + remMeanImproved;

    const posVolatility = {
      QB: { cv: 0.42, baseSd: 2.2, skew: 0.55 },
      RB: { cv: 0.54, baseSd: 2.0, skew: 0.95 },
      WR: { cv: 0.64, baseSd: 2.1, skew: 1.15 },
      TE: { cv: 0.68, baseSd: 1.8, skew: 1.25 },
      DL: { cv: 0.74, baseSd: 1.5, skew: 1.35 },
      LB: { cv: 0.52, baseSd: 1.4, skew: 0.85 },
      DB: { cv: 0.66, baseSd: 1.4, skew: 1.15 }
    }[pos] || { cv: 0.60, baseSd: 1.8, skew: 1.0 };

    const fullGameSd = pregameProj > 0.2
      ? Math.sqrt(Math.pow(posVolatility.cv * pregameProj, 2) + Math.pow(posVolatility.baseSd, 2))
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
      pregameProj,
      sleeperProj,
      improvedProj,
      remMeanSleeper,
      remMeanImproved,
      remSdSleeper,
      remSdImproved,
      skewness: dynamicSkew,
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

  function runJointLeagueSimulation(rostersData, numSims = 10000) {
    const rng = new FastRNG(20261025);
    const numTeams = rostersData.length;

    const activeGames = new Set();
    const activeNflTeams = new Set();

    for (const r of rostersData) {
      for (const p of r.starters) {
        if (p.remMeanImproved > 0 || p.remSdImproved > 0) {
          if (p.gameId) activeGames.add(p.gameId);
          if (p.team) activeNflTeams.add(p.team);
        }
      }
    }

    const gameList = Array.from(activeGames);
    const nflTeamList = Array.from(activeNflTeams);
    const gameIdxMap = new Map(gameList.map((g, i) => [g, i]));
    const nflTeamIdxMap = new Map(nflTeamList.map((t, i) => [t, i]));

    const compiledTeams = rostersData.map((r, tIdx) => {
      const activePlayers = [];
      for (const p of r.starters) {
        if (p.remMeanImproved > 0.001 || p.remSdImproved > 0.001) {
          const gIdx = p.gameId ? (gameIdxMap.get(p.gameId) ?? -1) : -1;
          const tmIdx = p.team ? (nflTeamIdxMap.get(p.team) ?? -1) : -1;
          let wGame = 0.22;
          let wPass = 0.0;
          let wRush = 0.0;
          if (p.canonicalPos === 'QB') {
            wGame = 0.25; wPass = 0.62; wRush = 0.10;
          } else if (p.canonicalPos === 'WR' || p.canonicalPos === 'TE') {
            wGame = 0.22; wPass = 0.56; wRush = -0.08;
          } else if (p.canonicalPos === 'RB') {
            wGame = 0.18; wPass = 0.12; wRush = 0.52;
          } else {
            wGame = 0.18; wPass = 0.0; wRush = 0.0;
          }
          const wIdio = Math.sqrt(Math.max(0.05, 1 - wGame * wGame - wPass * wPass - wRush * wRush));
          activePlayers.push({
            muImp: p.remMeanImproved,
            sdImp: p.remSdImproved,
            muSlp: p.remMeanSleeper,
            sdSlp: p.remSdSleeper,
            skew: p.skewness,
            gIdx,
            tmIdx,
            wGame,
            wPass,
            wRush,
            wIdio
          });
        }
      }
      return {
        tIdx,
        rosterId: r.rosterId,
        matchupId: r.matchupId,
        currentPts: r.currentPts,
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

    const zGame = new Float64Array(gameList.length);
    const zPass = new Float64Array(nflTeamList.length);
    const zRush = new Float64Array(nflTeamList.length);
    const trialScoresImp = new Float64Array(numTeams);
    const trialScoresSlp = new Float64Array(numTeams);
    const sortedImp = new Float64Array(numTeams);
    const sortedSlp = new Float64Array(numTeams);

    for (let s = 0; s < numSims; s++) {
      for (let g = 0; g < zGame.length; g++) zGame[g] = rng.nextGaussian();
      for (let t = 0; t < zPass.length; t++) {
        zPass[t] = rng.nextGaussian();
        zRush[t] = rng.nextGaussian();
      }

      for (let i = 0; i < numTeams; i++) {
        const ct = compiledTeams[i];
        let remImp = 0;
        let remSlp = 0;
        const players = ct.activePlayers;
        for (let pIdx = 0; pIdx < players.length; pIdx++) {
          const pl = players[pIdx];
          const eps = rng.nextGaussian();
          const zg = pl.gIdx >= 0 ? zGame[pl.gIdx] : 0;
          const zp = pl.tmIdx >= 0 ? zPass[pl.tmIdx] : 0;
          const zr = pl.tmIdx >= 0 ? zRush[pl.tmIdx] : 0;
          const zCorr = pl.wGame * zg + pl.wPass * zp + pl.wRush * zr + pl.wIdio * eps;

          remImp += sampleSkewedRemaining(zCorr, pl.muImp, pl.sdImp, pl.skew);
          remSlp += pl.muSlp + pl.sdSlp * eps;
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
      const selfDone = compiledTeams[i].activePlayers.length === 0;
      const oppDone = opp >= 0 ? compiledTeams[opp].activePlayers.length === 0 : true;
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
   * Recompute totals, simulation, matchups, and median leaderboard from `rostersData`
   * (Allows instant 12ms client-side re-simulation when toggling Smart Auto-Sub or manual What-If bench swaps!)
   */
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

  /**
   * Apply Smart Bench Auto-Sub for BYE / OUT starters (for future weeks or unset lineups)
   */
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
        // Find highest projected eligible bench player who is active and not on BYE/OUT
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

  async function getLeagueLiveState(leagueId = DEFAULT_LEAGUE_ID, requestedWeek = null, forceRefresh = false, autoSubByeOut = false) {
    const startMs = Date.now();
    const ttl = forceRefresh ? 0 : 8000;

    const [nflState, league, users, rosters] = await Promise.all([
      fetchJson('https://api.sleeper.app/v1/state/nfl', {}, ttl),
      fetchJson(`https://api.sleeper.app/v1/league/${leagueId}`, {}, ttl * 4),
      fetchJson(`https://api.sleeper.app/v1/league/${leagueId}/users`, {}, ttl * 2),
      fetchJson(`https://api.sleeper.app/v1/league/${leagueId}/rosters`, {}, ttl)
    ]);

    const season = league.season || nflState.season || '2026';
    const currentNflWeek = Number(nflState.display_week || nflState.week || league.settings?.leg || 7);
    const activeWeek = Number(requestedWeek || currentNflWeek);

    // Canonical query order avoids 301 redirects on api.sleeper.com
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

    const scoresList = scoresResp?.data?.scores || [];
    const gameStatesByTeam = {};
    const allGames = [];

    for (const g of scoresList) {
      const gs = analyzeGameState(g);
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

    // Use roster.players as fallback if a future week's matchups array doesn't have full player list yet
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

      const starters = starterIds.map((pidStr, idx) => {
        const actualPts = starterPts[idx] !== undefined ? starterPts[idx] : (playersPoints[pidStr] ?? 0);
        const pEntry = projMap.get(pidStr);
        const sEntry = statMap.get(pidStr);
        const team = pEntry?.team || sEntry?.team || pEntry?.player?.team || 'FA';
        const gs = gameStatesByTeam[team] || null;
        const modeled = modelPlayer(pidStr, actualPts, pEntry, sEntry, gs, scoringSettings);
        modeled.slot = starterSlots[idx] || modeled.position;
        return modeled;
      });

      const starterSet = new Set(starterIds);
      const benchIds = allPlayerIds.filter((pid) => !starterSet.has(pid));
      const bench = benchIds.map((pidStr) => {
        const actualPts = playersPoints[pidStr] ?? 0;
        const pEntry = projMap.get(pidStr);
        const sEntry = statMap.get(pidStr);
        const team = pEntry?.team || sEntry?.team || pEntry?.player?.team || 'FA';
        const gs = gameStatesByTeam[team] || null;
        const modeled = modelPlayer(pidStr, actualPts, pEntry, sEntry, gs, scoringSettings);
        modeled.slot = 'BN';
        return modeled;
      }).sort((a, b) => b.improvedProj - a.improvedProj);

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
    isEligibleForSlot
  };
});
