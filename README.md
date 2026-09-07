# Agent Society

Testbed and experimental data for "Information Cascades in LLM Agent Societies: How Shared State Amplifies False Beliefs" (ICLR 2027 submission).

**[Read the paper (PDF)](paper/paper.pdf)**

![Agent Society terminal interface](testbed_image/main.png)

## What this is

Agent Society is a testbed for studying how false beliefs spread through groups of LLM agents that share a persistent written memory. We compare three communication formats (shared memory, live debate, and personal memory) across 7 models from 4 providers and 10 tasks.

The key finding: when agents communicate through shared memory, false beliefs spread to 87% of honest agents. When the same agents debate face to face, the spread is 0%. The same mechanism that makes shared memory valuable for correcting honest mistakes makes it dangerous for amplifying persistent false entries.

![Core result](paper/fig/fig1.png)

## Quick start

```bash
npm install
cp .env.example .env
# Add your API keys to .env (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
```

### Interactive terminal

```bash
npm run multiagent:society
```

This launches the interactive terminal with a menu for running experiments, inspecting results, comparing runs, and browsing configurations. The menu options are:

1. **Run setup** -- launch one run with custom seed, rounds, budget, or agent count
2. **Build experiment** -- create or edit experiment configurations
3. **Inspect memory** -- browse what agents wrote and retrieved
4. **Batch seeds** -- run the same setup across multiple seeds
5. **Compare runs** -- side-by-side results for two configurations
6. **Run history** -- see recent runs and their outcomes
7. **Experiment archive** -- browse completed experiment grids
8. **Browse setups** -- explore available scenarios, conditions, and rosters
9. **Provider setup** -- configure API keys for each model provider
10. **Run command** -- execute a CLI command directly
11. **Explain** -- read documentation about how the testbed works

### Live debate view

![Live debate between agents](testbed_image/chat.png)

### Run results view

![Completed run showing agent states and memory entries](testbed_image/fe_result.png)

### Scenario browser

![Browsing scenarios with claims and evidence cards](testbed_image/memory.png)

### Try the core experiment yourself

Want to see the 87% contagion result from the paper? Here is exactly how.

**Option 1. Interactive terminal (recommended)**

```bash
npm run multiagent:society
```

1. Select **Run setup** from the menu
2. Browse to `part2-more-seeds-v1` (this is the core ego depletion experiment)
3. The testbed shows you the scenario, agents, and condition
4. Press enter to run. You will see agents writing to shared memory in real time
5. When it finishes, the results view shows final stances, FE, and the full memory trace

**Option 2. One command**

```bash
npx tsx src/experiments/grid.ts experiments/part2-more-seeds-v1.json
```

This runs ego depletion across shared memory, debate, and personal memory with seeds 6-10. Each run takes about 30 seconds with Claude Haiku. When done, open any trace database to see exactly what happened.

**Option 3. Look at existing data without running anything**

Every result is already in `output/`. Pick any trace database and query it.

```bash
# Find a shared memory run on ego depletion
ls output/ | grep "part2_more_seeds" | head -3

# Open it and check the final stances
sqlite3 output/<pick-one>/trace.db \
  "SELECT agent_id, stance, confidence FROM agent_claim_states
   WHERE claim_id='claim_ego_depletion'
   AND step_index=(SELECT MAX(step_index) FROM agent_claim_states);"
```

You will see analyst_1 through analyst_4 at endorse(0.85-0.88), analyst_5 at uncertain(0.48), and analyst_6 at endorse(0.72-0.75). That is the contagion.

### CLI commands

```bash
# Validate a run config
npm run testbed:validate -- run-configs/example.yaml

# Run a single config
npm run testbed:run -- run-configs/example.yaml

# Compare two runs
npm run testbed:compare -- output/run1 output/run2

# Batch across seeds
npm run testbed:batch -- run-configs/example.yaml --seeds 1,2,3,4,5

# Inspect a completed run
npm run testbed:inspect -- output/run1
```

### Run a grid experiment

```bash
npx tsx src/experiments/grid.ts experiments/part2-ambiguity-gradient-v1.json
```

This runs all combinations of scenarios x conditions x seeds defined in the experiment config. Completed cells are cached, so you can restart safely.

## Replicating paper results

Every result in the paper comes from a specific experiment config in `experiments/`. Config filenames use internal naming that differs from the paper terminology.

**Naming conventions in the config files.**
The experiment files use prefixes like `part2-` which refer to internal development phases, not paper sections. In the paper, "Part 1" experiments are the honest-mistake results (Section 4, "Sharing Corrects Honest Mistakes") where one agent starts with a wrong belief but can change its mind. "Part 2" experiments are the deliberate-lie results (Section 5, "Sharing Spreads Deliberate Lies") where 4 agents persistently write false entries. Configs starting with `blind-` or `cross-model-` run the same setup across multiple models. Configs starting with `amplifier-` or `mitigation-` test specific record formats or defenses.

Here is how the main results map to configs.

| Paper result | Experiment config | What it runs |
|---|---|---|
| Table 1 (core channel comparison) | `part2-more-seeds-v1.json` + `part2-personal-vs-shared-v1.json` | Ego depletion, 3 formats, 30 seeds |
| Table 2 (ambiguity gradient) | `part2-ambiguity-gradient-v1.json` + `part2-more-topics-v1.json` | 6 familiar topics, shared memory |
| Table 3 (cross-model) | `blind-all-models-familiar-v1.json` + `cross-model-fair-comparison-v1.json` | 7 models, shared + debate |
| Table 4 (mitigation hierarchy) | `part2-decay-v1.json`, `part2-verification-v1.json`, `part2-correction-timing-v1.json`, `part2-force-write-v2.json`, `part2-independence-aware-v1.json` | 8 defenses |
| Confidence bias (Section 5.2) | `part2-consensus-v1.json` | 3:3 ratio, mild vs committed liars |
| Liar ratio (Section 5.2) | `part2-majority-liar-v1.json` + `part2-one-liar-v1.json` + `part2-5of6-liars-v1.json` | 1/6 through 5/6 liars |
| Exit timing (Section 5.2) | `part2-exit-timing-v1.json` | Liars leave at step 1, 3, 6, 12 |
| SciTaT (Section 5.3) | `part2-scitat-contagion-v1.json` | Screened unfamiliar tasks |
| GSM8K / GSM-Hard | `blind-cross-model-gsm8k-v1.json` + `gsm-hard-contagion-v1.json` | Math tasks |
| Scale effects | `part2-30agent-v1.json` + `part2-40agent-v1.json` + `part2-100agent-v1.json` | 20-100 agents |
| Village topology | `part2-village-structure-v2.json` | Star, chain, ring topologies |
| Hidden profiles | `amplifier-majority-wrong-haiku-v1.json` | Evidence board vs mixed record |

To replicate a specific result, run the corresponding experiment config through the grid runner:

```bash
npx tsx src/experiments/grid.ts experiments/part2-ambiguity-gradient-v1.json
```

The output appears in `output/` as SQLite trace databases. Each database contains every agent's belief state at every step, every memory entry written, every retrieval, and every LLM call.

## Repository structure

```
src/                    # Testbed source code (TypeScript)
  engine/               # Run engine (memory mode + chat mode backends)
    backends/           # memoryMode.ts (shared/personal) + chatMode.ts (debate)
    run.ts              # Main run entry point
    finalize.ts         # Run-level metrics and summary
  ui/                   # Interactive terminal interface
    interactive.ts      # Menu system and user interaction
    render.ts           # Terminal rendering (retro ASCII style)
  llm/                  # LLM API calls and prompt construction
    prompts.ts          # All agent prompts (both modes)
    provider.ts         # Multi-provider API abstraction
  memory/               # Memory retrieval logic (5 formats)
    retrieve.ts         # Format-dependent retrieval
  metrics/              # Per-step metric computation
    compute.ts          # FE, contagion, diversity, consensus
  scenario/             # Scenario and evidence handling
    access.ts           # Evidence visibility filtering
  db/                   # SQLite trace storage
    sqlite.ts           # Database operations
  config/               # Schema definitions (Zod)
  experiments/          # Grid runner for factorial experiments
    grid.ts             # Runs all scenario x condition x seed combos

experiments/            # 58 experiment configurations (JSON)
conditions/             # 14 condition files (shared memory, debate, etc.)
scenarios/              # 86 scenario definitions (claims + evidence)
rosters/                # 36 agent roster configurations
run-configs/            # Run configuration templates

output/                 # 2,252 traced runs (SQLite databases)

scripts/                # Analysis and conversion scripts
tests/                  # Test suite (vitest)
db/schema.sql           # Database schema

paper/               # Paper source files
  paper.tex             # Main text
  appendix_results.tex  # Supplementary material
  fig/                  # Figures
```

## How the code maps to the paper

| Paper concept | Code location |
|---|---|
| Shared memory (agents read/write a common log) | `src/engine/backends/memoryMode.ts` |
| Live debate (agents argue in real-time rounds) | `src/engine/backends/chatMode.ts` + `src/engine/chat.ts` |
| Personal memory (agent reasons alone) | Same as memory mode with `personal_memory` condition |
| 5 memory formats (agent_judgment, evidence_board, mixed_record, source_aware, independence_aware) | `src/memory/retrieve.ts` |
| Evidence visibility filtering (visibleToAgentIds, availableFromStep) | `src/scenario/access.ts` |
| Agent prompts (specialist, regular, liar roles) | `src/llm/prompts.ts` |
| Metrics (FE, contagion, soft contagion, diversity, consensus) | `src/metrics/compute.ts` |
| Run finalization and summary | `src/engine/finalize.ts` |
| Factorial experiment grids | `src/experiments/grid.ts` |
| SQLite trace storage | `src/db/sqlite.ts` |
| Interactive terminal UI | `src/ui/interactive.ts` + `src/ui/render.ts` |

## How experiment configs work

Each experiment config (e.g., `experiments/part2-ambiguity-gradient-v1.json`) defines:

```json
{
  "id": "part2_ambiguity_gradient_v1",
  "scenarios": ["scenarios/familiar-blind/blind_ego_depletion_v1.yaml", ...],
  "conditions": ["conditions/shared-memory-no-correction.yaml"],
  "seeds": [1, 2, 3, 4, 5],
  "rosterPaths": ["rosters/blind-majority-wrong-4of6-haiku.json"],
  "maxSteps": 18,
  "budget": { "maxModelCalls": 54, "temperature": 0 }
}
```

The grid runner creates all combinations (scenarios x conditions x seeds) and runs them sequentially, caching completed cells. If a run is interrupted, restarting picks up where it left off.

## Trace databases

Each run produces one SQLite database in `output/`. You can inspect any database with:

```bash
sqlite3 output/<run-name>/trace.db
```

The database contains:
- `agent_claim_states` -- agent stance (endorse/reject/uncertain) and confidence at each step
- `memory_entries` -- everything written to shared memory
- `chat_messages` -- debate messages with cited sources (chat mode only)
- `retrieval_traces` -- what each agent saw before deciding (the memory contents it read)
- `model_calls` -- raw LLM API calls with full prompts and responses
- `events` -- experiment events (corrections, agent exits, etc.)
- `metric_records` -- computed metrics at each step
- `runs` -- run metadata and final summary

## Analyzing trace data

Here are example queries you can run on any trace database to extract the same results reported in the paper.

**Did the honest agent adopt the false belief?**
```sql
SELECT agent_id, stance, confidence
FROM agent_claim_states
WHERE claim_id = 'claim_ego_depletion'
  AND step_index = (SELECT MAX(step_index) FROM agent_claim_states)
ORDER BY agent_id;
```

**What did the shared memory look like when the agent flipped?**
```sql
SELECT step_index, agent_id, stance, confidence, reasoning_text
FROM memory_entries
WHERE claim_id = 'claim_ego_depletion'
ORDER BY step_index;
```

**What sources did the agent cite?**
```sql
SELECT step_index, agent_id, cited_source_ids_json
FROM memory_entries
WHERE agent_id = 'analyst_6'
ORDER BY step_index;
```

**Get the false endorsement rate at each step**
```sql
SELECT step_index, metric_value AS false_endorsement_rate
FROM metric_records
WHERE metric_name = 'falseClaimEndorsementRate'
ORDER BY step_index;
```

## Configuration file formats

### Conditions (how agents communicate)

Conditions define the communication format. Example (`conditions/shared-memory-no-correction.yaml`):

```json
{
  "id": "shared_memory_no_correction",
  "memory": {
    "mode": "shared",           // "shared", "personal", or "chat"
    "record": "agent_judgment", // memory format type
    "maxRetrievedEntries": 6
  },
  "interventions": {
    "correctionTiming": "none"  // "none", "early", "late"
  }
}
```

Key `memory.mode` values:
- `"shared"` -- shared memory (all agents read/write the same pool)
- `"personal"` -- personal memory (each agent sees only its own entries)
- `"chat"` -- live debate (synchronous multi-round discussion)

### Scenarios (what agents evaluate)

Scenarios define the claims, evidence, and ground truth. Each scenario has:
- **Claims** with truth labels (`true`, `false`, `mixed`)
- **Evidence cards** with effect directions and visibility rules
- **A focus claim** (the false claim that liars endorse)

### Rosters (who the agents are)

Rosters define agent roles, models, and behavioral parameters:
- `role` -- `contamination_agent` (liar), `specialist_agent`, `regular_agent`
- `model` -- which LLM to use
- `socialWeight` -- how much the agent weighs peer entries (1.0 = fully influenced, 0.35 = resistant)
- `falseClaimBias` -- initial lean toward the false claim (0.85+ for liars, 0.05 for honest)
- `writesMemoryThreshold` -- minimum confidence to write (0.30 for honest, 0.00 for liars)

## Creating your own experiment

1. Pick or create a **scenario** (the scientific claim and evidence)
2. Pick or create **conditions** (shared memory, debate, etc.)
3. Pick or create a **roster** (agent roles and which model to use)
4. Create an **experiment config** that combines them with seeds

Example minimal experiment:
```json
{
  "id": "my_experiment",
  "scenarios": ["scenarios/familiar-blind/blind_ego_depletion_v1.yaml"],
  "conditions": [
    "conditions/shared-memory-no-correction.yaml",
    "conditions/chat-fully-connected.yaml"
  ],
  "seeds": [1, 2, 3],
  "rosterPaths": ["rosters/blind-majority-wrong-4of6-haiku.json"],
  "maxSteps": 18,
  "budget": { "maxModelCalls": 54, "temperature": 0 }
}
```

This runs ego depletion with 4/6 liars in both shared memory and debate across 3 seeds (6 total runs).

```bash
npx tsx src/experiments/grid.ts experiments/my_experiment.json
```

## Running tests

```bash
npx vitest
```

## License

MIT
