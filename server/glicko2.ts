/**
 * Glicko-2 rating system implementation.
 * Adapted for team games: each player on the winning team gets a "win"
 * against each player on the losing team, and vice versa.
 */

const TAU = 0.5;
const CONVERGENCE_TOLERANCE = 0.000001;
const GLICKO2_SCALE = 173.7178;

export interface Glicko2Rating {
  rating: number;
  rd: number;
  volatility: number;
}

interface MatchResult {
  opponent: Glicko2Rating;
  score: number; // 1 = win, 0 = loss, 0.5 = draw
}

function toGlicko2Scale(rating: number): number {
  return (rating - 1500) / GLICKO2_SCALE;
}

function fromGlicko2Scale(mu: number): number {
  return mu * GLICKO2_SCALE + 1500;
}

function toGlicko2RD(rd: number): number {
  return rd / GLICKO2_SCALE;
}

function fromGlicko2RD(phi: number): number {
  return phi * GLICKO2_SCALE;
}

function g(phi: number): number {
  return 1 / Math.sqrt(1 + 3 * phi * phi / (Math.PI * Math.PI));
}

function E(mu: number, muJ: number, phiJ: number): number {
  return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));
}

function computeVariance(mu: number, results: MatchResult[]): number {
  let sum = 0;
  for (const result of results) {
    const muJ = toGlicko2Scale(result.opponent.rating);
    const phiJ = toGlicko2RD(result.opponent.rd);
    const gVal = g(phiJ);
    const eVal = E(mu, muJ, phiJ);
    sum += gVal * gVal * eVal * (1 - eVal);
  }
  return 1 / sum;
}

function computeDelta(mu: number, v: number, results: MatchResult[]): number {
  let sum = 0;
  for (const result of results) {
    const muJ = toGlicko2Scale(result.opponent.rating);
    const phiJ = toGlicko2RD(result.opponent.rd);
    sum += g(phiJ) * (result.score - E(mu, muJ, phiJ));
  }
  return v * sum;
}

function computeNewVolatility(sigma: number, phi: number, v: number, delta: number): number {
  const a = Math.log(sigma * sigma);
  const deltaSquared = delta * delta;
  const phiSquared = phi * phi;

  function f(x: number): number {
    const ex = Math.exp(x);
    const d = phiSquared + v + ex;
    return (ex * (deltaSquared - phiSquared - v - ex)) / (2 * d * d) - (x - a) / (TAU * TAU);
  }

  let A = a;
  let B: number;

  if (deltaSquared > phiSquared + v) {
    B = Math.log(deltaSquared - phiSquared - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0) {
      k++;
    }
    B = a - k * TAU;
  }

  let fA = f(A);
  let fB = f(B);

  while (Math.abs(B - A) > CONVERGENCE_TOLERANCE) {
    const C = A + (A - B) * fA / (fB - fA);
    const fC = f(C);

    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }

    B = C;
    fB = fC;
  }

  return Math.exp(A / 2);
}

export function updateRating(player: Glicko2Rating, results: MatchResult[]): Glicko2Rating {
  if (results.length === 0) {
    const phi = toGlicko2RD(player.rd);
    const newPhi = Math.sqrt(phi * phi + player.volatility * player.volatility);
    return {
      rating: player.rating,
      rd: fromGlicko2RD(newPhi),
      volatility: player.volatility,
    };
  }

  const mu = toGlicko2Scale(player.rating);
  const phi = toGlicko2RD(player.rd);

  const v = computeVariance(mu, results);
  const delta = computeDelta(mu, v, results);
  const newSigma = computeNewVolatility(player.volatility, phi, v, delta);

  const phiStar = Math.sqrt(phi * phi + newSigma * newSigma);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * (delta / v);

  return {
    rating: fromGlicko2Scale(newMu),
    rd: fromGlicko2RD(newPhi),
    volatility: newSigma,
  };
}

/**
 * Given a team game result, update ratings for all players.
 * winningTeam and losingTeam are arrays of player ratings.
 * Each winner gets a "win" against each loser and vice versa.
 */
export function updateTeamRatings(
  winningTeam: Glicko2Rating[],
  losingTeam: Glicko2Rating[],
): { winners: Glicko2Rating[]; losers: Glicko2Rating[] } {
  const winners = winningTeam.map((player) => {
    const results: MatchResult[] = losingTeam.map((opponent) => ({
      opponent,
      score: 1,
    }));
    return updateRating(player, results);
  });

  const losers = losingTeam.map((player) => {
    const results: MatchResult[] = winningTeam.map((opponent) => ({
      opponent,
      score: 0,
    }));
    return updateRating(player, results);
  });

  return { winners, losers };
}
