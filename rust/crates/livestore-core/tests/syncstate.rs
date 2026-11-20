use livestore_core::{Event, MergeResult, Payload, SeqNum, SyncState, is_equal_encoded};
use serde_json::{Value, json};

#[test]
fn round_trips_pending_events_through_its_encoded_form() {
    let state = SyncState {
        pending: vec![e(1, 0)],
        upstream_head: SeqNum::ROOT,
        local_head: e(1, 0).seq_num,
    };
    let decoded: SyncState = serde_json::from_value(serde_json::to_value(&state).unwrap()).unwrap();
    assert_eq!(decoded.pending, vec![e(1, 0)]);
}

#[test]
fn rejects_malformed_pending_events_when_decoding() {
    let head = serde_json::to_value(e(1, 0).seq_num).unwrap();
    let malformed =
        json!({ "pending": [{ "name": "a" }], "upstreamHead": head, "localHead": head });
    assert!(serde_json::from_value::<SyncState>(malformed).is_err());
}

#[test]
fn should_rollback_until_start() {
    let state = st(vec![e(2, 0)], SeqNum::ROOT, e(2, 0).seq_num);
    let e1_0_e2_0 = rebase(&e(1, 0), e(2, 0).seq_num, 0);
    let e1_1_e2_1 = rebase(&e(1, 1), e1_0_e2_0.seq_num, 0);
    let result = merge(
        &state,
        Payload::UpstreamRebase {
            rollback_events: vec![e(1, 0), e(1, 1)],
            new_events: vec![e1_0_e2_0.clone(), e1_1_e2_1.clone()],
        },
        false,
    );
    let e2_0_e3_0 = rebase(&e(2, 0), e1_0_e2_0.seq_num, 1);
    let (s, new_events, rollback) = expect_rebase(result);
    assert_events(&s.pending, std::slice::from_ref(&e2_0_e3_0));
    assert_eq!(s.upstream_head, e1_1_e2_1.seq_num);
    assert_eq!(s.local_head, e2_0_e3_0.seq_num);
    assert_events(&new_events, &[e1_0_e2_0, e1_1_e2_1, e2_0_e3_0]);
    assert_events(&rollback, &[e(1, 0), e(1, 1), e(2, 0)]);
}

#[test]
fn should_rollback_only_to_specified_point() {
    let state = st(vec![e(2, 0)], SeqNum::ROOT, e(2, 0).seq_num);
    let e1_1_e2_0 = rebase(&e(1, 1), e(1, 0).seq_num, 0);
    let result = merge(
        &state,
        Payload::UpstreamRebase {
            new_events: vec![e1_1_e2_0.clone()],
            rollback_events: vec![e(1, 1)],
        },
        false,
    );
    let e2_0_e3_0 = rebase(&e(2, 0), e1_1_e2_0.seq_num, 1);
    let (s, new_events, rollback) = expect_rebase(result);
    assert_events(&s.pending, std::slice::from_ref(&e2_0_e3_0));
    assert_eq!(s.upstream_head, e1_1_e2_0.seq_num);
    assert_eq!(s.local_head, e2_0_e3_0.seq_num);
    assert_events(&new_events, &[e1_1_e2_0, e2_0_e3_0]);
    assert_events(&rollback, &[e(1, 1), e(2, 0)]);
}

#[test]
fn should_work_for_empty_pending() {
    let state = st(vec![], SeqNum::ROOT, e(1, 0).seq_num);
    let result = merge(
        &state,
        Payload::UpstreamRebase {
            rollback_events: vec![e(1, 0)],
            new_events: vec![e(2, 0)],
        },
        false,
    );
    let (s, new_events, _) = expect_rebase(result);
    assert_events(&s.pending, &[]);
    assert_eq!(s.upstream_head, e(2, 0).seq_num);
    assert_eq!(s.local_head, e(2, 0).seq_num);
    assert_events(&new_events, &[e(2, 0)]);
}

#[test]
fn should_die_if_new_events_are_not_sorted_in_ascending_order_by_event_number_client() {
    let state = st(vec![e(1, 0)], SeqNum::ROOT, e(1, 0).seq_num);
    assert!(try_merge(&state, advance(vec![e(1, 1), e(1, 0)]), false).is_err());
}

#[test]
fn should_die_if_new_events_are_not_sorted_in_ascending_order_by_event_number_global() {
    let state = st(vec![e(1, 0)], SeqNum::ROOT, e(1, 0).seq_num);
    assert!(try_merge(&state, advance(vec![e(2, 0), e(1, 0)]), false).is_err());
}

#[test]
fn should_die_if_incoming_event_is_lt_expected_upstream_head() {
    let state = st(vec![], e(2, 0).seq_num, e(2, 0).seq_num);
    assert!(try_merge(&state, advance(vec![e(1, 0)]), false).is_err());
}

#[test]
fn should_die_if_incoming_event_is_eq_expected_upstream_head() {
    let state = st(vec![], e(2, 0).seq_num, e(2, 0).seq_num);
    assert!(try_merge(&state, advance(vec![e(2, 0)]), false).is_err());
}

#[test]
fn should_confirm_pending_event_when_receiving_matching_event() {
    let state = st(vec![e(1, 0)], SeqNum::ROOT, e(1, 0).seq_num);
    let (s, new_events, confirmed) = expect_advance(merge(&state, advance(vec![e(1, 0)]), false));
    assert_events(&s.pending, &[]);
    assert_eq!(s.upstream_head, e(1, 0).seq_num);
    assert_eq!(s.local_head, e(1, 0).seq_num);
    assert_events(&new_events, &[]);
    assert_events(&confirmed, &[e(1, 0)]);
}

#[test]
fn should_confirm_partial_pending_event_when_receiving_matching_event() {
    let state = st(vec![e(1, 0), e(2, 0)], SeqNum::ROOT, e(2, 0).seq_num);
    let (s, new_events, confirmed) = expect_advance(merge(&state, advance(vec![e(1, 0)]), false));
    assert_events(&s.pending, &[e(2, 0)]);
    assert_eq!(s.upstream_head, e(1, 0).seq_num);
    assert_eq!(s.local_head, e(2, 0).seq_num);
    assert_events(&new_events, &[]);
    assert_events(&confirmed, &[e(1, 0)]);
}

#[test]
fn should_confirm_pending_event_and_add_new_event() {
    let state = st(vec![e(1, 0)], SeqNum::ROOT, e(1, 0).seq_num);
    let (s, new_events, confirmed) =
        expect_advance(merge(&state, advance(vec![e(1, 0), e(1, 1)]), false));
    assert_events(&s.pending, &[]);
    assert_eq!(s.upstream_head, e(1, 1).seq_num);
    assert_eq!(s.local_head, e(1, 1).seq_num);
    assert_events(&new_events, &[e(1, 1)]);
    assert_events(&confirmed, &[e(1, 0)]);
}

#[test]
fn should_confirm_pending_event_and_add_multiple_new_events() {
    let state = st(vec![e(1, 1)], e(1, 0).seq_num, e(1, 1).seq_num);
    let (s, new_events, confirmed) = expect_advance(merge(
        &state,
        advance(vec![e(1, 1), e(1, 2), e(1, 3), e(2, 0), e(2, 1)]),
        false,
    ));
    assert_events(&s.pending, &[]);
    assert_eq!(s.upstream_head, e(2, 1).seq_num);
    assert_eq!(s.local_head, e(2, 1).seq_num);
    assert_events(&new_events, &[e(1, 2), e(1, 3), e(2, 0), e(2, 1)]);
    assert_events(&confirmed, &[e(1, 1)]);
}

#[test]
fn should_confirm_pending_global_event_while_keep_pending_client_events() {
    let state = st(vec![e(1, 0), e(1, 1)], SeqNum::ROOT, e(1, 1).seq_num);
    let (s, new_events, confirmed) = expect_advance(merge(&state, advance(vec![e(1, 0)]), false));
    assert_events(&s.pending, &[e(1, 1)]);
    assert_eq!(s.upstream_head, e(1, 0).seq_num);
    assert_eq!(s.local_head, e(1, 1).seq_num);
    assert_events(&new_events, &[]);
    assert_events(&confirmed, &[e(1, 0)]);
}

#[test]
fn should_ignore_client_events_incoming_is_subset_of_pending() {
    let state = st(vec![e(0, 1), e(1, 0)], SeqNum::ROOT, e(1, 0).seq_num);
    let (s, new_events, confirmed) = expect_advance(merge(&state, advance(vec![e(1, 0)]), true));
    assert_events(&s.pending, &[]);
    assert_eq!(s.upstream_head, e(1, 0).seq_num);
    assert_eq!(s.local_head, e(1, 0).seq_num);
    assert_events(&new_events, &[]);
    assert_events(&confirmed, &[e(0, 1), e(1, 0)]);
}

#[test]
fn should_ignore_client_events_incoming_is_subset_of_pending_case_2() {
    let state = st(
        vec![e(0, 1), e(1, 0), e(2, 0)],
        SeqNum::ROOT,
        e(1, 0).seq_num,
    );
    let (s, new_events, confirmed) = expect_advance(merge(&state, advance(vec![e(1, 0)]), true));
    assert_events(&s.pending, &[e(2, 0)]);
    assert_eq!(s.upstream_head, e(1, 0).seq_num);
    assert_eq!(s.local_head, e(2, 0).seq_num);
    assert_events(&new_events, &[]);
    assert_events(&confirmed, &[e(0, 1), e(1, 0)]);
}

#[test]
fn should_ignore_client_events_incoming_goes_beyond_pending() {
    let state = st(
        vec![e(0, 1), e(1, 0), e(1, 1)],
        SeqNum::ROOT,
        e(1, 1).seq_num,
    );
    let (s, new_events, confirmed) =
        expect_advance(merge(&state, advance(vec![e(1, 0), e(2, 0)]), true));
    assert_events(&s.pending, &[]);
    assert_eq!(s.upstream_head, e(2, 0).seq_num);
    assert_eq!(s.local_head, e(2, 0).seq_num);
    assert_events(&new_events, &[e(2, 0)]);
    assert_events(&confirmed, &[e(0, 1), e(1, 0), e(1, 1)]);
}

#[test]
fn should_die_if_incoming_event_is_le_local_head() {
    let state = st(vec![], e(2, 0).seq_num, e(2, 0).seq_num);
    assert!(try_merge(&state, advance(vec![e(1, 0)]), false).is_err());
}

#[test]
fn should_advance_not_rebase_when_pending_event_has_undefined_valued_key_dropped_by_json_wire_round_trip()
 {
    let local_args = json!({ "id": "abc" });
    let wire_args: Value =
        serde_json::from_str(&serde_json::to_string(&local_args).unwrap()).unwrap();
    let local_pending = Event {
        args: local_args,
        ..e(1, 0)
    };
    let from_upstream = Event {
        args: wire_args,
        ..e(1, 0)
    };
    let state = st(
        vec![local_pending.clone()],
        SeqNum::ROOT,
        local_pending.seq_num,
    );
    let (s, _, confirmed) = expect_advance(merge(&state, advance(vec![from_upstream]), false));
    assert_eq!(confirmed.len(), 1);
    assert_eq!(s.pending.len(), 0);
}

#[test]
fn should_rebase_single_client_event_to_end() {
    let state = st(vec![e(1, 0)], SeqNum::ROOT, e(1, 0).seq_num);
    let result = merge(&state, advance(vec![e(1, 1)]), false);
    let e1_0_e1_2 = rebase(&e(1, 0), e(1, 1).seq_num, 1);
    let (s, new_events, rollback) = expect_rebase(result);
    assert_events(&s.pending, std::slice::from_ref(&e1_0_e1_2));
    assert_eq!(s.upstream_head, e(1, 1).seq_num);
    assert_eq!(s.local_head, e1_0_e1_2.seq_num);
    assert_events(&rollback, &[e(1, 0)]);
    assert_events(&new_events, &[e(1, 1), e1_0_e1_2]);
}

#[test]
fn should_rebase_different_event_with_same_id() {
    let e2_0_b = make(SeqNum::new(1, 0, 0), e(1, 0).seq_num, "1_0_b", false);
    let state = st(vec![e2_0_b.clone()], SeqNum::ROOT, e2_0_b.seq_num);
    let result = merge(&state, advance(vec![e(2, 0)]), false);
    let e2_0_e3_0 = rebase(&e2_0_b, e(2, 0).seq_num, 1);
    let (s, new_events, rollback) = expect_rebase(result);
    assert_events(&s.pending, std::slice::from_ref(&e2_0_e3_0));
    assert_events(&new_events, &[e(2, 0), e2_0_e3_0.clone()]);
    assert_events(&rollback, &[e2_0_b]);
    assert_eq!(s.upstream_head, e(2, 0).seq_num);
    assert_eq!(s.local_head, e2_0_e3_0.seq_num);
}

#[test]
fn should_rebase_single_client_event_to_end_more_incoming_events() {
    let state = st(vec![e(1, 0)], SeqNum::ROOT, e(1, 0).seq_num);
    let result = merge(
        &state,
        advance(vec![e(1, 1), e(1, 2), e(1, 3), e(2, 0)]),
        false,
    );
    let e1_0_e3_0 = rebase(&e(1, 0), e(2, 0).seq_num, 1);
    let (s, _, _) = expect_rebase(result);
    assert_events(&s.pending, std::slice::from_ref(&e1_0_e3_0));
    assert_eq!(s.upstream_head, e(2, 0).seq_num);
    assert_eq!(s.local_head, e1_0_e3_0.seq_num);
}

#[test]
fn should_only_rebase_divergent_events_when_first_event_matches() {
    let state = st(vec![e(1, 0), e(1, 1)], SeqNum::ROOT, e(1, 0).seq_num);
    let result = merge(
        &state,
        advance(vec![e(1, 0), e(1, 2), e(1, 3), e(2, 0)]),
        false,
    );
    let e1_1_e2_1 = rebase(&e(1, 1), e(2, 0).seq_num, 1);
    let (s, new_events, rollback) = expect_rebase(result);
    assert_events(&s.pending, std::slice::from_ref(&e1_1_e2_1));
    assert_events(&rollback, &[e(1, 1)]);
    assert_events(&new_events, &[e(1, 2), e(1, 3), e(2, 0), e1_1_e2_1.clone()]);
    assert_eq!(s.upstream_head, e(2, 0).seq_num);
    assert_eq!(s.local_head, e1_1_e2_1.seq_num);
}

#[test]
fn should_rebase_all_client_events_when_incoming_chain_starts_differently() {
    let state = st(vec![e(1, 0), e(1, 1)], SeqNum::ROOT, e(1, 1).seq_num);
    let result = merge(
        &state,
        advance(vec![e(1, 1), e(1, 2), e(1, 3), e(2, 0)]),
        false,
    );
    let e1_0_e2_1 = rebase(&e(1, 0), e(2, 0).seq_num, 1);
    let e1_1_e2_2 = rebase(&e(1, 1), e1_0_e2_1.seq_num, 1);
    let (s, new_events, rollback) = expect_rebase(result);
    assert_events(&s.pending, &[e1_0_e2_1.clone(), e1_1_e2_2.clone()]);
    assert_events(
        &new_events,
        &[
            e(1, 1),
            e(1, 2),
            e(1, 3),
            e(2, 0),
            e1_0_e2_1,
            e1_1_e2_2.clone(),
        ],
    );
    assert_events(&rollback, &[e(1, 0), e(1, 1)]);
    assert_eq!(s.upstream_head, e(2, 0).seq_num);
    assert_eq!(s.local_head, e1_1_e2_2.seq_num);
}

#[test]
fn should_advance_with_new_events() {
    let state = st(vec![e(1, 0)], SeqNum::ROOT, e(1, 0).seq_num);
    let (s, new_events, confirmed) = expect_advance(merge(
        &state,
        Payload::LocalPush {
            new_events: vec![e(1, 1), e(1, 2), e(1, 3)],
        },
        false,
    ));
    assert_events(&s.pending, &[e(1, 0), e(1, 1), e(1, 2), e(1, 3)]);
    assert_eq!(s.upstream_head, SeqNum::ROOT);
    assert_eq!(s.local_head, e(1, 3).seq_num);
    assert_events(&new_events, &[e(1, 1), e(1, 2), e(1, 3)]);
    assert_events(&confirmed, &[]);
}

#[test]
fn keeps_pending_empty_when_pushing_only_client_only_events_that_are_being_ignored() {
    let state = st(vec![], SeqNum::ROOT, SeqNum::ROOT);
    let (s, new_events, _) = expect_advance(merge(
        &state,
        Payload::LocalPush {
            new_events: vec![e(0, 1)],
        },
        true,
    ));
    assert_events(&s.pending, &[]);
    assert_eq!(s.upstream_head, SeqNum::ROOT);
    assert_eq!(s.local_head, SeqNum::ROOT);
    assert_events(&new_events, &[e(0, 1)]);
}

#[test]
fn appends_only_upstream_bound_events_to_pending_when_ignoring_client_only_pushes() {
    let state = st(vec![], SeqNum::ROOT, SeqNum::ROOT);
    let (s, new_events, _) = expect_advance(merge(
        &state,
        Payload::LocalPush {
            new_events: vec![e(0, 1), e(1, 0)],
        },
        true,
    ));
    assert_events(&s.pending, &[e(1, 0)]);
    assert_eq!(s.upstream_head, SeqNum::ROOT);
    assert_eq!(s.local_head, e(1, 0).seq_num);
    assert_events(&new_events, &[e(0, 1), e(1, 0)]);
}

#[test]
fn should_reject_when_new_events_are_greater_than_pending_events() {
    let state = st(vec![e(1, 0), e(1, 1)], SeqNum::ROOT, e(1, 1).seq_num);
    match merge(
        &state,
        Payload::LocalPush {
            new_events: vec![e(1, 1), e(1, 2)],
        },
        false,
    ) {
        MergeResult::Reject {
            expected_minimum_id,
            ..
        } => assert_eq!(expected_minimum_id, e(1, 2).seq_num),
        other => panic!("expected reject, got {other:?}"),
    }
}

fn e(global: i64, client: i64) -> Event {
    let parent = match (global, client) {
        (0, 1) | (1, 0) => SeqNum::ROOT,
        (g, 0) => SeqNum::new(g - 1, 0, 0),
        (g, c) => SeqNum::new(g, c - 1, 0),
    };
    make(SeqNum::new(global, client, 0), parent, "a", client != 0)
}

fn make(seq_num: SeqNum, parent_seq_num: SeqNum, payload: &str, is_client_only: bool) -> Event {
    Event {
        name: "a".into(),
        args: json!({ "payload": payload, "isClientOnly": is_client_only }),
        seq_num,
        parent_seq_num,
        client_id: "static-local-id".into(),
        session_id: "static-session-id".into(),
    }
}

fn is_client_only(event: &Event) -> bool {
    event.args.get("isClientOnly") == Some(&Value::Bool(true))
}

fn rebase(event: &Event, parent: SeqNum, rebase_generation: i64) -> Event {
    event.rebase(parent, is_client_only(event), rebase_generation)
}

fn st(pending: Vec<Event>, upstream_head: SeqNum, local_head: SeqNum) -> SyncState {
    SyncState {
        pending,
        upstream_head,
        local_head,
    }
}

fn advance(new_events: Vec<Event>) -> Payload {
    Payload::UpstreamAdvance { new_events }
}

fn try_merge(
    state: &SyncState,
    payload: Payload,
    ignore: bool,
) -> Result<MergeResult, livestore_core::MergeError> {
    livestore_core::merge(state, &payload, is_client_only, is_equal_encoded, ignore)
}

fn merge(state: &SyncState, payload: Payload, ignore: bool) -> MergeResult {
    try_merge(state, payload, ignore).unwrap()
}

fn expect_advance(result: MergeResult) -> (SyncState, Vec<Event>, Vec<Event>) {
    match result {
        MergeResult::Advance {
            new_sync_state,
            new_events,
            confirmed_events,
            ..
        } => (new_sync_state, new_events, confirmed_events),
        other => panic!("expected advance, got {other:?}"),
    }
}

fn expect_rebase(result: MergeResult) -> (SyncState, Vec<Event>, Vec<Event>) {
    match result {
        MergeResult::Rebase {
            new_sync_state,
            new_events,
            rollback_events,
            ..
        } => (new_sync_state, new_events, rollback_events),
        other => panic!("expected rebase, got {other:?}"),
    }
}

fn assert_events(actual: &[Event], expected: &[Event]) {
    assert_eq!(actual.len(), expected.len());
    for (a, b) in actual.iter().zip(expected) {
        assert_eq!(
            (a.seq_num, a.parent_seq_num, &a.name, &a.args),
            (b.seq_num, b.parent_seq_num, &b.name, &b.args)
        );
    }
}
