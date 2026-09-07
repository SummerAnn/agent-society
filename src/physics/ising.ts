// Ising model predictor for multi-agent belief dynamics.
//
// Implements both the vanilla Ising model (binary spins, pairwise coupling)
// and our extended model that fixes limitations of El et al. (2026):
//   1. External field h_i — corrections/interventions as magnetic field
//   2. Continuous spins — confidence-weighted stances, not binary ±1
//   3. Non-Markovian memory — coupling to past states with decay
//   4. Truth asymmetry — different effective temperatures for true vs false claims
//
// The vanilla model serves as the null hypothesis (agents = spins).
// Divergence between prediction and actual LLM behavior is our contribution.

import type { AgentSpec, Topology, StanceLabel } from "../config/schema";

// --- Types ---

export type SpinState = {
  agentId: string;
  spin: number; // vanilla: ±1, extended: continuous [-1, +1]
  conviction: number; // |2p - 1| where p = probability of current stance
};

export type IsingParams = {
  beta: number; // inverse temperature (1/T) — higher = more deterministic
  J: number[][]; // coupling matrix (signed adjacency)
  h: number[]; // external field per agent (corrections)
  mu: number[]; // memory coupling per agent
  truthBias: number[]; // truth-seeking tendency per agent
};

export type IsingTrajectory = {
  rounds: number;
  spins: number[][]; // spins[round][agentIndex]
  magnetization: number[]; // m(t) = mean of spins per round
  conviction: number[]; // mean |spin| per round
  energy: number[]; // Hamiltonian value per round
  susceptibility: number[]; // variance of magnetization (fluctuation response)
};

export type ExtendedIsingParams = IsingParams & {
  memoryKernel: number[]; // decay weights for past rounds: kernel[age]
  truthAsymmetry: number; // multiplier on coupling for true vs false claim direction
  correctionSchedule: Map<number, number[]>; // round -> field values to apply
};

// --- Topology → coupling matrix ---

export function topologyToAdjacency(
  agents: AgentSpec[],
  topology: Topology,
): number[][] {
  const n = agents.length;
  const J: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));

  if (topology === "fully-connected") {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i !== j) J[i][j] = 1;
      }
    }
  } else if (topology === "star") {
    for (let j = 1; j < n; j++) {
      J[0][j] = 1;
      J[j][0] = 1;
    }
  } else if (topology === "chain") {
    for (let i = 0; i < n - 1; i++) {
      J[i][i + 1] = 1;
      // chain in our testbed is directional (each sees previous),
      // but for Ising we symmetrize
      J[i + 1][i] = 1;
    }
  } else if (topology === "ring") {
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      J[i][next] = 1;
      J[next][i] = 1;
    }
  }

  return J;
}

// Apply signed edges: contamination agents have discordant coupling
// with truth-seeking agents. This is our extension — El et al. use
// unsigned edges from Reddit data; we derive signs from agent roles.
export function applyRoleSigns(
  J: number[][],
  agents: AgentSpec[],
): number[][] {
  const n = agents.length;
  const signed = J.map((row) => [...row]);

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (signed[i][j] === 0) continue;

      const iContam = agents[i].role === "contamination_agent";
      const jContam = agents[j].role === "contamination_agent";

      if (iContam !== jContam) {
        // Discordant edge: contamination ↔ non-contamination
        signed[i][j] = -1;
      }
      // Same role = concordant = +1 (already set)
    }
  }

  return signed;
}

// --- Agent params → Ising params ---

export function agentsToIsingParams(
  agents: AgentSpec[],
  topology: Topology,
  options: {
    temperature?: number;
    correctionFields?: number[];
  } = {},
): IsingParams {
  const n = agents.length;
  const rawJ = topologyToAdjacency(agents, topology);
  const J = applyRoleSigns(rawJ, agents);

  // Scale coupling by social weight
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      J[i][j] *= agents[i].socialWeight;
    }
  }

  // Temperature: higher socialWeight → more responsive → lower effective T
  const avgSocialWeight = agents.reduce((s, a) => s + a.socialWeight, 0) / n;
  const beta = 1 / (options.temperature ?? Math.max(0.1, 1 / (avgSocialWeight + 0.5)));

  // External field from corrections
  const h = options.correctionFields ?? new Array(n).fill(0);

  // Memory coupling from agent params (not used in vanilla)
  const mu = agents.map((a) => a.socialWeight * 0.5);

  // Truth-seeking bias — maps falseClaimBias to a directional field
  // Positive falseClaimBias → tends to endorse false claims → positive spin bias
  const truthBias = agents.map((a) => a.falseClaimBias);

  return { beta, J, h, mu, truthBias };
}

// --- Hamiltonian ---

function computeEnergy(spins: number[], params: IsingParams): number {
  const n = spins.length;
  let E = 0;

  // Coupling term: -Σ J_ij s_i s_j
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      E -= params.J[i][j] * spins[i] * spins[j];
    }
  }

  // External field: -Σ h_i s_i
  for (let i = 0; i < n; i++) {
    E -= params.h[i] * spins[i];
  }

  // Truth bias: -Σ truthBias_i s_i
  for (let i = 0; i < n; i++) {
    E -= params.truthBias[i] * spins[i];
  }

  return E;
}

// --- Local field (effective field on spin i) ---

function localField(spins: number[], i: number, params: IsingParams): number {
  let field = params.h[i] + params.truthBias[i];
  for (let j = 0; j < spins.length; j++) {
    if (j !== i) {
      field += params.J[i][j] * spins[j];
    }
  }
  return field;
}

// --- Glauber dynamics update ---

function glauberFlipProbability(
  spins: number[],
  i: number,
  params: IsingParams,
): number {
  const hLocal = localField(spins, i, params);
  // P(s_i = +1) = 1 / (1 + exp(-2β h_local))
  return 1 / (1 + Math.exp(-2 * params.beta * hLocal));
}

// --- Vanilla Ising simulation ---

export function simulateIsing(
  agents: AgentSpec[],
  topology: Topology,
  initialStances: Map<string, { stance: StanceLabel; confidence: number }>,
  rounds: number,
  options: {
    temperature?: number;
    seed?: number;
    correctionSchedule?: Map<number, number[]>;
  } = {},
): IsingTrajectory {
  const n = agents.length;
  const params = agentsToIsingParams(agents, topology, {
    temperature: options.temperature,
  });

  const rng = mulberry32(options.seed ?? 42);

  // Initialize spins from initial stances
  const spins: number[] = agents.map((a) => {
    const state = initialStances.get(a.id);
    if (!state) return 0;
    return stanceToSpin(state.stance) * Math.max(0.1, state.confidence);
  });

  const trajectory: IsingTrajectory = {
    rounds,
    spins: [],
    magnetization: [],
    conviction: [],
    energy: [],
    susceptibility: [],
  };

  // Record initial state
  trajectory.spins.push([...spins]);
  trajectory.magnetization.push(mean(spins));
  trajectory.conviction.push(mean(spins.map(Math.abs)));
  trajectory.energy.push(computeEnergy(spins, params));

  for (let round = 1; round <= rounds; round++) {
    // Apply correction schedule if provided
    if (options.correctionSchedule?.has(round)) {
      const fields = options.correctionSchedule.get(round)!;
      for (let i = 0; i < Math.min(fields.length, n); i++) {
        params.h[i] = fields[i];
      }
    }

    // Synchronous update: all agents update simultaneously
    // (matches our debate engine where all agents respond each round)
    const newSpins = [...spins];
    for (let i = 0; i < n; i++) {
      const pUp = glauberFlipProbability(spins, i, params);
      // Vanilla: binary spin
      newSpins[i] = rng() < pUp ? 1 : -1;
    }

    for (let i = 0; i < n; i++) {
      spins[i] = newSpins[i];
    }

    trajectory.spins.push([...spins]);
    trajectory.magnetization.push(mean(spins));
    trajectory.conviction.push(mean(spins.map(Math.abs)));
    trajectory.energy.push(computeEnergy(spins, params));
  }

  // Compute susceptibility (variance of magnetization over a sliding window)
  for (let t = 0; t < trajectory.magnetization.length; t++) {
    const windowStart = Math.max(0, t - 2);
    const window = trajectory.magnetization.slice(windowStart, t + 1);
    const m = mean(window);
    const variance = window.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, window.length);
    trajectory.susceptibility.push(variance * params.beta);
  }

  return trajectory;
}

// --- Extended Ising simulation (our contribution) ---

export function simulateExtendedIsing(
  agents: AgentSpec[],
  topology: Topology,
  initialStances: Map<string, { stance: StanceLabel; confidence: number }>,
  rounds: number,
  options: {
    temperature?: number;
    seed?: number;
    correctionSchedule?: Map<number, number[]>;
    memoryHalfLife?: number;
    truthLabel?: "true" | "false" | "mixed";
  } = {},
): IsingTrajectory {
  const n = agents.length;
  const params = agentsToIsingParams(agents, topology, {
    temperature: options.temperature,
  });

  const rng = mulberry32(options.seed ?? 42);
  const memoryHalfLife = options.memoryHalfLife ?? 4;

  // Initialize continuous spins from stances + confidence
  const spins: number[] = agents.map((a) => {
    const state = initialStances.get(a.id);
    if (!state) return 0;
    return stanceToSpin(state.stance) * state.confidence;
  });

  // History for non-Markovian memory term
  const history: number[][] = [[...spins]];

  // Truth asymmetry: if claim is false, agents endorsing truth (reject)
  // have stronger effective coupling — truth exerts more pull
  const truthDirection = options.truthLabel === "false" ? -1 : options.truthLabel === "true" ? 1 : 0;
  const truthAsymmetry = 1.3; // true claims resist flipping 30% more (measurable prediction)

  const trajectory: IsingTrajectory = {
    rounds,
    spins: [],
    magnetization: [],
    conviction: [],
    energy: [],
    susceptibility: [],
  };

  trajectory.spins.push([...spins]);
  trajectory.magnetization.push(mean(spins));
  trajectory.conviction.push(mean(spins.map(Math.abs)));
  trajectory.energy.push(computeEnergy(spins, params));

  for (let round = 1; round <= rounds; round++) {
    // Apply correction schedule
    if (options.correctionSchedule?.has(round)) {
      const fields = options.correctionSchedule.get(round)!;
      for (let i = 0; i < Math.min(fields.length, n); i++) {
        params.h[i] = fields[i];
      }
    }

    const newSpins = [...spins];
    for (let i = 0; i < n; i++) {
      // Standard local field from coupling + external field
      let field = params.h[i] + params.truthBias[i];
      for (let j = 0; j < n; j++) {
        if (j !== i) {
          let coupling = params.J[i][j];
          // Truth asymmetry: truth-aligned spins couple more strongly
          if (truthDirection !== 0) {
            const jAligned = Math.sign(spins[j]) === truthDirection;
            if (jAligned) coupling *= truthAsymmetry;
          }
          field += coupling * spins[j];
        }
      }

      // Non-Markovian memory term: weighted sum of past states
      let memoryField = 0;
      for (let t = 0; t < history.length; t++) {
        const age = history.length - t;
        const decayWeight = Math.pow(0.5, age / memoryHalfLife);
        memoryField += history[t][i] * decayWeight;
      }
      field += params.mu[i] * memoryField / Math.max(1, history.length);

      // Continuous spin update: tanh(β * field) with noise
      const targetSpin = Math.tanh(params.beta * field);
      const noise = (rng() - 0.5) * 0.1 * (1 / params.beta); // noise scales with temperature
      newSpins[i] = clamp(targetSpin + noise, -1, 1);
    }

    for (let i = 0; i < n; i++) {
      spins[i] = newSpins[i];
    }

    history.push([...spins]);

    trajectory.spins.push([...spins]);
    trajectory.magnetization.push(mean(spins));
    trajectory.conviction.push(mean(spins.map(Math.abs)));
    trajectory.energy.push(computeEnergy(spins, params));
  }

  for (let t = 0; t < trajectory.magnetization.length; t++) {
    const windowStart = Math.max(0, t - 2);
    const window = trajectory.magnetization.slice(windowStart, t + 1);
    const m = mean(window);
    const variance = window.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, window.length);
    trajectory.susceptibility.push(variance * params.beta);
  }

  return trajectory;
}

// --- Critical temperature estimation ---
// Sweep temperature to find the phase transition where susceptibility peaks.
// This tells us at what social coupling strength the system transitions
// from disordered (indifference) to ordered (consensus/polarization).

export function estimateCriticalTemperature(
  agents: AgentSpec[],
  topology: Topology,
  initialStances: Map<string, { stance: StanceLabel; confidence: number }>,
  options: {
    tempRange?: [number, number];
    steps?: number;
    roundsPerTemp?: number;
    seed?: number;
  } = {},
): { criticalTemp: number; susceptibilityPeak: number; curve: { T: number; chi: number; m: number }[] } {
  const [tMin, tMax] = options.tempRange ?? [0.1, 5.0];
  const steps = options.steps ?? 20;
  const roundsPerTemp = options.roundsPerTemp ?? 10;
  const baseSeed = options.seed ?? 42;

  const curve: { T: number; chi: number; m: number }[] = [];
  let peakChi = 0;
  let criticalTemp = tMin;

  for (let i = 0; i <= steps; i++) {
    const T = tMin + (tMax - tMin) * (i / steps);
    const traj = simulateIsing(agents, topology, initialStances, roundsPerTemp, {
      temperature: T,
      seed: baseSeed + i,
    });

    // Susceptibility = β * var(m) over the trajectory
    const mValues = traj.magnetization.slice(Math.floor(roundsPerTemp / 2)); // skip transient
    const mMean = mean(mValues);
    const chi = mValues.reduce((s, v) => s + (v - mMean) ** 2, 0) / Math.max(1, mValues.length) / T;
    const mFinal = mean(traj.magnetization.slice(-3));

    curve.push({ T, chi, m: mFinal });

    if (chi > peakChi) {
      peakChi = chi;
      criticalTemp = T;
    }
  }

  return { criticalTemp, susceptibilityPeak: peakChi, curve };
}

// --- Regime classification ---

export type IsingRegime = "indifference" | "polarization" | "consensus";

export function classifyRegime(trajectory: IsingTrajectory): IsingRegime {
  // Use final-third magnetization and conviction
  const tail = Math.max(1, Math.floor(trajectory.magnetization.length / 3));
  const mTail = trajectory.magnetization.slice(-tail);
  const cTail = trajectory.conviction.slice(-tail);

  const avgM = mean(mTail.map(Math.abs));
  const avgC = mean(cTail);

  // Indifference: low conviction, low |magnetization|
  if (avgC < 0.3 && avgM < 0.3) return "indifference";

  // Consensus: high conviction AND high |magnetization| (most spins agree)
  if (avgM > 0.5 && avgC > 0.5) return "consensus";

  // Polarization: high conviction but low |magnetization| (cancels out)
  return "polarization";
}

// --- Helpers ---

function stanceToSpin(stance: StanceLabel): number {
  if (stance === "endorse") return 1;
  if (stance === "reject") return -1;
  return 0;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mulberry32(seed: number): () => number {
  let value = seed + 0x6d2b79f5;
  return () => {
    value |= 0;
    value = (value + 0x6d2b79f5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
