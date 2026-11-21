//! Port of tests/wa-sqlite/test/unit/basic-sqlite-api.test.ts (`makeSynchronousDatabase` = a rusqlite `Connection`).
#![allow(clippy::approx_constant)]
use rusqlite::{Connection, named_params, params, types::Value};

fn db() -> Connection {
    Connection::open_in_memory().unwrap()
}

fn select(db: &Connection, sql: &str) -> Vec<Vec<Value>> {
    let mut stmt = db.prepare(sql).unwrap();
    let n = stmt.column_count();
    stmt.query_map([], |r| (0..n).map(|i| r.get(i)).collect())
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[test]
fn should_create_and_execute_basic_sql_statements() {
    let db = db();
    db.execute(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO users (name, age) VALUES (?, ?)",
        params!["Alice", 30],
    )
    .unwrap();
    db.execute(
        "INSERT INTO users (name, age) VALUES (?, ?)",
        params!["Bob", 25],
    )
    .unwrap();

    let users = select(&db, "SELECT * FROM users ORDER BY id");
    assert_eq!(users.len(), 2);
    assert_eq!(
        users[0],
        vec![
            Value::Integer(1),
            Value::Text("Alice".into()),
            Value::Integer(30)
        ]
    );
    assert_eq!(
        users[1],
        vec![
            Value::Integer(2),
            Value::Text("Bob".into()),
            Value::Integer(25)
        ]
    );
}

#[test]
fn should_handle_prepared_statements() {
    let db = db();
    db.execute(
        "CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, price REAL)",
        [],
    )
    .unwrap();
    let mut insert = db
        .prepare("INSERT INTO products (name, price) VALUES (?, ?)")
        .unwrap();
    insert.execute(params!["Laptop", 999.99]).unwrap();
    insert.execute(params!["Mouse", 29.99]).unwrap();
    insert.finalize().unwrap();

    let products = select(&db, "SELECT * FROM products ORDER BY id");
    assert_eq!(products.len(), 2);
    assert_eq!(
        products[0],
        vec![
            Value::Integer(1),
            Value::Text("Laptop".into()),
            Value::Real(999.99)
        ]
    );
    assert_eq!(
        products[1],
        vec![
            Value::Integer(2),
            Value::Text("Mouse".into()),
            Value::Real(29.99)
        ]
    );
}

#[test]
fn should_handle_transactions() {
    let db = db();
    db.execute(
        "CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance REAL)",
        [],
    )
    .unwrap();
    db.execute("INSERT INTO accounts (balance) VALUES (1000), (500)", [])
        .unwrap();
    db.execute("BEGIN TRANSACTION", []).unwrap();
    let transfer = (|| {
        db.execute(
            "UPDATE accounts SET balance = balance - ? WHERE id = ?",
            params![100, 1],
        )?;
        db.execute(
            "UPDATE accounts SET balance = balance + ? WHERE id = ?",
            params![100, 2],
        )?;
        db.execute("COMMIT", [])
    })();
    if let Err(e) = transfer {
        db.execute("ROLLBACK", []).unwrap();
        panic!("{e}");
    }

    let accounts = select(&db, "SELECT * FROM accounts ORDER BY id");
    assert_eq!(accounts[0][1], Value::Real(900.0));
    assert_eq!(accounts[1][1], Value::Real(600.0));
}

#[test]
fn should_handle_named_parameters() {
    let db = db();
    db.execute(
        "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, category TEXT)",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO items (name, category) VALUES ($name, $category)",
        named_params! { "$name": "Book", "$category": "Education" },
    )
    .unwrap();

    let mut stmt = db
        .prepare("SELECT * FROM items WHERE category = $category")
        .unwrap();
    let items: Vec<(i64, String, String)> = stmt
        .query_map(named_params! { "$category": "Education" }, |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        items,
        vec![(1, "Book".to_string(), "Education".to_string())]
    );
}

#[test]
fn should_handle_different_data_types() {
    let db = db();
    db.execute_batch(
        "CREATE TABLE mixed_types (
            id INTEGER PRIMARY KEY,
            text_col TEXT,
            int_col INTEGER,
            real_col REAL,
            blob_col BLOB,
            null_col NULL
        )",
    )
    .unwrap();
    let blob = vec![1u8, 2, 3, 4];
    db.execute(
        "INSERT INTO mixed_types (text_col, int_col, real_col, blob_col, null_col) VALUES (?, ?, ?, ?, ?)",
        params!["Hello", 42, 3.14, blob, Value::Null],
    )
    .unwrap();

    let result = select(&db, "SELECT * FROM mixed_types");
    assert_eq!(result.len(), 1);
    assert_eq!(result[0][1], Value::Text("Hello".into()));
    assert_eq!(result[0][2], Value::Integer(42));
    assert_eq!(result[0][3], Value::Real(3.14));
    assert_eq!(result[0][4], Value::Blob(blob));
    assert_eq!(result[0][5], Value::Null);
}

#[test]
fn should_handle_database_export() {
    let db = db();
    db.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)", [])
        .unwrap();
    db.execute("INSERT INTO test (value) VALUES (?)", ["test data"])
        .unwrap();

    let exported = db.serialize("main").unwrap();
    assert!(!exported.is_empty());
}

#[test]
fn should_track_row_changes() {
    let db = db();
    db.execute(
        "CREATE TABLE counter (id INTEGER PRIMARY KEY, count INTEGER DEFAULT 0)",
        [],
    )
    .unwrap();

    db.execute("INSERT INTO counter (count) VALUES (1)", [])
        .unwrap();
    assert_eq!(db.changes(), 1);

    db.execute("INSERT INTO counter (count) VALUES (2), (3)", [])
        .unwrap();
    assert_eq!(db.changes(), 2);
}
