PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  seed INTEGER NOT NULL,
  memory_mode TEXT NOT NULL,
  max_steps INTEGER NOT NULL,
  status TEXT NOT NULL,
  run_metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  output_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS memory_entries (
  memory_entry_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  stance TEXT NOT NULL,
  confidence REAL NOT NULL,
  visibility TEXT NOT NULL,
  source_type TEXT NOT NULL,
  entry_text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS retrieval_traces (
  retrieval_trace_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  retrieved_entry_ids_json TEXT NOT NULL,
  context_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS testimony_adoptions (
  adoption_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  stance TEXT NOT NULL,
  source_memory_entry_id TEXT NOT NULL,
  source_agent_id TEXT NOT NULL,
  previous_stance TEXT NOT NULL,
  previous_confidence REAL NOT NULL,
  current_confidence REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS claim_lineage (
  lineage_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  claim_id TEXT NOT NULL,
  parent_memory_entry_id TEXT NOT NULL,
  child_memory_entry_id TEXT NOT NULL,
  parent_agent_id TEXT NOT NULL,
  child_agent_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_claim_states (
  state_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  truth_label TEXT NOT NULL,
  stance TEXT NOT NULL,
  score REAL NOT NULL,
  confidence REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS interventions (
  intervention_event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  intervention_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  claim_id TEXT NOT NULL,
  intervention_type TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metric_records (
  metric_record_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  step_index INTEGER,
  metric_name TEXT NOT NULL,
  metric_value REAL NOT NULL,
  metric_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_calls (
  model_call_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  model_name TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  estimated_cost_usd REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_messages (
  message_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  round INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  message_type TEXT,
  message_text TEXT NOT NULL,
  stance TEXT,
  confidence REAL,
  cited_source_ids_json TEXT NOT NULL DEFAULT '[]',
  referenced_claim_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_run_step ON chat_messages(run_id, step_index, round);

CREATE TABLE IF NOT EXISTS physics_reports (
  report_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  topology TEXT NOT NULL,
  regime_predicted TEXT,
  regime_actual TEXT,
  regime_match INTEGER,
  vanilla_rmse REAL,
  extended_rmse REAL,
  improvement_ratio REAL,
  ising_explained_rate REAL,
  truth_asymmetry_ratio REAL,
  group_archetype TEXT,
  critical_temperature REAL,
  correction_effect REAL,
  correction_surprise REAL,
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_physics_reports_run ON physics_reports(run_id, step_index);
CREATE INDEX IF NOT EXISTS idx_events_run_step ON events(run_id, step_index);
CREATE INDEX IF NOT EXISTS idx_memory_entries_run_step ON memory_entries(run_id, step_index);
CREATE INDEX IF NOT EXISTS idx_retrieval_traces_run_step ON retrieval_traces(run_id, step_index);
CREATE INDEX IF NOT EXISTS idx_testimony_adoptions_run_step ON testimony_adoptions(run_id, step_index);
CREATE INDEX IF NOT EXISTS idx_claim_lineage_run_step ON claim_lineage(run_id, step_index);
CREATE INDEX IF NOT EXISTS idx_agent_claim_states_run_step ON agent_claim_states(run_id, step_index);
CREATE INDEX IF NOT EXISTS idx_metric_records_run_metric ON metric_records(run_id, metric_name);
CREATE INDEX IF NOT EXISTS idx_model_calls_run_step ON model_calls(run_id, step_index);
