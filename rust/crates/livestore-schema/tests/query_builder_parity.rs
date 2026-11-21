//! Port of `schema/state/sqlite/query-builder/impl.test.ts`.

use std::sync::LazyLock;

use livestore_schema::query_builder::{
    Cond, Direction, Filter, First, OnConflict, Op, QueryBuilderError, SqlQuery,
};
use livestore_schema::value_schema as s;
use livestore_schema::{Column, SqlValue, Table};
use serde_json::{Value, json};

static TODOS: LazyLock<Table> = LazyLock::new(|| {
    Table::new("todos")
        .column(Column::text("id").primary_key())
        .column(Column::text("text").default(""))
        .column(Column::boolean("completed").default(false))
        .column(Column::text("status"))
        .column(Column::datetime("deletedAt").nullable())
});

static ISSUE: LazyLock<Table> = LazyLock::new(|| {
    Table::new("issue")
        .column(Column::integer("id").primary_key())
        .column(Column::text("title").default(""))
        .column(Column::text("creator").default(""))
        .column(Column::integer("priority").default(0i64))
        .column(Column::datetime_millis("created"))
        .column(Column::datetime_millis("deleted").nullable())
        .column(Column::datetime_millis("modified"))
        .column(Column::text("kanbanorder").default(""))
        .index("issue_kanbanorder", &["kanbanorder"])
        .index("issue_created", &["created"])
});

static SELECTIONS: LazyLock<Table> = LazyLock::new(|| {
    Table::new("selections")
        .column(Column::integer("id").primary_key())
        .column(Column::text("group"))
});

static PERSON_PROFILES: LazyLock<Table> = LazyLock::new(|| {
    Table::new("person_profiles")
        .column(Column::text("personId").primary_key())
        .column(json_array("sources").default("[]"))
        .column(json_array("tags").default("[]"))
        .column(json_array("attributes").default("[]"))
        .column(json_array("optionalTags").nullable())
});

/// `State.SQLite.json({ schema: Schema.Array(...) })`: only the decoded side being an array matters here.
fn json_array(name: &str) -> Column {
    Column::json(name).schema(s::array(s::string()))
}

fn sql(query: &str, binds: impl IntoIterator<Item = SqlValue>, table: &str) -> SqlQuery {
    SqlQuery {
        query: query.into(),
        bind_values: binds.into_iter().collect(),
        used_tables: [table.to_string()].into(),
    }
}

fn todo_values() -> [(&'static str, Value); 3] {
    [
        ("id", json!("123")),
        ("text", json!("Buy milk")),
        ("status", json!("active")),
    ]
}

fn t(s: &str) -> SqlValue {
    SqlValue::Text(s.into())
}

fn i(n: i64) -> SqlValue {
    SqlValue::Integer(n)
}

#[test]
fn should_handle_simple_select_queries() {
    assert_eq!(
        TODOS.query().as_sql().unwrap(),
        sql("SELECT * FROM 'todos'", [], "todos")
    );
    assert_eq!(
        TODOS.query().select(&["id"]).as_sql().unwrap(),
        sql("SELECT \"id\" FROM 'todos'", [], "todos")
    );
    assert_eq!(
        TODOS.query().select(&["id", "text"]).as_sql().unwrap(),
        sql("SELECT \"id\", \"text\" FROM 'todos'", [], "todos")
    );
}

#[test]
fn derives_result_schemas_for_select_queries() {
    let rows = json!([{ "id": "123", "text": "Buy milk" }]);
    assert_eq!(
        TODOS
            .query()
            .select(&["id", "text"])
            .decode_result(&rows)
            .unwrap(),
        rows
    );
    assert_eq!(
        TODOS
            .query()
            .select(&["id"])
            .decode_result(&json!([{ "id": "123" }]))
            .unwrap(),
        json!(["123"])
    );
}

#[test]
fn should_handle_first() {
    let expected = sql(
        "SELECT \"id\", \"text\" FROM 'todos' LIMIT ?",
        [i(1)],
        "todos",
    );
    assert_eq!(
        TODOS
            .query()
            .select(&["id", "text"])
            .first(First::Undefined)
            .as_sql()
            .unwrap(),
        expected
    );
    assert_eq!(
        TODOS
            .query()
            .select(&["id", "text"])
            .first(First::Error)
            .as_sql()
            .unwrap(),
        expected
    );
    assert_eq!(
        TODOS
            .query()
            .select(&["id", "text"])
            .first(First::Fallback(Value::Null))
            .as_sql()
            .unwrap(),
        expected
    );
}

#[test]
fn derives_result_schemas_for_first() {
    let row = json!({ "id": "123", "text": "Buy milk" });
    let or_undefined = TODOS
        .query()
        .select(&["id", "text"])
        .first(First::Undefined);
    assert_eq!(or_undefined.decode_result(&json!([])).unwrap(), Value::Null);
    assert_eq!(or_undefined.decode_result(&json!([row])).unwrap(), row);

    let or_error = TODOS.query().select(&["id", "text"]).first(First::Error);
    assert_eq!(or_error.decode_result(&json!([row])).unwrap(), row);
    assert_eq!(
        or_error.decode_result(&json!([])).unwrap_err().to_string(),
        "Unable to retrieve the first element of an empty array"
    );

    let or_fallback = TODOS
        .query()
        .select(&["id", "text"])
        .first(First::Fallback(Value::Null));
    assert_eq!(or_fallback.decode_result(&json!([])).unwrap(), Value::Null);
}

#[test]
fn should_handle_where_clauses() {
    let q = || TODOS.query().select(&["id", "text"]);
    let completed = sql(
        "SELECT \"id\", \"text\" FROM 'todos' WHERE \"completed\" = ?",
        [i(1)],
        "todos",
    );
    assert_eq!(
        q().where_eq("completed", json!(true)).as_sql().unwrap(),
        completed
    );
    assert_eq!(
        q().where_op("completed", Op::Ne, json!(true))
            .as_sql()
            .unwrap(),
        sql(
            "SELECT \"id\", \"text\" FROM 'todos' WHERE \"completed\" != ?",
            [i(1)],
            "todos"
        )
    );
    assert_eq!(
        q().where_all([("completed", json!(true).into())])
            .as_sql()
            .unwrap(),
        completed
    );
    assert_eq!(
        q().where_all([("completed", Cond::Undefined)])
            .as_sql()
            .unwrap(),
        sql("SELECT \"id\", \"text\" FROM 'todos'", [], "todos")
    );
    assert_eq!(
        q().where_all([("deletedAt", Cond::Op(Op::Le, json!("2024-01-01")))])
            .as_sql()
            .unwrap(),
        sql(
            "SELECT \"id\", \"text\" FROM 'todos' WHERE \"deletedAt\" <= ?",
            [t("2024-01-01T00:00:00.000Z")],
            "todos"
        )
    );
    assert_eq!(
        q().where_all([("status", Cond::Op(Op::In, json!(["active"])))])
            .as_sql()
            .unwrap(),
        sql(
            "SELECT \"id\", \"text\" FROM 'todos' WHERE \"status\" IN (?)",
            [t("active")],
            "todos"
        )
    );
    assert_eq!(
        q().where_all([(
            "status",
            Cond::Op(Op::NotIn, json!(["active", "completed"]))
        )])
        .as_sql()
        .unwrap(),
        sql(
            "SELECT \"id\", \"text\" FROM 'todos' WHERE \"status\" NOT IN (?, ?)",
            [t("active"), t("completed")],
            "todos"
        )
    );
    assert_eq!(
        q().where_all([("completed", json!(false).into())])
            .where_all([("status", Cond::Op(Op::In, json!(["active"])))])
            .where_all([("deletedAt", Cond::Undefined)])
            .as_sql()
            .unwrap(),
        sql(
            "SELECT \"id\", \"text\" FROM 'todos' WHERE \"completed\" = ? AND \"status\" IN (?)",
            [i(0), t("active")],
            "todos"
        )
    );
}

#[test]
fn should_handle_offset_and_limit_clauses() {
    assert_eq!(
        TODOS
            .query()
            .select(&["id", "text"])
            .where_eq("completed", json!(true))
            .offset(10)
            .limit(10)
            .as_sql()
            .unwrap(),
        sql(
            "SELECT \"id\", \"text\" FROM 'todos' WHERE \"completed\" = ? LIMIT ? OFFSET ?",
            [i(1), i(10), i(10)],
            "todos"
        )
    );
}

#[test]
fn should_handle_offset_and_limit_clauses_correctly() {
    let q = || {
        TODOS
            .query()
            .select(&["id", "text"])
            .where_eq("completed", json!(true))
    };
    assert_eq!(
        q().offset(5).limit(10).as_sql().unwrap(),
        sql(
            "SELECT \"id\", \"text\" FROM 'todos' WHERE \"completed\" = ? LIMIT ? OFFSET ?",
            [i(1), i(10), i(5)],
            "todos"
        )
    );
    assert_eq!(
        q().offset(5).as_sql().unwrap(),
        sql(
            "SELECT \"id\", \"text\" FROM 'todos' WHERE \"completed\" = ? OFFSET ?",
            [i(1), i(5)],
            "todos"
        )
    );
    assert_eq!(
        q().limit(10).as_sql().unwrap(),
        sql(
            "SELECT \"id\", \"text\" FROM 'todos' WHERE \"completed\" = ? LIMIT ?",
            [i(1), i(10)],
            "todos"
        )
    );
}

#[test]
fn should_handle_count_queries() {
    assert_eq!(
        TODOS.query().count().as_sql().unwrap(),
        sql("SELECT COUNT(*) as count FROM 'todos'", [], "todos")
    );
    let expected = sql(
        "SELECT COUNT(*) as count FROM 'todos' WHERE \"completed\" = ?",
        [i(1)],
        "todos",
    );
    assert_eq!(
        TODOS
            .query()
            .count()
            .where_eq("completed", json!(true))
            .as_sql()
            .unwrap(),
        expected
    );
    assert_eq!(
        TODOS
            .query()
            .where_eq("completed", json!(true))
            .count()
            .as_sql()
            .unwrap(),
        expected
    );
}

#[test]
fn derives_result_schemas_for_count_queries() {
    assert_eq!(
        TODOS
            .query()
            .count()
            .decode_result(&json!([{ "count": 3 }]))
            .unwrap(),
        json!(3)
    );
}

#[test]
fn should_handle_null_comparisons() {
    assert_eq!(
        TODOS
            .query()
            .select(&["id", "text"])
            .where_op("deletedAt", Op::Eq, Value::Null)
            .as_sql()
            .unwrap(),
        sql(
            "SELECT \"id\", \"text\" FROM 'todos' WHERE \"deletedAt\" IS NULL",
            [],
            "todos"
        )
    );
    assert_eq!(
        TODOS
            .query()
            .select(&["id", "text"])
            .where_op("deletedAt", Op::Ne, Value::Null)
            .as_sql()
            .unwrap(),
        sql(
            "SELECT \"id\", \"text\" FROM 'todos' WHERE \"deletedAt\" IS NOT NULL",
            [],
            "todos"
        )
    );
}

#[test]
fn should_handle_order_by() {
    let expected = sql(
        "SELECT * FROM 'todos' ORDER BY \"completed\" desc",
        [],
        "todos",
    );
    assert_eq!(
        TODOS
            .query()
            .order_by("completed", Direction::Desc)
            .as_sql()
            .unwrap(),
        expected
    );
    assert_eq!(
        TODOS
            .query()
            .order_by_all([("completed", Direction::Desc)])
            .as_sql()
            .unwrap(),
        expected
    );
    assert_eq!(
        TODOS.query().order_by_all([]).as_sql().unwrap(),
        sql("SELECT * FROM 'todos'", [], "todos")
    );
}

#[test]
fn should_handle_json_contains_operator_for_json_array_columns() {
    assert_eq!(
        PERSON_PROFILES
            .query()
            .where_all([("sources", Cond::Op(Op::JsonContains, json!("google")))])
            .as_sql()
            .unwrap(),
        sql(
            "SELECT * FROM 'person_profiles' WHERE EXISTS (SELECT 1 FROM json_each(\"sources\") WHERE value = ?)",
            [t("google")],
            "person_profiles"
        )
    );
    assert_eq!(
        PERSON_PROFILES
            .query()
            .select(&["personId"])
            .where_all([("sources", Cond::Op(Op::JsonContains, json!("linkedin")))])
            .as_sql()
            .unwrap(),
        sql(
            "SELECT \"personId\" FROM 'person_profiles' WHERE EXISTS (SELECT 1 FROM json_each(\"sources\") WHERE value = ?)",
            [t("linkedin")],
            "person_profiles"
        )
    );
    assert_eq!(
        PERSON_PROFILES
            .query()
            .where_all([("tags", Cond::Op(Op::JsonContains, json!("important")))])
            .as_sql()
            .unwrap(),
        sql(
            "SELECT * FROM 'person_profiles' WHERE EXISTS (SELECT 1 FROM json_each(\"tags\") WHERE value = ?)",
            [t("important")],
            "person_profiles"
        )
    );
}

#[test]
fn should_handle_json_not_contains_operator_for_json_array_columns() {
    assert_eq!(
        PERSON_PROFILES
            .query()
            .where_all([("sources", Cond::Op(Op::JsonNotContains, json!("google")))])
            .as_sql()
            .unwrap(),
        sql(
            "SELECT * FROM 'person_profiles' WHERE NOT EXISTS (SELECT 1 FROM json_each(\"sources\") WHERE value = ?)",
            [t("google")],
            "person_profiles"
        )
    );
}

#[test]
fn should_json_stringify_object_elements_for_json_contains() {
    assert_eq!(
        PERSON_PROFILES
            .query()
            .where_all([(
                "attributes",
                Cond::Op(
                    Op::JsonContains,
                    json!({ "key": "language", "value": "typescript" })
                )
            )])
            .as_sql()
            .unwrap(),
        sql(
            "SELECT * FROM 'person_profiles' WHERE EXISTS (SELECT 1 FROM json_each(\"attributes\") WHERE value = ?)",
            [t(r#"{"key":"language","value":"typescript"}"#)],
            "person_profiles"
        )
    );
}

#[test]
fn should_handle_combining_json_contains_with_other_where_clauses() {
    assert_eq!(
        PERSON_PROFILES
            .query()
            .where_all([("sources", Cond::Op(Op::JsonContains, json!("google")))])
            .where_all([("sources", Cond::Op(Op::JsonNotContains, json!("facebook")))])
            .as_sql()
            .unwrap(),
        sql(
            "SELECT * FROM 'person_profiles' WHERE EXISTS (SELECT 1 FROM json_each(\"sources\") WHERE value = ?) AND NOT EXISTS (SELECT 1 FROM json_each(\"sources\") WHERE value = ?)",
            [t("google"), t("facebook")],
            "person_profiles"
        )
    );
}

#[test]
fn should_handle_json_contains_on_nullable_json_array_columns() {
    assert_eq!(
        PERSON_PROFILES
            .query()
            .where_all([(
                "optionalTags",
                Cond::Op(Op::JsonContains, json!("important"))
            )])
            .as_sql()
            .unwrap(),
        sql(
            "SELECT * FROM 'person_profiles' WHERE EXISTS (SELECT 1 FROM json_each(\"optionalTags\") WHERE value = ?)",
            [t("important")],
            "person_profiles"
        )
    );
    assert_eq!(
        PERSON_PROFILES
            .query()
            .where_all([(
                "optionalTags",
                Cond::Op(Op::JsonNotContains, json!("archived"))
            )])
            .as_sql()
            .unwrap(),
        sql(
            "SELECT * FROM 'person_profiles' WHERE NOT EXISTS (SELECT 1 FROM json_each(\"optionalTags\") WHERE value = ?)",
            [t("archived")],
            "person_profiles"
        )
    );
}

#[test]
fn should_throw_error_when_using_json_contains_on_non_json_array_column() {
    let err = TODOS
        .query()
        .where_all([("status", Cond::Op(Op::JsonContains, json!("active")))])
        .as_sql()
        .unwrap_err();
    assert!(
        err.to_string()
            .contains("JSON_CONTAINS operator can only be used on JSON array columns")
    );
}

#[test]
fn should_handle_insert_queries() {
    assert_eq!(
        TODOS.query().insert(todo_values()).as_sql().unwrap(),
        sql(
            "INSERT INTO 'todos' (\"id\", \"text\", \"status\") VALUES (?, ?, ?)",
            [t("123"), t("Buy milk"), t("active")],
            "todos"
        )
    );
}

#[test]
fn derives_result_schemas_for_write_queries() {
    assert_eq!(
        TODOS
            .query()
            .insert(todo_values())
            .decode_result(&json!(1))
            .unwrap(),
        json!(1)
    );
}

#[test]
fn should_handle_insert_queries_with_undefined_values() {
    assert_eq!(
        TODOS.query().insert(todo_values()).as_sql().unwrap(),
        sql(
            "INSERT INTO 'todos' (\"id\", \"text\", \"status\") VALUES (?, ?, ?)",
            [t("123"), t("Buy milk"), t("active")],
            "todos"
        )
    );
}

#[test]
fn should_handle_insert_queries_issue() {
    let values = [
        ("id", json!(1)),
        ("title", json!("Revert the user profile page")),
        ("priority", json!(2)),
        ("created", json!("2024-08-01T17:15:20.507Z")),
        ("modified", json!("2024-12-29T17:15:20.507Z")),
        ("kanbanorder", json!("a2")),
        ("creator", json!("John Doe")),
    ];
    assert_eq!(
        ISSUE.query().insert(values).as_sql().unwrap(),
        sql(
            "INSERT INTO 'issue' (\"id\", \"title\", \"priority\", \"created\", \"modified\", \"kanbanorder\", \"creator\") VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                i(1),
                t("Revert the user profile page"),
                i(2),
                i(1_722_532_520_507),
                i(1_735_492_520_507),
                t("a2"),
                t("John Doe")
            ],
            "issue"
        )
    );
}

#[test]
fn should_handle_update_queries() {
    assert_eq!(
        TODOS
            .query()
            .update([("status", json!("completed"))])
            .where_all([("id", json!("123").into())])
            .as_sql()
            .unwrap(),
        sql(
            "UPDATE 'todos' SET \"status\" = ? WHERE \"id\" = ?",
            [t("completed"), t("123")],
            "todos"
        )
    );
    assert_eq!(
        TODOS
            .query()
            .update([])
            .where_all([("id", json!("123").into())])
            .as_sql()
            .unwrap(),
        sql("SELECT 1", [], "todos")
    );
}

#[test]
fn should_handle_update_queries_with_undefined_values() {
    assert_eq!(
        TODOS
            .query()
            .update([("text", json!("some text"))])
            .where_all([("id", json!("123").into())])
            .as_sql()
            .unwrap(),
        sql(
            "UPDATE 'todos' SET \"text\" = ? WHERE \"id\" = ?",
            [t("some text"), t("123")],
            "todos"
        )
    );
}

#[test]
fn should_handle_update_queries_with_undefined_values_issue() {
    assert_eq!(
        ISSUE
            .query()
            .update([("priority", json!(2)), ("creator", json!("John Doe"))])
            .where_all([("id", json!(1).into())])
            .as_sql()
            .unwrap(),
        sql(
            "UPDATE 'issue' SET \"priority\" = ?, \"creator\" = ? WHERE \"id\" = ?",
            [i(2), t("John Doe"), i(1)],
            "issue"
        )
    );
}

#[test]
fn should_handle_delete_queries() {
    assert_eq!(
        TODOS
            .query()
            .delete()
            .where_all([("status", json!("completed").into())])
            .as_sql()
            .unwrap(),
        sql(
            "DELETE FROM 'todos' WHERE \"status\" = ?",
            [t("completed")],
            "todos"
        )
    );
}

#[test]
fn should_handle_insert_with_on_conflict() {
    let binds = [t("123"), t("Buy milk"), t("active")];
    assert_eq!(
        TODOS
            .query()
            .insert(todo_values())
            .on_conflict(&["id"], OnConflict::Ignore)
            .as_sql()
            .unwrap(),
        sql(
            "INSERT INTO 'todos' (\"id\", \"text\", \"status\") VALUES (?, ?, ?) ON CONFLICT (\"id\") DO NOTHING",
            binds.clone(),
            "todos"
        )
    );
    let update = OnConflict::Update(vec![
        ("text".into(), json!("Buy soy milk")),
        ("status".into(), json!("active")),
    ]);
    assert_eq!(
        TODOS
            .query()
            .insert(todo_values())
            .on_conflict(&["id"], update)
            .as_sql()
            .unwrap(),
        sql(
            "INSERT INTO 'todos' (\"id\", \"text\", \"status\") VALUES (?, ?, ?) ON CONFLICT (\"id\") DO UPDATE SET \"text\" = ?, \"status\" = ?",
            [
                t("123"),
                t("Buy milk"),
                t("active"),
                t("Buy soy milk"),
                t("active")
            ],
            "todos"
        )
    );
    assert_eq!(
        TODOS
            .query()
            .insert(todo_values())
            .on_conflict(&["id"], OnConflict::Replace)
            .as_sql()
            .unwrap(),
        sql(
            "INSERT OR REPLACE INTO 'todos' (\"id\", \"text\", \"status\") VALUES (?, ?, ?)",
            binds,
            "todos"
        )
    );
}

#[test]
fn should_quote_reserved_column_names() {
    assert_eq!(
        SELECTIONS
            .query()
            .insert([("id", json!(1)), ("group", json!("alpha"))])
            .on_conflict(&["id"], OnConflict::Ignore)
            .as_sql()
            .unwrap(),
        sql(
            "INSERT INTO 'selections' (\"id\", \"group\") VALUES (?, ?) ON CONFLICT (\"id\") DO NOTHING",
            [i(1), t("alpha")],
            "selections"
        )
    );
    assert_eq!(
        SELECTIONS
            .query()
            .update([("group", json!("beta"))])
            .where_all([("id", json!(1).into())])
            .as_sql()
            .unwrap(),
        sql(
            "UPDATE 'selections' SET \"group\" = ? WHERE \"id\" = ?",
            [t("beta"), i(1)],
            "selections"
        )
    );
}

#[test]
fn should_handle_on_conflict_with_multiple_columns() {
    assert_eq!(
        TODOS
            .query()
            .insert(todo_values())
            .on_conflict(&["id", "status"], OnConflict::Ignore)
            .as_sql()
            .unwrap(),
        sql(
            "INSERT INTO 'todos' (\"id\", \"text\", \"status\") VALUES (?, ?, ?) ON CONFLICT (\"id\", \"status\") DO NOTHING",
            [t("123"), t("Buy milk"), t("active")],
            "todos"
        )
    );
}

#[test]
fn should_handle_returning_clause() {
    assert_eq!(
        TODOS
            .query()
            .insert(todo_values())
            .returning(&["id"])
            .as_sql()
            .unwrap(),
        sql(
            "INSERT INTO 'todos' (\"id\", \"text\", \"status\") VALUES (?, ?, ?) RETURNING \"id\"",
            [t("123"), t("Buy milk"), t("active")],
            "todos"
        )
    );
    assert_eq!(
        TODOS
            .query()
            .update([("status", json!("completed"))])
            .where_all([("id", json!("123").into())])
            .returning(&["id"])
            .as_sql()
            .unwrap(),
        sql(
            "UPDATE 'todos' SET \"status\" = ? WHERE \"id\" = ? RETURNING \"id\"",
            [t("completed"), t("123")],
            "todos"
        )
    );
    assert_eq!(
        TODOS
            .query()
            .delete()
            .where_all([("status", json!("completed").into())])
            .returning(&["id"])
            .as_sql()
            .unwrap(),
        sql(
            "DELETE FROM 'todos' WHERE \"status\" = ? RETURNING \"id\"",
            [t("completed")],
            "todos"
        )
    );
}

#[test]
fn derives_result_schemas_for_returning_clauses() {
    let rows = json!([{ "id": "123" }]);
    assert_eq!(
        TODOS
            .query()
            .insert(todo_values())
            .returning(&["id"])
            .decode_result(&rows)
            .unwrap(),
        rows
    );
}

#[test]
fn should_handle_where_delete_preserving_where_clauses() {
    assert_eq!(
        TODOS
            .query()
            .where_all([("status", json!("completed").into())])
            .delete()
            .as_sql()
            .unwrap(),
        sql(
            "DELETE FROM 'todos' WHERE \"status\" = ?",
            [t("completed")],
            "todos"
        )
    );
    assert_eq!(
        TODOS
            .query()
            .where_all([("status", json!("completed").into())])
            .where_all([("deletedAt", Value::Null.into())])
            .delete()
            .as_sql()
            .unwrap(),
        sql(
            "DELETE FROM 'todos' WHERE \"status\" = ? AND \"deletedAt\" IS NULL",
            [t("completed")],
            "todos"
        )
    );
}

#[test]
fn should_handle_where_update_preserving_where_clauses() {
    assert_eq!(
        TODOS
            .query()
            .where_all([("id", json!("123").into())])
            .update([("status", json!("completed"))])
            .as_sql()
            .unwrap(),
        sql(
            "UPDATE 'todos' SET \"status\" = ? WHERE \"id\" = ?",
            [t("completed"), t("123")],
            "todos"
        )
    );
    assert_eq!(
        TODOS
            .query()
            .where_all([("id", json!("123").into())])
            .where_all([("deletedAt", Value::Null.into())])
            .update([("status", json!("completed"))])
            .as_sql()
            .unwrap(),
        sql(
            "UPDATE 'todos' SET \"status\" = ? WHERE \"id\" = ? AND \"deletedAt\" IS NULL",
            [t("completed"), t("123")],
            "todos"
        )
    );
}

#[test]
fn should_have_equivalent_behavior_for_both_delete_patterns() {
    let conds = || {
        [
            ("status", Cond::from(json!("completed"))),
            ("id", json!("123").into()),
        ]
    };
    assert_eq!(
        TODOS.query().where_all(conds()).delete().as_sql().unwrap(),
        TODOS.query().delete().where_all(conds()).as_sql().unwrap()
    );
}

#[test]
fn should_have_equivalent_behavior_for_both_update_patterns() {
    let values = || [("status", json!("completed")), ("text", json!("Updated"))];
    assert_eq!(
        TODOS
            .query()
            .where_all([("id", json!("123").into())])
            .update(values())
            .as_sql()
            .unwrap(),
        TODOS
            .query()
            .update(values())
            .where_all([("id", json!("123").into())])
            .as_sql()
            .unwrap()
    );
}

/// The flat physical columns behind TS's nested `contacts` schema transform.
fn contacts() -> Table {
    Table::new("contacts")
        .column(Column::text("id").primary_key())
        .column(Column::text("contactFirstName"))
        .column(Column::text("contactLastName"))
        .column(Column::text("contactEmail"))
}

#[test]
fn encodes_flat_insert_values_for_transformed_schemas() {
    let table = contacts();
    let values = [
        ("id", json!("person-1")),
        ("contactFirstName", json!("Ada")),
        ("contactLastName", json!("Lovelace")),
        ("contactEmail", json!("ada@example.com")),
    ];
    assert_eq!(
        table.query().insert(values).as_sql().unwrap(),
        sql(
            "INSERT INTO 'contacts' (\"id\", \"contactFirstName\", \"contactLastName\", \"contactEmail\") VALUES (?, ?, ?, ?)",
            [t("person-1"), t("Ada"), t("Lovelace"), t("ada@example.com")],
            "contacts"
        )
    );
}

#[test]
fn rejects_nested_insert_values_because_flat_columns_are_required() {
    let table = contacts();
    let values = [
        ("id", json!("person-1")),
        (
            "contact",
            json!({ "firstName": "Ada", "lastName": "Lovelace", "email": "ada@example.com" }),
        ),
    ];
    let err = table.query().insert(values).as_sql().unwrap_err();
    assert_eq!(
        err,
        QueryBuilderError::MissingKey("contactFirstName".into())
    );
    assert!(err.to_string().contains("contactFirstName"));
}

/// Columns with their own schema encode query values and decode rows through it (`Schema.encodeSync(colDef.schema)`).
#[test]
fn encodes_and_decodes_custom_column_schemas() {
    let prices = Table::new("prices")
        .column(Column::text("id").primary_key())
        .column(Column::text("amount").schema(s::finite_from_string()));
    assert_eq!(
        prices
            .query()
            .where_all([("amount", json!(3.5).into())])
            .as_sql()
            .unwrap(),
        sql(
            "SELECT * FROM 'prices' WHERE \"amount\" = ?",
            [t("3.5")],
            "prices"
        )
    );
    assert_eq!(
        prices
            .query()
            .decode_result(&json!([{ "id": "a", "amount": "3.5" }]))
            .unwrap(),
        json!([{ "id": "a", "amount": 3.5 }])
    );
}
