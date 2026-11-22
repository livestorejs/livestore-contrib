//! Compile-time ports of TS type-level tests: `tests/ui/fail` must not compile (with the pinned error),
//! `tests/ui/pass` must.

#[test]
fn ui() {
    let t = trybuild::TestCases::new();
    t.pass("tests/ui/pass/*.rs");
    t.compile_fail("tests/ui/fail/*.rs");
}
