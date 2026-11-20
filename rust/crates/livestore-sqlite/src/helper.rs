//! `sqlite-db-helper.ts`.

use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::Connection;

use crate::Error;

/// `withSavepoint`: runs `f` inside a uniquely named savepoint, releasing it on success and rolling back to it on
/// failure or panic. Composes with an outer transaction. Savepoint statement failures surface as
/// [`Error::SqliteQuery`] carrying the failing statement.
pub fn with_savepoint<T, E: From<Error>>(
    conn: &Connection,
    f: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    let name = format!(
        "livestore_savepoint_{}",
        NEXT_SAVEPOINT_ID.fetch_add(1, Ordering::Relaxed)
    );
    let release = format!("RELEASE SAVEPOINT {name}");
    let rollback = format!("ROLLBACK TO SAVEPOINT {name}");
    exec(conn, &format!("SAVEPOINT {name}"))?;
    let mut guard = UnwindGuard {
        conn,
        rollback: &rollback,
        release: &release,
        armed: true,
    };
    let result = f();
    guard.armed = false;
    match result {
        Ok(v) => {
            exec(conn, &release)?;
            Ok(v)
        }
        Err(e) => {
            exec(conn, &rollback)?;
            exec(conn, &release)?;
            Err(e)
        }
    }
}

static NEXT_SAVEPOINT_ID: AtomicU64 = AtomicU64::new(0);

/// Rolls the savepoint back when `f` unwinds (the Rust analogue of fiber interruption).
struct UnwindGuard<'a> {
    conn: &'a Connection,
    rollback: &'a str,
    release: &'a str,
    armed: bool,
}

impl Drop for UnwindGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.conn.execute_batch(self.rollback);
            let _ = self.conn.execute_batch(self.release);
        }
    }
}

fn exec(conn: &Connection, sql: &str) -> Result<(), Error> {
    conn.execute_batch(sql).map_err(|cause| Error::SqliteQuery {
        sql: sql.into(),
        cause,
    })
}
