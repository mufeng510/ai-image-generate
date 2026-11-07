use rusqlite::Connection;
use dirs;

pub fn init_db() -> Result<(), Box<dyn std::error::Error>> {
    let app_dir = dirs::data_local_dir()
        .ok_or("无法获取本地数据目录")?
        .join("DoubaoBatchImage");
    std::fs::create_dir_all(&app_dir)?;
    let db_path = app_dir.join("app.db");
    let conn = Connection::open(&db_path)?;
    crate::schema::create_tables(&conn)?;
    crate::schema::migrate(&conn)?;
    Ok(())
}

pub fn get_connection() -> Result<Connection, String> {
    let app_dir = dirs::data_local_dir()
        .ok_or("无法获取本地数据目录")?
        .join("DoubaoBatchImage");
    let db_path = app_dir.join("app.db");
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
    Ok(conn)
}
