import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

type SqlPrimitive = string | number | null;
type JsonRow = Record<string, unknown>;

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function toSqlLiteral(value: SqlPrimitive): string {
  if (value === null) {
    return "NULL";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function runSql(dbPath: string, sql: string): void {
  execFileSync("/usr/bin/sqlite3", [dbPath], {
    input: sql,
    encoding: "utf8",
  });
}

export function queryRows<T extends JsonRow = JsonRow>(dbPath: string, sql: string): T[] {
  const raw = execFileSync("/usr/bin/sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
  }).trim();
  if (!raw) {
    return [];
  }
  return JSON.parse(raw) as T[];
}

export function initDatabase(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
  const schemaPath = path.resolve(process.cwd(), "db/schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");
  runSql(dbPath, schema);
}

export function insertRow(dbPath: string, tableName: string, row: Record<string, SqlPrimitive>): void {
  const columns = Object.keys(row).map(quoteIdentifier).join(", ");
  const values = Object.values(row).map(toSqlLiteral).join(", ");
  runSql(dbPath, `INSERT INTO ${quoteIdentifier(tableName)} (${columns}) VALUES (${values});`);
}

export function writeSummaryJson(outputDir: string, summary: unknown): string {
  const summaryPath = path.join(outputDir, "summary.json");
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summaryPath;
}
