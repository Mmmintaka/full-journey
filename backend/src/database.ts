import type { Task, User } from "./sqlite";
export type { Task, User, Priority } from "./sqlite";
export type TaskSort = "oldest" | "newest";
export type TaskStatus = "all" | "active" | "completed";
export type TaskPage = { items: Task[]; page: number; pageSize: number; search: string; sort: TaskSort; total: number; totalPages: number; counts: { all: number; active: number; completed: number } };

type Store = {
  findUserByName(username: string): Promise<User | undefined>;
  createUser(user: User): Promise<void>;
  createSession(tokenHash: string, userId: string, expiresAt: number): Promise<void>;
  findSession(tokenHash: string): Promise<{ id: string; username: string } | undefined>;
  deleteSession(tokenHash: string): Promise<void>;
  listTasks(userId: string): Promise<Task[]>;
  listTasksPage(userId: string, status: TaskStatus, page: number, pageSize: number, search: string, sort: TaskSort): Promise<TaskPage>;
  findTask(id: string, userId: string): Promise<Task | undefined>;
  insertTask(task: Task, userId: string): Promise<void>;
  updateTask(task: Task, userId: string): Promise<void>;
  deleteTask(id: string, userId: string): Promise<boolean>;
};
let store: Store;
export async function initializeDatabase(): Promise<void> {
  if (process.env.DATABASE_URL) {
    const postgres = await import("./postgres");
    store = await postgres.createPostgresStore(process.env.DATABASE_URL);
  } else {
    if (process.env.NODE_ENV === "production") throw new Error("生产环境必须配置 DATABASE_URL；不能依赖临时本地文件。");
    const sqlite = await import("./sqlite");
    store = {
      findUserByName: async (name) => sqlite.findUserByName(name),
      createUser: async (user) => sqlite.createUser(user),
      createSession: async (hash, id, expiry) => sqlite.createSession(hash, id, expiry),
      findSession: async (hash) => sqlite.findSession(hash),
      deleteSession: async (hash) => sqlite.deleteSession(hash),
      listTasks: async (id) => sqlite.listTasks(id),
      listTasksPage: async (id, status, page, pageSize, search, sort) => sqlite.listTasksPage(id, status, page, pageSize, search, sort),
      findTask: async (id, userId) => sqlite.findTask(id, userId),
      insertTask: async (task, userId) => sqlite.insertTask(task, userId),
      updateTask: async (task, userId) => sqlite.updateTask(task, userId),
      deleteTask: async (id, userId) => sqlite.deleteTask(id, userId),
    };
  }
}
export const findUserByName = (name: string) => store.findUserByName(name);
export const createUser = (user: User) => store.createUser(user);
export const createSession = (hash: string, userId: string, expiry: number) => store.createSession(hash, userId, expiry);
export const findSession = (hash: string) => store.findSession(hash);
export const deleteSession = (hash: string) => store.deleteSession(hash);
export const listTasks = (userId: string) => store.listTasks(userId);
export const listTasksPage = (userId: string, status: TaskStatus, page: number, pageSize: number, search: string, sort: TaskSort) => store.listTasksPage(userId, status, page, pageSize, search, sort);
export const findTask = (id: string, userId: string) => store.findTask(id, userId);
export const insertTask = (task: Task, userId: string) => store.insertTask(task, userId);
export const updateTask = (task: Task, userId: string) => store.updateTask(task, userId);
export const deleteTask = (id: string, userId: string) => store.deleteTask(id, userId);
