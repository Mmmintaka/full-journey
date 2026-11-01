-- 已有任务获得默认值；旧版客户端继续写入时也会使用 medium。
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium'
  CHECK (priority IN ('low', 'medium', 'high'));
