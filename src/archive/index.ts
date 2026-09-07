import fs from "fs";
import path from "path";

export type ArchiveRecordKind = "single-run" | "batch" | "compare" | "grid";

export type ArchiveRecord = {
  id: string;
  kind: ArchiveRecordKind;
  title: string;
  createdAt: string;
  projectRoot: string;
  question: string | null;
  note: string | null;
  command: string | null;
  tags: string[];
  scenarios: string[];
  conditions: string[];
  rosters: string[];
  models: string[];
  seeds: number[];
  runIds: string[];
  primaryOutputPath: string | null;
  extraOutputPaths: string[];
  manifestPath?: string | null;
  requestedManifestPath?: string | null;
  benchmarkMeta?: {
    status: "canonical" | "supporting" | "pilot" | "deprecated";
    claimId?: string;
    locked?: boolean;
    notes?: string[];
    supersedes?: string[];
  } | null;
  metrics: Record<string, number | string | null>;
  provenance?: {
    kind: "replication-inspired" | "adapted" | "new";
    note?: string;
  } | null;
  citations?: {
    motivation?: { title: string; url?: string; note?: string }[];
    mechanism?: { title: string; url?: string; note?: string }[];
    scenario?: { title: string; url?: string; note?: string }[];
    metric?: { title: string; url?: string; note?: string }[];
  } | null;
};

type ArchiveIndex = {
  updatedAt: string;
  records: ArchiveRecord[];
};

export type CreateArchiveRecordParams = Omit<ArchiveRecord, "id" | "createdAt" | "projectRoot"> & {
  projectRoot: string;
};

function archiveRoot(projectRoot: string): string {
  return path.resolve(projectRoot, "lab");
}

function archiveRecordsDir(projectRoot: string): string {
  return path.join(archiveRoot(projectRoot), "records");
}

function archiveIndexPath(projectRoot: string): string {
  return path.join(archiveRoot(projectRoot), "index.json");
}

function ensureArchiveDirs(projectRoot: string): void {
  fs.mkdirSync(archiveRecordsDir(projectRoot), { recursive: true });
}

function loadArchiveIndex(projectRoot: string): ArchiveIndex {
  const indexPath = archiveIndexPath(projectRoot);
  if (!fs.existsSync(indexPath)) {
    return { updatedAt: new Date(0).toISOString(), records: [] };
  }
  return JSON.parse(fs.readFileSync(indexPath, "utf8")) as ArchiveIndex;
}

function writeArchiveIndex(projectRoot: string, index: ArchiveIndex): void {
  ensureArchiveDirs(projectRoot);
  fs.writeFileSync(archiveIndexPath(projectRoot), `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function buildRecordId(kind: ArchiveRecordKind): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${kind}-${stamp}-${suffix}`;
}

export function createArchiveRecord(params: CreateArchiveRecordParams): ArchiveRecord {
  ensureArchiveDirs(params.projectRoot);
  const record: ArchiveRecord = {
    ...params,
    id: buildRecordId(params.kind),
    createdAt: new Date().toISOString(),
  };

  const recordPath = path.join(archiveRecordsDir(params.projectRoot), `${record.id}.json`);
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  const index = loadArchiveIndex(params.projectRoot);
  index.records = [record, ...index.records].slice(0, 500);
  index.updatedAt = new Date().toISOString();
  writeArchiveIndex(params.projectRoot, index);

  return record;
}

export function listArchiveRecords(projectRoot: string, limit = 50): ArchiveRecord[] {
  return loadArchiveIndex(projectRoot).records.slice(0, limit);
}

export function readArchiveRecord(projectRoot: string, recordId: string): ArchiveRecord {
  const recordPath = path.join(archiveRecordsDir(projectRoot), `${recordId}.json`);
  if (!fs.existsSync(recordPath)) {
    throw new Error(`No archive record found for ${recordId}`);
  }
  return JSON.parse(fs.readFileSync(recordPath, "utf8")) as ArchiveRecord;
}
