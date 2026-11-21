//! `EventSequenceNumber.Client.Composite`.

use std::cmp::Ordering;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SeqNum {
    pub global: i64,
    pub client: i64,
    pub rebase_generation: i64,
}

impl SeqNum {
    pub const ROOT: SeqNum = SeqNum {
        global: 0,
        client: 0,
        rebase_generation: 0,
    };

    #[must_use]
    pub fn new(global: i64, client: i64, rebase_generation: i64) -> Self {
        Self {
            global,
            client,
            rebase_generation,
        }
    }

    /// Full ordering: global, then client, then rebaseGeneration.
    #[must_use]
    pub fn compare(&self, other: &Self) -> Ordering {
        (self.global, self.client, self.rebase_generation).cmp(&(
            other.global,
            other.client,
            other.rebase_generation,
        ))
    }

    /// Ignores rebaseGeneration, like the TS `isGreaterThan`.
    #[must_use]
    pub fn is_greater_than(&self, other: &Self) -> bool {
        (self.global, self.client) > (other.global, other.client)
    }

    /// Ignores rebaseGeneration, like the TS `isGreaterThanOrEqual`.
    #[must_use]
    pub fn is_greater_than_or_equal(&self, other: &Self) -> bool {
        (self.global, self.client) >= (other.global, other.client)
    }

    /// Returns `self` only when strictly greater (ignoring rebaseGeneration), otherwise `other`.
    #[must_use]
    pub fn max(self, other: Self) -> Self {
        if self.is_greater_than(&other) {
            self
        } else {
            other
        }
    }

    /// Returns `(seqNum, parentSeqNum)` for the event following `self`.
    #[must_use]
    pub fn next_pair(
        &self,
        is_client_only: bool,
        rebase_generation: Option<i64>,
    ) -> (SeqNum, SeqNum) {
        let generation = rebase_generation.unwrap_or(self.rebase_generation);
        if is_client_only {
            (SeqNum::new(self.global, self.client + 1, generation), *self)
        } else {
            (
                SeqNum::new(self.global + 1, 0, generation),
                SeqNum::new(self.global, 0, self.rebase_generation),
            )
        }
    }
}

impl fmt::Display for SeqNum {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "e{}", self.global)?;
        if self.client != 0 {
            write!(f, ".{}", self.client)?;
        }
        if self.rebase_generation > 0 {
            write!(f, "r{}", self.rebase_generation)?;
        }
        Ok(())
    }
}

/// Parses the `toString` form (`e3`, `e3.1`, `e3r2`, `e3.1r2`), like `EventSequenceNumber.Client.fromString`.
impl FromStr for SeqNum {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let rest = s
            .strip_prefix('e')
            .ok_or("Invalid event sequence number string: must start with \"e\"")?;
        let digits = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
        let (pos, generation) = match rest.rsplit_once('r') {
            Some((p, g)) if digits(g) => (p, g),
            _ => (rest, "0"),
        };
        let mut parts = pos.split('.');
        let (global, client) = (parts.next().unwrap_or(""), parts.next().unwrap_or("0"));
        if !digits(global) || !digits(client) {
            return Err("Invalid event sequence number string: invalid number format".into());
        }
        let n = |t: &str| {
            t.parse::<i64>().map_err(|_| {
                "Invalid event sequence number string: invalid number format".to_string()
            })
        };
        Ok(SeqNum::new(n(global)?, n(client)?, n(generation)?))
    }
}

#[cfg(test)]
mod tests {
    use super::SeqNum;

    #[test]
    fn display_and_parse_round_trip() {
        for s in ["e0", "e3", "e3.1", "e1r1", "e2.1r3"] {
            assert_eq!(s.parse::<SeqNum>().unwrap().to_string(), s);
        }
        assert!("x1".parse::<SeqNum>().is_err());
    }
}
