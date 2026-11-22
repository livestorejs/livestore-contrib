//! Port of `tests/sync-provider/src/providers/registry.test.ts`.

mod common;

use common::providers::*;

#[test]
fn runs_every_provider_when_unpinned() {
    assert_eq!(selected_provider_keys_for(None).unwrap(), provider_keys());
}

#[test]
fn narrows_to_the_pinned_provider() {
    assert_eq!(
        selected_provider_keys_for(Some("cf-ws-do")).unwrap(),
        ["cf-ws-do"]
    );
    assert!(is_provider_selected_for(Some("cf-ws-do"), "cf-ws-do"));
    assert!(!is_provider_selected_for(Some("cf-ws-do"), "cf-http-do"));
}

#[test]
fn throws_on_an_unknown_provider_instead_of_selecting_nothing() {
    let err = selected_provider_keys_for(Some("cf-typo")).unwrap_err();
    assert!(err.contains("Unknown TEST_SYNC_PROVIDER"), "{err}");
}
