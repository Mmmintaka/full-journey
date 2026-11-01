import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { TaskPage, TaskStatus, TaskSort } from "./database";

export type Task = { id: string; title: string; completed: boolean };
export type User = { id: string; username: string; passwordHash: string };
type TaskRow = { id: string; title: string; completed: number };

const databasePath = process.env.DATABASE_PATH ?? resolve(__dirname, "../data/tasks.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });
const db = new Database(databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
    user_id TEXT REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
`);
// 保留旧版无主任务，不自动分配给任何人；新任务必须写入 user_id。
const columns = db.pragma("table_info(tasks)") as { name: string }[];
if (!columns.some((column) => column.name === "user_id")) {
  db.exec("ALTER TABLE tasks ADD COLUMN user_id TEXT REFERENCES users(id)");
}
db.exec("CREATE INDEX IF NOT EXISTS tasks_user_id ON tasks(user_id)");

const toTask = (row: TaskRow): Task => ({ ...row, completed: row.completed === 1 });
export function findUserByName(username: string): User | undefined {
  return db.prepare("SELECT id, username, password_hash AS passwordHash FROM users WHERE username = ?").get(username) as User | undefined;
}
export function createUser(user: User): void {
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)").run(user.id, user.username, user.passwordHash);
}
export function createSession(tokenHash: string, userId: string, expiresAt: number): void {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(tokenHash, userId, expiresAt);
}
export function findSession(tokenHash: string): { id: string; username: string } | undefined {
  return db.prepare(`SELECT users.id, users.username FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`).get(tokenHash, Date.now()) as { id: string; username: string } | undefined;
}
export function deleteSession(tokenHash: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}
export function listTasks(userId: string): Task[] {
  return (db.prepare("SELECT id, title, completed FROM tasks WHERE user_id = ? ORDER BY rowid").all(userId) as TaskRow[]).map(toTask);
}
export function listTasksPage(userId: string, status: TaskStatus, requestedPage: number, pageSize: number, search: string, sort: TaskSort): TaskPage {
  const row = db.prepare("SELECT COUNT(*) AS all_count, SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) AS completed_count FROM tasks WHERE user_id = ? AND instr(title, ?) > 0").get(userId, search) as { all_count: number; completed_count: number | null };
  const counts = { all: row.all_count, active: row.all_count - (row.completed_count ?? 0), completed: row.completed_count ?? 0 };
  const total = counts[status];
  const totalPages = Math.ceil(total / pageSize);
  const page = Math.min(requestedPage, Math.max(1, totalPages));
  const filter = status === "all" ? "" : " AND completed = ?";
  const params = status === "all" ? [userId, search, pageSize, (page - 1) * pageSize] : [userId, search, Number(status === "completed"), pageSize, (page - 1) * pageSize];
  const direction = sort === "newest" ? "DESC" : "ASC";
  const rows = db.prepare(`SELECT id, title, completed FROM tasks WHERE user_id = ? AND instr(title, ?) > 0${filter} ORDER BY rowid ${direction} LIMIT ? OFFSET ?`).all(...params) as TaskRow[];
  return { items: rows.map(toTask), page, pageSize, search, sort, total, totalPages, counts };
}
export function findTask(id: string, userId: string): Task | undefined {
  const row = db.prepare("SELECT id, title, completed FROM tasks WHERE id = ? AND user_id = ?").get(id, userId) as TaskRow | undefined;
  return row && toTask(row);
}
export function insertTask(task: Task, userId: string): void {
  db.prepare("INSERT INTO tasks (id, title, completed, user_id) VALUES (?, ?, ?, ?)").run(task.id, task.title, Number(task.completed), userId);
}
export function updateTask(task: Task, userId: string): void {
  db.prepare("UPDATE tasks SET title = ?, completed = ? WHERE id = ? AND user_id = ?").run(task.title, Number(task.completed), task.id, userId);
}
export function deleteTask(id: string, userId: string): boolean {
  return db.prepare("DELETE FROM tasks WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}
