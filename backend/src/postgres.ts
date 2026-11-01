import { Pool } from "pg";
import type { Task, User, TaskStatus, TaskPage } from "./database";

// 显式保持证书和主机名校验，避免 pg 将来改变 sslmode=require 的语义。
export function secureConnectionString(connectionString: string): string {
  const url = new URL(connectionString);
  if (url.searchParams.get("sslmode") === "require" && !url.searchParams.has("uselibpqcompat")) {
    url.searchParams.set("sslmode", "verify-full");
  }
  return url.toString();
}

export async function createPostgresStore(connectionString: string) {
  const db = new Pool({ connectionString: secureConnectionString(connectionString), max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
  try {
    await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, completed BOOLEAN NOT NULL DEFAULT FALSE,
      user_id TEXT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS tasks_user_id ON tasks(user_id);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at BIGINT NOT NULL
    );
  `);
  } catch (error) {
    await db.end();
    throw error;
  }
  return {
    async findUserByName(username: string): Promise<User | undefined> {
      return (await db.query<User>('SELECT id, username, password_hash AS "passwordHash" FROM users WHERE username = $1', [username])).rows[0];
    },
    async createUser(user: User): Promise<void> {
      await db.query("INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3)", [user.id, user.username, user.passwordHash]);
    },
    async createSession(tokenHash: string, userId: string, expiresAt: number): Promise<void> {
      await db.query("DELETE FROM sessions WHERE expires_at <= $1", [Date.now()]);
      await db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)", [tokenHash, userId, expiresAt]);
    },
    async findSession(tokenHash: string): Promise<{ id: string; username: string } | undefined> {
      return (await db.query<{ id: string; username: string }>(`SELECT users.id, users.username FROM sessions JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = $1 AND sessions.expires_at > $2`, [tokenHash, Date.now()])).rows[0];
    },
    async deleteSession(tokenHash: string): Promise<void> { await db.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]); },
    async listTasks(userId: string): Promise<Task[]> {
      return (await db.query<Task>("SELECT id, title, completed FROM tasks WHERE user_id = $1 ORDER BY created_at, id", [userId])).rows;
    },
    async listTasksPage(userId: string, status: TaskStatus, requestedPage: number, pageSize: number, search: string): Promise<TaskPage> {
      // 统计全部状态，再查询所选状态的当前页；用户 ID 始终由后端会话提供。
      const result = await db.query<{ all_count: string; completed_count: string | null }>(
        "SELECT COUNT(*) AS all_count, SUM(CASE WHEN completed THEN 1 ELSE 0 END) AS completed_count FROM tasks WHERE user_id = $1 AND strpos(title, $2) > 0", [userId, search]);
      const all = Number(result.rows[0].all_count);
      const completed = Number(result.rows[0].completed_count ?? 0);
      const counts = { all, active: all - completed, completed };
      const total = counts[status];
      const totalPages = Math.ceil(total / pageSize);
      const page = Math.min(requestedPage, Math.max(1, totalPages));
      const params: (string | boolean | number)[] = [userId, search];
      const filter = status === "all" ? "" : " AND completed = $3";
      if (status !== "all") params.push(status === "completed");
      params.push(pageSize, (page - 1) * pageSize);
      const query = `SELECT id, title, completed FROM tasks WHERE user_id = $1 AND strpos(title, $2) > 0${filter} ORDER BY created_at, id LIMIT $${params.length - 1} OFFSET $${params.length}`;
      const items = (await db.query<Task>(query, params)).rows;
      return { items, page, pageSize, search, total, totalPages, counts };
    },
    async findTask(id: string, userId: string): Promise<Task | undefined> {
      return (await db.query<Task>("SELECT id, title, completed FROM tasks WHERE id = $1 AND user_id = $2", [id, userId])).rows[0];
    },
    async insertTask(task: Task, userId: string): Promise<void> {
      await db.query("INSERT INTO tasks (id, title, completed, user_id) VALUES ($1, $2, $3, $4)", [task.id, task.title, task.completed, userId]);
    },
    async updateTask(task: Task, userId: string): Promise<void> {
      await db.query("UPDATE tasks SET title = $1, completed = $2 WHERE id = $3 AND user_id = $4", [task.title, task.completed, task.id, userId]);
    },
    async deleteTask(id: string, userId: string): Promise<boolean> {
      return (await db.query("DELETE FROM tasks WHERE id = $1 AND user_id = $2", [id, userId])).rowCount === 1;
    },
  };
}
