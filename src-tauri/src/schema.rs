use rusqlite::Connection;

pub fn create_tables(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            root_path TEXT NOT NULL,
            prompt_path TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
        CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at);

        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            user_data_dir TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'unknown',
            image_threshold INTEGER DEFAULT 0,
            success_count INTEGER DEFAULT 0,
            submit_count INTEGER DEFAULT 0,
            last_used_at TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_accounts_name ON accounts(name);
        CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);

        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            project_id INTEGER,
            account_id INTEGER,
            status TEXT NOT NULL DEFAULT 'pending',
            current_round INTEGER DEFAULT 0,
            total_rounds INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            started_at TEXT,
            completed_at TEXT,
            FOREIGN KEY (project_id) REFERENCES projects(id),
            FOREIGN KEY (account_id) REFERENCES accounts(id)
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_account_id ON tasks(account_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at);

        CREATE TABLE IF NOT EXISTS task_rounds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            round_number INTEGER NOT NULL,
            prompt_snapshot TEXT,
            references_json TEXT,
            status TEXT NOT NULL DEFAULT 'preparing',
            submitted_at TEXT,
            completed_at TEXT,
            success_count INTEGER DEFAULT 0,
            failure_reason TEXT,
            FOREIGN KEY (task_id) REFERENCES tasks(id)
        );
        CREATE INDEX IF NOT EXISTS idx_task_rounds_task_id ON task_rounds(task_id);
        CREATE INDEX IF NOT EXISTS idx_task_rounds_status ON task_rounds(status);

        CREATE TABLE IF NOT EXISTS task_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_round_id INTEGER NOT NULL,
            image_index INTEGER NOT NULL,
            original_url TEXT,
            saved_path TEXT,
            sha256 TEXT,
            file_size INTEGER,
            format TEXT,
            download_status TEXT DEFAULT 'pending',
            FOREIGN KEY (task_round_id) REFERENCES task_rounds(id)
        );
        CREATE INDEX IF NOT EXISTS idx_task_images_round_id ON task_images(task_round_id);
        CREATE INDEX IF NOT EXISTS idx_task_images_index ON task_images(task_round_id, image_index);

        CREATE TABLE IF NOT EXISTS image_pool_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            image_path TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            last_used_at TEXT,
            use_count INTEGER DEFAULT 0,
            FOREIGN KEY (project_id) REFERENCES projects(id)
        );
        CREATE INDEX IF NOT EXISTS idx_image_pool_records_project_id ON image_pool_records(project_id);
        CREATE INDEX IF NOT EXISTS idx_image_pool_records_sha256 ON image_pool_records(sha256);

        CREATE TABLE IF NOT EXISTS execution_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER,
            level TEXT NOT NULL DEFAULT 'info',
            message TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (task_id) REFERENCES tasks(id)
        );
        CREATE INDEX IF NOT EXISTS idx_execution_logs_task_id ON execution_logs(task_id);
        CREATE INDEX IF NOT EXISTS idx_execution_logs_created_at ON execution_logs(created_at);
        CREATE INDEX IF NOT EXISTS idx_execution_logs_level ON execution_logs(level);

        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        "#,
    )?;
    Ok(())
}
