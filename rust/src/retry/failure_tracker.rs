//! Per-domain failure tracking (mirrors server hints.rs FailureTracker).
//!
//! Tracks `(domain, browser_type)` failure counts with a 10-minute TTL.
//! Used by [`BrowserSelector`](super::browser_selector::BrowserSelector) to
//! decide when to rotate browsers.
//!
//! Completely lock-free: uses [`DashMap`] for concurrent read/write access
//! with no `Mutex` anywhere.

use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use dashmap::DashMap;

/// Mirrors `hints.rs` FAILURE_TTL (10 minutes).
const FAILURE_TTL_MS: u64 = 10 * 60 * 1000;

/// Mirrors `hints.rs` ROTATE_AFTER_FAILURES.
pub const ROTATE_AFTER_FAILURES: u32 = 2;

// Failure-class codes, stored atomically so the record stays lock-free.
const CLASS_TRANSIENT: u8 = 0;
const CLASS_BLOCKED: u8 = 1;
const CLASS_OTHER: u8 = 2;

/// Map a failure-class string to its atomic code.
fn class_code(error_class: &str) -> u8 {
    match error_class {
        "blocked" => CLASS_BLOCKED,
        "transient" => CLASS_TRANSIENT,
        _ => CLASS_OTHER,
    }
}

/// A single failure record: count + last failure timestamp + last failure class.
#[derive(Debug)]
struct FailureRecord {
    /// Number of consecutive failures.
    count: AtomicU64,
    /// Timestamp (ms since UNIX epoch) of the last failure.
    last_failure: AtomicU64,
    /// Class code of the most recent failure (see `CLASS_*`). Used by
    /// `clear_class` to selectively reset failures on stealth escalation.
    error_class: AtomicU8,
}

impl FailureRecord {
    fn new(now_ms: u64, class: u8) -> Self {
        Self {
            count: AtomicU64::new(1),
            last_failure: AtomicU64::new(now_ms),
            error_class: AtomicU8::new(class),
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

    /// Record a failure for a domain + browser pair (defaults to the
    /// "transient" class). See [`record_failure_class`](Self::record_failure_class).
    pub fn record_failure(&self, domain: &str, browser: &str) {
        self.record_failure_class(domain, browser, "transient");
    }

    /// Record a failure tagged with its class ("blocked", "transient", ...) for
    /// selective clearing on stealth escalation.
    pub fn record_failure_class(&self, domain: &str, browser: &str, error_class: &str) {
        let key = make_key(domain, browser);
        let now = now_ms();
        let class = class_code(error_class);

        // Try to update an existing record first.
        if let Some(existing) = self.failures.get(&key) {
            existing.count.fetch_add(1, Ordering::Relaxed);
            existing.last_failure.store(now, Ordering::Relaxed);
            existing.error_class.store(class, Ordering::Relaxed);
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
                rec.error_class.store(class, Ordering::Relaxed);
            })
            .or_insert_with(|| FailureRecord::new(now, class));
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

    /// Clear all failure records for a domain (regardless of class).
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

    /// Clear only failures of a given class for a domain.
    ///
    /// Used on stealth escalation: `blocked` failures are cleared (a higher
    /// stealth tier can bypass the block), while `transient`/disconnect failures
    /// are retained (escalating stealth won't fix flaky infra, so we keep
    /// skipping a browser that keeps dropping on this domain).
    pub fn clear_class(&self, domain: &str, error_class: &str) {
        let prefix = format!("{domain}::");
        let class = class_code(error_class);
        // Collect keys to remove -- cannot remove while iterating DashMap.
        let keys_to_remove: Vec<String> = self
            .failures
            .iter()
            .filter(|entry| {
                entry.key().starts_with(&prefix)
                    && entry.value().error_class.load(Ordering::Relaxed) == class
            })
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

    #[test]
    fn clear_class_clears_only_matching_class() {
        let tracker = FailureTracker::new();
        tracker.record_failure_class("example.com", "chrome-h", "blocked");
        tracker.record_failure_class("example.com", "chrome-h", "blocked");
        tracker.record_failure_class("example.com", "firefox", "transient");
        tracker.record_failure_class("other.com", "chrome-h", "blocked");

        // stealth escalation: clear blocked, keep transient
        tracker.clear_class("example.com", "blocked");

        assert_eq!(tracker.failure_count("example.com", "chrome-h"), 0); // blocked cleared
        assert_eq!(tracker.failure_count("example.com", "firefox"), 1); // transient retained
        assert_eq!(tracker.failure_count("other.com", "chrome-h"), 1); // other domain untouched
    }

    #[test]
    fn clear_class_uses_most_recent_class() {
        let tracker = FailureTracker::new();
        tracker.record_failure_class("example.com", "chrome-h", "blocked");
        tracker.record_failure_class("example.com", "chrome-h", "transient"); // latest = transient
        tracker.clear_class("example.com", "blocked");
        assert_eq!(tracker.failure_count("example.com", "chrome-h"), 2); // retained
    }

    #[test]
    fn record_failure_defaults_to_transient() {
        let tracker = FailureTracker::new();
        tracker.record_failure("example.com", "chrome-h"); // default class
        tracker.clear_class("example.com", "blocked");
        assert_eq!(tracker.failure_count("example.com", "chrome-h"), 1); // not cleared
    }
}
