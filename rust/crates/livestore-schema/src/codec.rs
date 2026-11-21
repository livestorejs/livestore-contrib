//! Effect `Schema` codecs that materializers need (`DateFromString`, `DateFromMillis`).

/// `Schema.DateFromString` decode + `Schema.DateFromMillis` encode: ISO string to epoch millis.
#[must_use]
pub fn date_from_iso_string(s: &str) -> Option<i64> {
    parse_iso_millis(s)
}

/// `Date.prototype.toISOString`.
#[must_use]
pub fn iso_string_from_millis(ms: i64) -> String {
    let (days, rem) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    let (y, m, d) = civil_from_days(days);
    let (h, mi, s, milli) = (
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000,
    );
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{milli:03}Z")
}

/// Parses `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM[:SS[.fff]](Z|±HH:MM)` to epoch millis.
fn parse_iso_millis(s: &str) -> Option<i64> {
    let num = |r: std::ops::Range<usize>| {
        s.get(r)
            .filter(|t| t.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|t| t.parse::<i64>().ok())
    };
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    if s.get(4..5)? != "-"
        || s.get(7..8)? != "-"
        || !(1..=12).contains(&mo)
        || !(1..=31).contains(&d)
    {
        return None;
    }
    let days = days_from_civil(y, mo, d);
    if s.len() == 10 {
        return Some(days * 86_400_000);
    }
    if s.get(10..11)? != "T" || s.get(13..14)? != ":" {
        return None;
    }
    let (h, mi) = (num(11..13)?, num(14..16)?);
    let mut rest = &s[16..];
    let (mut sec, mut ms) = (0, 0);
    if let Some(r) = rest.strip_prefix(':') {
        sec = r
            .get(0..2)
            .filter(|t| t.bytes().all(|b| b.is_ascii_digit()))?
            .parse()
            .ok()?;
        rest = &r[2..];
        if let Some(r) = rest.strip_prefix('.') {
            let digits = r.bytes().take_while(u8::is_ascii_digit).count();
            if digits == 0 {
                return None;
            }
            let frac = &r[..digits.min(3)];
            ms = frac.parse::<i64>().ok()? * 10i64.pow(3 - frac.len() as u32);
            rest = &r[digits..];
        }
    }
    let offset_min = match rest {
        "Z" => 0,
        _ if rest.len() == 6 && rest.as_bytes()[3] == b':' => {
            let sign = match &rest[0..1] {
                "+" => 1,
                "-" => -1,
                _ => return None,
            };
            sign * (rest[1..3].parse::<i64>().ok()? * 60 + rest[4..6].parse::<i64>().ok()?)
        }
        _ => return None,
    };
    if h > 23 || mi > 59 || sec > 59 {
        return None;
    }
    Some(((days * 24 + h) * 60 + mi - offset_min) * 60_000 + sec * 1000 + ms)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_iso_dates_like_date_parse() {
        assert_eq!(
            parse_iso_millis("2026-01-02T03:04:05.678Z"),
            Some(1_767_323_045_678)
        );
        assert_eq!(
            parse_iso_millis("2026-02-03T00:00:00.000Z"),
            Some(1_770_076_800_000)
        );
        assert_eq!(parse_iso_millis("1970-01-01"), Some(0));
        assert_eq!(parse_iso_millis("1970-01-01T01:00+01:00"), Some(0));
        assert_eq!(parse_iso_millis("nope"), None);
        assert_eq!(
            iso_string_from_millis(1_767_323_045_678),
            "2026-01-02T03:04:05.678Z"
        );
    }
}
