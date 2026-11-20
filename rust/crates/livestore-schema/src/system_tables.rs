//! System tables (`schema/state/sqlite/system-tables/*`), defined with the same DSL as app tables.

use crate::table::{Column, Table};

pub const SCHEMA_META_TABLE: &str = "__livestore_schema";
pub const SCHEMA_EVENT_DEFS_META_TABLE: &str = "__livestore_schema_event_defs";
pub const STATE_HEAD_TABLE: &str = "__livestore_state_head";
pub const MATERIALIZATION_JOURNAL_TABLE: &str = "__livestore_materialization_journal";
pub const REBUILD_TABLE: &str = "__livestore_rebuild";
pub const EVENTLOG_TABLE: &str = "eventlog";
pub const SYNC_STATUS_TABLE: &str = "__livestore_sync_status";

/// State DB system tables in creation order.
pub fn state_tables() -> Vec<Table> {
    let seq = |t: Table| {
        t.column(Column::integer("seqNumGlobal"))
            .column(Column::integer("seqNumClient"))
            .column(Column::integer("seqNumRebaseGeneration"))
    };
    vec![
        Table::new(SCHEMA_META_TABLE)
            .column(Column::text("tableName").primary_key())
            .column(Column::text("schemaHash"))
            .column(Column::text("updatedAt")),
        Table::new(SCHEMA_EVENT_DEFS_META_TABLE)
            .column(Column::text("eventName").primary_key())
            .column(Column::integer("schemaHash"))
            .column(Column::text("updatedAt")),
        seq(Table::new(STATE_HEAD_TABLE).column(Column::integer("id").primary_key())),
        seq(Table::new(MATERIALIZATION_JOURNAL_TABLE))
            .column(Column::blob("changeset").nullable())
            .index(
                "idx_materialization_journal_id",
                &["seqNumGlobal", "seqNumClient"],
            ),
        Table::new(REBUILD_TABLE).column(Column::integer("id").primary_key()),
    ]
}

/// Eventlog DB system tables in creation order.
pub fn eventlog_tables() -> Vec<Table> {
    let seq = ["seqNumGlobal", "seqNumClient", "seqNumRebaseGeneration"];
    let mut eventlog = Table::new(EVENTLOG_TABLE);
    for name in seq.iter().copied().chain([
        "parentSeqNumGlobal",
        "parentSeqNumClient",
        "parentSeqNumRebaseGeneration",
    ]) {
        let column = Column::integer(name);
        eventlog = eventlog.column(if seq.contains(&name) {
            column.primary_key()
        } else {
            column
        });
    }
    for name in ["name", "argsJson", "clientId", "sessionId"] {
        eventlog = eventlog.column(Column::text(name));
    }
    eventlog = eventlog
        .column(Column::integer("schemaHash"))
        .column(Column::text("syncMetadataJson"))
        .index("idx_eventlog_seqNumGlobal", &["seqNumGlobal"])
        .index("idx_eventlog_seqNum", &seq);
    vec![
        eventlog,
        Table::new(SYNC_STATUS_TABLE)
            .column(Column::integer("head").primary_key())
            .column(Column::text("backendId").nullable()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eventlog_ddl_matches_ts() {
        let ddl: Vec<String> = eventlog_tables().iter().flat_map(Table::ddl).collect();
        assert_eq!(
            ddl[0],
            r#"create table if not exists "eventlog" ("seqNumGlobal" integer   not null , "seqNumClient" integer   not null , "seqNumRebaseGeneration" integer   not null , "parentSeqNumGlobal" integer   not null , "parentSeqNumClient" integer   not null , "parentSeqNumRebaseGeneration" integer   not null , "name" text   not null , "argsJson" text   not null , "clientId" text   not null , "sessionId" text   not null , "schemaHash" integer   not null , "syncMetadataJson" text   not null , PRIMARY KEY ("seqNumGlobal", "seqNumClient", "seqNumRebaseGeneration")) strict"#
        );
        assert_eq!(
            ddl[3],
            r#"create table if not exists "__livestore_sync_status" ("head" integer primary key   , "backendId" text    ) strict"#
        );
    }

    #[test]
    fn state_ddl_matches_ts() {
        let ddl: Vec<String> = state_tables().iter().flat_map(Table::ddl).collect();
        assert_eq!(
            ddl[3],
            r#"create table if not exists "__livestore_materialization_journal" ("seqNumGlobal" integer   not null , "seqNumClient" integer   not null , "seqNumRebaseGeneration" integer   not null , "changeset" blob    ) strict"#
        );
        assert_eq!(
            ddl[5],
            r#"create table if not exists "__livestore_rebuild" ("id" integer primary key   ) strict"#
        );
    }
}
