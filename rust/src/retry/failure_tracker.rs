//! Per-domain failure tracking (mirrors server hints.rs FailureTracker).
//!
//! Tracks `(domain, browser_type)` failure counts with a 10-minute TTL.
//! Used by [`BrowserSelector`](super::browser_selector::BrowserSelector) to
//! decide when to rotate browsers.
//!
//! Completely lock-free: uses [`DashMap`] for concurrent read/write access
//! with no `Mutex` anywhere.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use dashmap::DashMap;

/// Mirrors `hints.rs` FAILURE_TTL (10 minutes).
const FAILURE_TTL_MS: u64 = 10 * 60 * 1000;

/// Mirrors `hints.rs` ROTATE_AFTER_FAILURES.
pub const ROTATE_AFTER_FAILURES: u32 = 2;

/// A single failure record: count + last failure timestamp.
#[derive(Debug)]
struct FailureRecord {
    /// Number of consecutive failures.
    count: AtomicU64,
    /// Timestamp (ms since UNIX epoch) of the last failure.
    last_failure: AtomicU64,
}

impl FailureRecord {
    fn new(now_ms: u64) -> Self {
        Self {
            count: AtomicU64::new(1),
            last_failure: AtomicU64::new(now_ms),
        }
    }
}

/// Per-domain, per-browser failure tracker with 10-minute TTL.
///
/// All methods are `&self` (no `&mut self`), making this safe to share
/// across tasks via `Arc<FailureTracker>`.
#[derive(Debug, Default)]
pub struct FailureTracker {
    /// Key: `"{domain}::{browser}"` -> failure record.
    failures: DashMap<String, FailureRecord>,
}

impl FailureTracker {
    /// Create a new, empty failure tracker.
    pub fn new() -> Self {
        Self {
            failures: DashMap::new(),
        }
    }

    /// Record a failure for a domain + browser pair.
    pub fn record_failure(&self, domain: &str, browser: &str) {
        let key = make_key(domain, browser);
        let now = now_ms();

        // Try to update an existing record first.
        if let Some(existing) = self.failures.get(&key) {
            existing.count.fetch_add(1, Ordering::Relaxed);
            existing.last_failure.store(now, Ordering::Relaxed);
            return;
        }

        // Insert a new record. There is a benign race: another thread could
        // insert between the `get` above and the `entry` below. `or_insert_with`
        // handles that correctly -- the first writer wins and we just bump the
        // existing entry.
        self.failures
            .entry(key)
            .and_modify(|rec| {
                rec.count.fetch_add(1, Ordering::Relaxed);
                rec.last_failure.store(now, Ordering::Relaxed);
            })
            .or_insert_with(|| FailureRecord::new(now));
    }

    /// Record a success -- clears the failure counter for a domain + browser.
    pub fn record_success(&self, domain: &str, browser: &str) {
        self.failures.remove(&make_key(domain, browser));
    }

    /// Get failure count (0 if expired or not found).
    pub fn failure_count(&self, domain: &str, browser: &str) -> u32 {
        let key = make_key(domain, browser);
        let now = now_ms();

        if let Some(record) = self.failures.get(&key) {
            let last = record.last_failure.load(Ordering::Relaxed);
            if now.saturating_sub(last) > FAILURE_TTL_MS {
                // Expired -- drop the read guard, then remove.
                drop(record);
                self.failures.remove(&key);
                return 0;
            }
            record.count.load(Ordering::Relaxed) as u32
        } else {
            0
        }
    }

    /// Get total failures across all browsers for a domain (unexpired only).
    pub fn total_failure_count(&self, domain: &str) -> u32 {
        let prefix = format!("{domain}::");
        let now = now_ms();
        let mut total: u32 = 0;

        for entry in self.failures.iter() {
            if entry.key().starts_with(&prefix) {
                let last = entry.value().last_failure.load(Ordering::Relaxed);
                if now.saturating_sub(last) < FAILURE_TTL_MS {
                    total += entry.value().count.load(Ordering::Relaxed) as u32;
                }
            }
        }

        total
    }

    /// Clear all failure records for a domain (used on stealth escalation).
    pub fn clear(&self, domain: &str) {
        let prefix = format!("{domain}::");
        // Collect keys to remove -- cannot remove while iterating DashMap.
        let keys_to_remove: Vec<String> = self
            .failures
            .iter()
            .filter(|entry| entry.key().starts_with(&prefix))
            .map(|entry| entry.key().clone())
            .collect();

        for key in keys_to_remove {
            self.failures.remove(&key);
        }
    }

    /// Clean up expired entries across all domains.
    pub fn cleanup(&self) {
        let now = now_ms();
        let keys_to_remove: Vec<String> = self
            .failures
            .iter()
            .filter(|entry| {
                let last = entry.value().last_failure.load(Ordering::Relaxed);
                now.saturating_sub(last) > FAILURE_TTL_MS
            })
            .map(|entry| entry.key().clone())
            .collect();

        for key in keys_to_remove {
            self.failures.remove(&key);
        }
    }
}

/// Build the composite key `"{domain}::{browser}"`.
fn make_key(domain: &str, browser: &str) -> String {
    let mut key = String::with_capacity(domain.len() + 2 + browser.len());
    key.push_str(domain);
    key.push_str("::");
    key.push_str(browser);
    key
}

/// Current time in milliseconds since UNIX epoch.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_and_read_failure() {
        let tracker = FailureTracker::new();
        assert_eq!(tracker.failure_count("example.com", "chrome-h"), 0);

        tracker.record_failure("example.com", "chrome-h");
        assert_eq!(tracker.failure_count("example.com", "chrome-h"), 1);

        tracker.record_failure("example.com", "chrome-h");
        assert_eq!(tracker.failure_count("example.com", "chrome-h"), 2);
    }

    #[test]
    fn record_success_clears() {
        let tracker = FailureTracker::new();
        tracker.record_failure("example.com", "chrome-h");
        tracker.record_failure("example.com", "chrome-h");
        assert_eq!(tracker.failure_count("example.com", "chrome-h"), 2);

        tracker.record_success("example.com", "chrome-h");
        assert_eq!(tracker.failure_count("example.com", "chrome-h"), 0);
    }

    #[test]
    fn total_failure_count_across_browsers() {
        let tracker = FailureTracker::new();
        tracker.record_failure("example.com", "chrome-h");
        tracker.record_failure("example.com", "chrome-new");
        tracker.record_failure("example.com", "chrome-new");
        tracker.record_failure("other.com", "firefox");

        assert_eq!(tracker.total_failure_count("example.com"), 3);
        assert_eq!(tracker.total_failure_count("other.com"), 1);
        assert_eq!(tracker.total_failure_count("missing.com"), 0);
    }

    #[test]
    fn clear_domain_removes_all_browsers() {
        let tracker = FailureTracker::new();
        tracker.record_failure("example.com", "chrome-h");
        tracker.record_failure("example.com", "firefox");
        tracker.record_failure("other.com", "chrome-h");

        tracker.clear("example.com");

        assert_eq!(tracker.failure_count("example.com", "chrome-h"), 0);
        assert_eq!(tracker.failure_count("example.com", "firefox"), 0);
        // other.com untouched
        assert_eq!(tracker.failure_count("other.com", "chrome-h"), 1);
    }

    #[test]
    fn cleanup_removes_nothing_when_fresh() {
        let tracker = FailureTracker::new();
        tracker.record_failure("example.com", "chrome-h");
        tracker.cleanup();
        assert_eq!(tracker.failure_count("example.com", "chrome-h"), 1);
    }
}
