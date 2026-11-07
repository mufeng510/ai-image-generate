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
            interrupted_status TEXT,
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
            output_dir TEXT,
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

/// 增量迁移：仅添加缺失列，不删除、不覆盖用户数据。
/// 使用 PRAGMA table_info 判断列是否存在，兼容已经安装过的旧数据库。
pub fn migrate(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    ensure_column(conn, "tasks", "interrupted_status", "TEXT")?;
    ensure_column(conn, "task_rounds", "output_dir", "TEXT")?;
    conn.pragma_update(None, "user_version", 1)?;
    Ok(())
}

fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    decl: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table))?;
    let exists = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .any(|name| name == column);
    if !exists {
        conn.execute(
            &format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, decl),
            [],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn columns(conn: &Connection, table: &str) -> Vec<String> {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table)).unwrap();
        stmt.query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    fn user_version(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn migrate_adds_missing_columns_to_legacy_db() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE tasks (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE task_rounds (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL);
            "#,
        )
        .unwrap();

        migrate(&conn).unwrap();

        assert!(columns(&conn, "tasks").contains(&"interrupted_status".to_string()));
        assert!(columns(&conn, "task_rounds").contains(&"output_dir".to_string()));
        assert_eq!(user_version(&conn), 1);
    }

    #[test]
    fn migrate_is_idempotent_on_fresh_db() {
        let conn = Connection::open_in_memory().unwrap();
        create_tables(&conn).unwrap();

        migrate(&conn).unwrap();
        let before = columns(&conn, "tasks");
        migrate(&conn).unwrap();

        assert_eq!(before, columns(&conn, "tasks"));
        assert!(columns(&conn, "tasks").contains(&"interrupted_status".to_string()));
        assert!(columns(&conn, "task_rounds").contains(&"output_dir".to_string()));
        assert_eq!(user_version(&conn), 1);
    }
}
