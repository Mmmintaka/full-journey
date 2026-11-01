"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

const apiUrl = "/api";
type Task = { id: string; title: string; completed: boolean };
type TaskFilter = "all" | "active" | "completed";
type User = { id: string; username: string };
class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string } | null;
    throw new ApiError(data?.error ?? "请求失败，请稍后重试。", response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [title, setTitle] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleError = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) {
      setUser(null); setTasks([]); setEditingId(null); setError("登录已失效，请重新登录。");
    } else setError(err instanceof Error ? err.message : "请求失败，请稍后重试。");
  }, []);
  const loadTasks = useCallback(async () => {
    setLoading(true); setError("");
    try { setTasks(await request<Task[]>("/tasks")); }
    catch (err) { handleError(err); }
    finally { setLoading(false); }
  }, [handleError]);
  useEffect(() => {
    let active = true;
    request<User>("/auth/me").then((current) => { if (active) setUser(current); }).catch((err) => {
      if (active && !(err instanceof ApiError && err.status === 401)) setError("无法连接后端，请确认服务已启动后刷新页面。");
    }).finally(() => { if (active) setAuthLoading(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => { if (user) void loadTasks(); }, [user, loadTasks]);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      if (authMode === "register") {
        await request("/auth/register", { method: "POST", body: JSON.stringify({ username, password }) });
        setAuthMode("login"); setPassword(""); setNotice("注册成功，请使用新账号登录。");
      } else {
        const current = await request<User>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
        setPassword(""); setUser(current);
      }
    } catch (err) { setError(err instanceof Error ? err.message : "请求失败，请稍后重试。"); }
    finally { setBusy(false); }
  }
  async function logout() {
    setBusy(true); setError("");
    try { await request("/auth/logout", { method: "POST" }); setUser(null); setTasks([]); setTitle(""); setFilter("all"); setEditingId(null); setNotice("已退出登录。"); }
    catch (err) { handleError(err); }
    finally { setBusy(false); }
  }
  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim()) { setError("请输入任务标题。"); return; }
    setBusy(true); setError("");
    try { const task = await request<Task>("/tasks", { method: "POST", body: JSON.stringify({ title }) }); setTasks((current) => [...current, task]); setTitle(""); setFilter("all"); }
    catch (err) { handleError(err); }
    finally { setBusy(false); }
  }
  async function updateTask(id: string, changes: Partial<Pick<Task, "title" | "completed">>) {
    setBusy(true); setError("");
    try { const updated = await request<Task>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(changes) }); setTasks((current) => current.map((task) => task.id === id ? updated : task)); setEditingId(null); }
    catch (err) { handleError(err); }
    finally { setBusy(false); }
  }
  async function deleteTask(id: string) {
    setBusy(true); setError("");
    try { await request<void>(`/tasks/${id}`, { method: "DELETE" }); setTasks((current) => current.filter((task) => task.id !== id)); if (editingId === id) setEditingId(null); }
    catch (err) { handleError(err); }
    finally { setBusy(false); }
  }

  const completedCount = tasks.filter((task) => task.completed).length;
  const filteredTasks = tasks.filter((task) => filter === "all" || (filter === "completed" ? task.completed : !task.completed));
  const filters: { value: TaskFilter; label: string; count: number }[] = [
    { value: "all", label: "全部", count: tasks.length },
    { value: "active", label: "待完成", count: tasks.length - completedCount },
    { value: "completed", label: "已完成", count: completedCount },
  ];

  return (
    <main className="page">
      <header className="header"><a className="brand" href="/" aria-label="任务清单首页"><span className="brand-mark">✓</span> 任务清单</a>{user ? <div className="account"><span>{user.username}</span><button type="button" onClick={() => void logout()} disabled={busy}>退出登录</button></div> : <span className="header-note">给每一天留一点秩序</span>}</header>
      <section className="intro"><p className="date">从这里开始</p><h1>把事情放进清单，<br />把精力留给生活。</h1><p className="description">记录你想完成的事，一次专注一件。</p></section>
      {authLoading ? <p className="state-message">正在检查登录状态…</p> : !user ? <section className="workspace auth-box" aria-labelledby="auth-title">
        <h2 id="auth-title">{authMode === "login" ? "登录你的清单" : "创建账号"}</h2><p className="auth-description">{authMode === "login" ? "登录后继续管理你的任务。" : "注册后，每个人都有自己的任务空间。"}</p>
        <form className="auth-form" onSubmit={submitAuth}><label htmlFor="username">用户名</label><input id="username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" minLength={3} maxLength={30} required placeholder="3–30 位字母、数字或下划线" /><label htmlFor="password">密码</label><input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={authMode === "login" ? "current-password" : "new-password"} minLength={8} maxLength={128} required placeholder="至少 8 个字符" /><button className="primary" type="submit" disabled={busy}>{authMode === "login" ? "登录" : "注册"}</button></form>
        {error && <p className="error" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
        <p className="auth-switch">{authMode === "login" ? "还没有账号？" : "已有账号？"} <button type="button" className="text-button" disabled={busy} onClick={() => { setAuthMode(authMode === "login" ? "register" : "login"); setError(""); setNotice(""); setPassword(""); }}>{authMode === "login" ? "注册" : "登录"}</button></p>
      </section> : <section className="workspace" aria-labelledby="workspace-title">
        <div className="workspace-heading"><div><p className="small-label">你的空间</p><h2 id="workspace-title">今天的任务</h2></div><span className="count">{completedCount} / {tasks.length} 已完成</span></div>
        <form className="add-form" onSubmit={createTask}><label className="sr-only" htmlFor="new-task">新任务标题</label><input id="new-task" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="添加一件要做的事…" maxLength={100} disabled={loading || busy} /><button className="primary" type="submit" disabled={loading || busy}>添加任务</button></form>
        {error && <div className="error" role="alert">{error} <button type="button" onClick={() => void loadTasks()} disabled={busy}>重新读取</button></div>}
        <nav className="task-filters" aria-label="按状态筛选任务">
          {filters.map((item) => <button key={item.value} type="button" aria-pressed={filter === item.value} onClick={() => { setFilter(item.value); setEditingId(null); }} disabled={loading || busy}>{item.label} <span aria-hidden="true">{item.count}</span></button>)}
        </nav>
        {loading ? <p className="state-message">正在读取任务…</p> : tasks.length === 0 ? <div className="empty"><span className="empty-icon" aria-hidden="true">✓</span><h3>清单还是空的</h3><p>从上方添加你的第一件任务。</p></div> : filteredTasks.length === 0 ? <div className="empty"><span className="empty-icon" aria-hidden="true">✓</span><h3>{filter === "active" ? "没有待完成的任务" : "还没有已完成的任务"}</h3><p>{filter === "active" ? "可以添加新任务，或查看全部任务。" : "完成任务后，它会出现在这里。"}</p></div> : <ul className="task-list">{filteredTasks.map((task) => <li className="task-row" key={task.id}>
          <input className="checkbox" type="checkbox" checked={task.completed} disabled={busy} aria-label={`${task.completed ? "标记为未完成" : "标记为完成"}：${task.title}`} onChange={(event) => void updateTask(task.id, { completed: event.target.checked })} />
          {editingId === task.id ? <form className="edit-form" onSubmit={(event) => { event.preventDefault(); void updateTask(task.id, { title: editTitle }); }}><label className="sr-only" htmlFor={`edit-${task.id}`}>修改任务标题</label><input id={`edit-${task.id}`} value={editTitle} onChange={(event) => setEditTitle(event.target.value)} maxLength={100} autoFocus disabled={busy} /><button type="submit" disabled={busy}>保存</button><button type="button" disabled={busy} onClick={() => setEditingId(null)}>取消</button></form> : <><span className={`task-title ${task.completed ? "done" : ""}`}>{task.title}</span><div className="task-actions"><button type="button" disabled={busy} onClick={() => { setEditingId(task.id); setEditTitle(task.title); }}>编辑</button><button type="button" disabled={busy} onClick={() => void deleteTask(task.id)}>删除</button></div></>}
        </li>)}</ul>}
      </section>}
      {user && <p className="storage-note">你的任务保存在数据库中，只有登录当前账号才能访问。</p>}
      <footer>先从一件小事开始。</footer>
    </main>
  );
}
