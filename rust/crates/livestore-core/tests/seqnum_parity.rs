//! Port of `schema/EventSequenceNumber.test.ts`.

use livestore_core::SeqNum;

#[test]
fn next_pair_no_rebase() {
    let e_0_0 = SeqNum::new(0, 0, 0);
    assert_eq!(e_0_0.next_pair(false, None).0, SeqNum::new(1, 0, 0));
    assert_eq!(e_0_0.next_pair(true, None).0, SeqNum::new(0, 1, 0));
}

#[test]
fn next_pair_rebase() {
    let e_0_0 = SeqNum::new(0, 0, 0);
    assert_eq!(e_0_0.next_pair(false, Some(1)).0, SeqNum::new(1, 0, 1));
    assert_eq!(e_0_0.next_pair(true, Some(1)).0, SeqNum::new(0, 1, 1));
    assert_eq!(
        SeqNum::new(0, 0, 2).next_pair(false, None).0,
        SeqNum::new(1, 0, 2)
    );
}

#[test]
fn to_string() {
    assert_eq!(SeqNum::new(0, 0, 0).to_string(), "e0");
    assert_eq!(SeqNum::new(0, 0, 1).to_string(), "e0r1");
    assert_eq!(SeqNum::new(0, 1, 0).to_string(), "e0.1");
    assert_eq!(SeqNum::new(0, 1, 1).to_string(), "e0.1r1");
    assert_eq!(SeqNum::new(5, 3, 2).to_string(), "e5.3r2");
}

#[test]
fn from_string() {
    assert_eq!("e0".parse::<SeqNum>().unwrap(), SeqNum::new(0, 0, 0));
    assert_eq!("e0r1".parse::<SeqNum>().unwrap(), SeqNum::new(0, 0, 1));
    assert_eq!("e0.1".parse::<SeqNum>().unwrap(), SeqNum::new(0, 1, 0));
    assert_eq!("e0.1r1".parse::<SeqNum>().unwrap(), SeqNum::new(0, 1, 1));
    assert_eq!("e5.3r2".parse::<SeqNum>().unwrap(), SeqNum::new(5, 3, 2));

    assert_eq!(
        "0".parse::<SeqNum>().unwrap_err(),
        "Invalid event sequence number string: must start with \"e\""
    );
    for s in ["eabc", "e0.abc", "e0rabc"] {
        assert_eq!(
            s.parse::<SeqNum>().unwrap_err(),
            "Invalid event sequence number string: invalid number format"
        );
    }
}

#[test]
fn to_string_from_string_roundtrip() {
    for (g, c, r) in [
        (0, 0, 0),
        (0, 0, 1),
        (0, 1, 0),
        (0, 1, 1),
        (5, 3, 2),
        (100, 50, 10),
    ] {
        let original = SeqNum::new(g, c, r);
        assert_eq!(original.to_string().parse::<SeqNum>().unwrap(), original);
    }
}

#[test]
fn compare() {
    let e_0_0_r0 = SeqNum::new(0, 0, 0);
    let e_0_0_r1 = SeqNum::new(0, 0, 1);
    let e_0_1_r0 = SeqNum::new(0, 1, 0);
    let e_0_1_r1 = SeqNum::new(0, 1, 1);
    let e_1_0_r0 = SeqNum::new(1, 0, 0);
    let e_1_1_r0 = SeqNum::new(1, 1, 0);

    assert!(e_0_0_r0.compare(&e_1_0_r0).is_lt());
    assert!(e_1_0_r0.compare(&e_0_0_r0).is_gt());
    assert!(e_0_1_r1.compare(&e_1_0_r0).is_lt());

    assert!(e_0_0_r0.compare(&e_0_1_r0).is_lt());
    assert!(e_0_1_r0.compare(&e_0_0_r0).is_gt());
    assert!(e_0_0_r1.compare(&e_0_1_r0).is_lt());

    assert!(e_0_0_r0.compare(&e_0_0_r1).is_lt());
    assert!(e_0_0_r1.compare(&e_0_0_r0).is_gt());

    assert!(e_0_0_r0.compare(&e_0_0_r0).is_eq());
    assert!(e_1_1_r0.compare(&e_1_1_r0).is_eq());
}
