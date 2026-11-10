//! Sibling order that survives syncing. The outline's own order is the order of
//! `tasks.json` (pre-order), which can't be merged between devices: two of them
//! inserting under one parent would each renumber the list. So every row also
//! carries a `rank`, a string that sorts (plain byte order) among its siblings,
//! and a new rank can always be made between two others without touching them.
//!
//! Ranks use the digits `0-9A-Za-z` (ascending in ASCII) and never end in `0`.
//! Locally the list order stays the truth: `repair` runs on every save and gives
//! new or moved rows a rank that fits where they now sit, changing as few rows
//! as possible. After a pull, siblings are sorted by rank instead.

use crate::store::Item;
use std::collections::HashMap;

const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE: u64 = 62;
/// Appends and prepends step through a fixed-width head so long runs of them
/// don't make ranks grow: 6 digits, 62^3 apart, room for ~238k appends.
const HEAD: usize = 6;
const STEP: u64 = BASE * BASE * BASE;
const HEAD_MAX: u64 = BASE.pow(HEAD as u32);

fn val(c: u8) -> u64 {
    DIGITS.iter().position(|d| *d == c).unwrap_or(0) as u64
}

fn valid(rank: &str) -> bool {
    !rank.is_empty() && rank.len() <= 200 && !rank.ends_with('0') && rank.bytes().all(|c| DIGITS.contains(&c))
}

fn head(rank: &str) -> u64 {
    let b = rank.as_bytes();
    (0..HEAD).fold(0, |n, i| n * BASE + b.get(i).map_or(0, |c| val(*c)))
}

fn encode(mut n: u64) -> String {
    let mut out = [b'0'; HEAD];
    for slot in out.iter_mut().rev() {
        *slot = DIGITS[(n % BASE) as usize];
        n /= BASE;
    }
    String::from_utf8_lossy(&out).trim_end_matches('0').to_string()
}

/// A string strictly between `a` and `b` (`a < b`; empty `a` is the lower
/// bound, `None` for `b` the upper). Neither may end in `0`.
fn midpoint(a: &[u8], b: Option<&[u8]>) -> Vec<u8> {
    if let Some(b) = b {
        // Shared prefix (with `a` padded by zeros) carries over unchanged.
        let mut n = 0;
        while n < b.len() && a.get(n).copied().unwrap_or(b'0') == b[n] {
            n += 1;
        }
        if n > 0 {
            let mut out = b[..n].to_vec();
            out.extend(midpoint(a.get(n..).unwrap_or(&[]), Some(&b[n..])));
            return out;
        }
    }
    let da = a.first().map_or(0, |c| val(*c));
    let db = b.and_then(|b| b.first()).map_or(BASE, |c| val(*c));
    if db - da > 1 {
        return vec![DIGITS[((da + db) / 2) as usize]];
    }
    // Adjacent digits: either `b`'s first digit alone fits, or go one deeper after `a`'s.
    match b {
        Some(b) if b.len() > 1 => b[..1].to_vec(),
        _ => {
            let mut out = vec![DIGITS[da as usize]];
            out.extend(midpoint(a.get(1..).unwrap_or(&[]), None));
            out
        }
    }
}

/// A rank between two neighbours; `None` means no neighbour on that side.
pub fn between(a: Option<&str>, b: Option<&str>) -> String {
    match (a, b) {
        (None, None) => encode(HEAD_MAX / 2),
        (Some(a), None) => {
            let n = head(a) + STEP;
            if n < HEAD_MAX {
                encode(n)
            } else {
                String::from_utf8_lossy(&midpoint(a.as_bytes(), None)).into_owned()
            }
        }
        (None, Some(b)) => {
            let n = head(b);
            if n > STEP {
                encode(n - STEP)
            } else {
                String::from_utf8_lossy(&midpoint(&[], Some(b.as_bytes()))).into_owned()
            }
        }
        (Some(a), Some(b)) => String::from_utf8_lossy(&midpoint(a.as_bytes(), Some(b.as_bytes()))).into_owned(),
    }
}

/// Indices of a longest strictly increasing run of valid ranks: the rows that keep theirs.
fn keepers(ranks: &[&str]) -> Vec<usize> {
    // Patience sorting; `tails[k]` is the index ending the best run of length k+1.
    let mut tails: Vec<usize> = Vec::new();
    let mut prev: Vec<Option<usize>> = vec![None; ranks.len()];
    for (i, r) in ranks.iter().enumerate() {
        if !valid(r) {
            continue;
        }
        let pos = tails.partition_point(|&t| ranks[t] < *r);
        prev[i] = if pos > 0 { Some(tails[pos - 1]) } else { None };
        if pos == tails.len() {
            tails.push(i);
        } else {
            tails[pos] = i;
        }
    }
    let mut out = Vec::new();
    let mut at = tails.last().copied();
    while let Some(i) = at {
        out.push(i);
        at = prev[i];
    }
    out.reverse();
    out
}

/// Fill `slots` with increasing ranks strictly between `lo` and `hi`.
fn fill(lo: Option<&str>, hi: Option<&str>, slots: &mut [String]) {
    if slots.is_empty() {
        return;
    }
    if hi.is_none() {
        // Open-ended: step forward from the left.
        let mut last = lo.map(str::to_string);
        for s in slots.iter_mut() {
            *s = between(last.as_deref(), None);
            last = Some(s.clone());
        }
        return;
    }
    // Bounded: halve, so a run of n new rows costs log(n) extra digits, not n.
    let mid = slots.len() / 2;
    let m = between(lo, hi);
    let (left, rest) = slots.split_at_mut(mid);
    fill(lo, Some(&m), left);
    fill(Some(&m), hi, &mut rest[1..]);
    rest[0] = m;
}

/// Make every sibling group's ranks strictly increasing in list order, giving
/// new ranks only to rows that have none or sit out of order. Returns whether
/// anything changed.
pub fn repair(items: &mut [Item]) -> bool {
    let mut groups: HashMap<Option<u64>, Vec<usize>> = HashMap::new();
    for (i, it) in items.iter().enumerate() {
        groups.entry(it.parent).or_default().push(i);
    }
    let mut changed = false;
    for idxs in groups.values() {
        let ranks: Vec<String> = idxs.iter().map(|&i| items[i].rank.clone()).collect();
        let keep = keepers(&ranks.iter().map(String::as_str).collect::<Vec<_>>());
        if keep.len() == idxs.len() {
            continue;
        }
        changed = true;
        // Walk the gaps before, between and after the keepers.
        let mut start = 0;
        for k in 0..=keep.len() {
            let end = keep.get(k).copied().unwrap_or(idxs.len());
            let lo = if k == 0 { None } else { Some(ranks[keep[k - 1]].clone()) };
            let hi = keep.get(k).map(|&j| ranks[j].clone());
            let mut slots = vec![String::new(); end - start];
            fill(lo.as_deref(), hi.as_deref(), &mut slots);
            for (n, s) in slots.into_iter().enumerate() {
                items[idxs[start + n]].rank = s;
            }
            start = end + 1;
        }
    }
    changed
}

/// Order siblings by rank (ties by id, so every device agrees). The caller
/// re-establishes pre-order with `normalize` afterwards.
pub fn sort_siblings(items: &mut [Item]) {
    items.sort_by(|a, b| a.rank.cmp(&b.rank).then(a.id.cmp(&b.id)));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: u64, parent: Option<u64>, rank: &str) -> Item {
        Item { id, text: String::new(), kind: "note".into(), done: false, parent, created_at: 0, done_at: None, schedule: None, rank: rank.into() }
    }

    fn ranks(items: &[Item]) -> Vec<String> {
        items.iter().map(|i| i.rank.clone()).collect()
    }

    fn increasing(v: &[String]) -> bool {
        v.windows(2).all(|w| w[0] < w[1]) && v.iter().all(|r| valid(r))
    }

    #[test]
    fn between_is_strictly_between() {
        let cases = [(None, None), (Some("V"), None), (None, Some("V")), (Some("V"), Some("W")), (Some("V"), Some("V1")), (Some("Vz"), Some("W")), (None, Some("1")), (None, Some("01")), (Some("zzzzzz"), None), (Some("zzzzzzz"), None)];
        for (a, b) in cases {
            let m = between(a, b);
            assert!(valid(&m), "{a:?} {b:?} -> {m}");
            if let Some(a) = a {
                assert!(a < m.as_str(), "{a} < {m}");
            }
            if let Some(b) = b {
                assert!(m.as_str() < b, "{m} < {b}");
            }
        }
    }

    #[test]
    fn repeated_inserts_at_one_spot_stay_ordered() {
        // Always insert right after the first row: the worst case for growth.
        let mut a = between(None, None);
        let b = between(Some(&a), None);
        for _ in 0..200 {
            let m = between(Some(&a), Some(&b));
            assert!(a < m && m < b && valid(&m));
            a = m;
        }
        // And always at the very front.
        let mut first = between(None, None);
        for _ in 0..500 {
            let m = between(None, Some(&first));
            assert!(m < first && valid(&m));
            first = m;
        }
    }

    #[test]
    fn appends_do_not_grow() {
        let mut last = between(None, None);
        for _ in 0..5000 {
            let next = between(Some(&last), None);
            assert!(last < next);
            last = next;
        }
        assert!(last.len() <= HEAD, "{last}");
    }

    #[test]
    fn repair_assigns_fresh_lists_and_is_stable() {
        let mut items: Vec<Item> = (1..=50).map(|i| item(i, None, "")).collect();
        items.push(item(100, Some(1), ""));
        items.push(item(101, Some(1), ""));
        assert!(repair(&mut items));
        assert!(increasing(&ranks(&items[..50])));
        assert!(items[50].rank < items[51].rank);
        let before = ranks(&items);
        assert!(!repair(&mut items));
        assert_eq!(before, ranks(&items));
    }

    #[test]
    fn repair_touches_only_moved_and_new_rows() {
        let mut items: Vec<Item> = (1..=6).map(|i| item(i, None, "")).collect();
        repair(&mut items);
        let orig = ranks(&items);
        // Move the last row to the front and insert a new one in the middle.
        let moved = items.pop().unwrap();
        items.insert(0, moved);
        items.insert(3, item(99, None, ""));
        assert!(repair(&mut items));
        assert!(increasing(&ranks(&items)));
        let kept: Vec<String> = items.iter().filter(|i| i.id <= 5).map(|i| i.rank.clone()).collect();
        assert_eq!(kept, orig[..5].to_vec(), "rows that stayed keep their ranks");
        // A run of new rows between two existing ones stays short.
        let mut many = vec![item(1, None, &orig[0]), item(2, None, &orig[1])];
        for i in 0..100 {
            many.insert(1, item(1000 + i, None, ""));
        }
        repair(&mut many);
        assert!(increasing(&ranks(&many)));
        assert!(many.iter().all(|i| i.rank.len() <= 12), "{:?}", many.iter().map(|i| i.rank.len()).max());
    }

    #[test]
    fn repair_fixes_duplicates_and_garbage() {
        let mut items = vec![item(1, None, "V"), item(2, None, "V"), item(3, None, "not a rank!"), item(4, None, "V0"), item(5, None, "W")];
        repair(&mut items);
        assert!(increasing(&ranks(&items)));
    }
}
