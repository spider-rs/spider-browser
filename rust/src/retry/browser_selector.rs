//! Browser selection and rotation logic.
//!
//! Mirrors the server's `hints.rs` browser rotation:
//! 1. Try the current browser until [`ROTATE_AFTER_FAILURES`] consecutive failures.
//! 2. Move to the next browser in [`BROWSER_ROTATION`] order.
//! 3. Skip browsers that have also exceeded the failure threshold.

use super::failure_tracker::{FailureTracker, ROTATE_AFTER_FAILURES};

/// Primary browser rotation -- most stable Chrome backends.
///
/// `chrome-h` (ChromeXvfb) is the most reliable (99%), followed by
/// `chrome-new` (92%). Shared chrome is excluded -- only 35-65% reliable.
pub const PRIMARY_ROTATION: &[&str] = &["chrome-h", "chrome-new"];

/// Extended browser rotation -- non-Chrome engines tried at max stealth only.
pub const EXTENDED_ROTATION: &[&str] = &["firefox", "lightpanda", "servo"];

/// Full browser rotation order for retry/failover: primary then extended.
pub const BROWSER_ROTATION: &[&str] = &[
    "chrome-h",
    "chrome-new",
    "firefox",
    "lightpanda",
    "servo",
];

/// Picks the next browser in rotation based on per-domain failure history.
///
/// Follows the server's `hints.rs` logic:
/// 1. Try current browser until `ROTATE_AFTER_FAILURES` consecutive failures.
/// 2. Then move to the next browser in `BROWSER_ROTATION` order.
/// 3. Skip browsers that have also exceeded the failure threshold.
pub struct BrowserSelector {
    tracker: FailureTracker,
}

impl BrowserSelector {
    /// Create a new selector backed by the given failure tracker.
    pub fn new(tracker: FailureTracker) -> Self {
        Self { tracker }
    }

    /// Borrow the underlying failure tracker.
    pub fn failure_tracker(&self) -> &FailureTracker {
        &self.tracker
    }

    /// Check if the current browser should be rotated for a domain.
    ///
    /// Returns `true` when the failure count for `(domain, current_browser)`
    /// meets or exceeds [`ROTATE_AFTER_FAILURES`].
    pub fn should_rotate(&self, domain: &str, current_browser: &str) -> bool {
        self.tracker.failure_count(domain, current_browser) >= ROTATE_AFTER_FAILURES
    }

    /// Pick the next browser to try after `current_browser` has failed.
    ///
    /// Walks [`BROWSER_ROTATION`] starting from the position after
    /// `current_browser`, wrapping around, and returns the first candidate
    /// that has not exceeded the failure threshold for `domain`.
    ///
    /// Returns `None` if every browser in the rotation has been exhausted.
    pub fn next_browser(&self, domain: &str, current_browser: &str) -> Option<&'static str> {
        let current_idx = BROWSER_ROTATION
            .iter()
            .position(|&b| b == current_browser)
            .unwrap_or(0);

        for offset in 1..BROWSER_ROTATION.len() {
            let idx = (current_idx + offset) % BROWSER_ROTATION.len();
            let candidate = BROWSER_ROTATION[idx];
            if self.tracker.failure_count(domain, candidate) < ROTATE_AFTER_FAILURES {
                return Some(candidate);
            }
        }

        None
    }

    /// Choose the best browser for a domain (mirrors `hints.rs` `choose_browser_for_domain`).
    ///
    /// Returns the first browser in [`BROWSER_ROTATION`] that has not
    /// exceeded the failure threshold. Falls back to `fallback` if every
    /// browser is exhausted.
    pub fn choose_browser<'a>(&self, domain: &str, fallback: &'a str) -> &'a str
    where
        'static: 'a,
    {
        for &browser in BROWSER_ROTATION {
            if self.tracker.failure_count(domain, browser) < ROTATE_AFTER_FAILURES {
                return browser;
            }
        }
        fallback
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_selector() -> BrowserSelector {
        BrowserSelector::new(FailureTracker::new())
    }

    #[test]
    fn rotation_constants_are_consistent() {
        // BROWSER_ROTATION should be PRIMARY + EXTENDED in order.
        let mut expected: Vec<&str> = PRIMARY_ROTATION.to_vec();
        expected.extend_from_slice(EXTENDED_ROTATION);
        assert_eq!(BROWSER_ROTATION, expected.as_slice());
    }

    #[test]
    fn should_rotate_after_threshold() {
        let sel = make_selector();
        assert!(!sel.should_rotate("example.com", "chrome-h"));

        sel.failure_tracker().record_failure("example.com", "chrome-h");
        assert!(!sel.should_rotate("example.com", "chrome-h"));

        sel.failure_tracker().record_failure("example.com", "chrome-h");
        assert!(sel.should_rotate("example.com", "chrome-h"));
    }

    #[test]
    fn next_browser_skips_exhausted() {
        let sel = make_selector();

        // Exhaust chrome-h
        sel.failure_tracker().record_failure("d.com", "chrome-h");
        sel.failure_tracker().record_failure("d.com", "chrome-h");

        // Next after chrome-h should skip chrome-h, return chrome-new
        assert_eq!(sel.next_browser("d.com", "chrome-h"), Some("chrome-new"));

        // Exhaust chrome-new too
        sel.failure_tracker().record_failure("d.com", "chrome-new");
        sel.failure_tracker().record_failure("d.com", "chrome-new");

        assert_eq!(sel.next_browser("d.com", "chrome-h"), Some("firefox"));
    }

    #[test]
    fn next_browser_returns_none_when_all_exhausted() {
        let sel = make_selector();
        for &browser in BROWSER_ROTATION {
            sel.failure_tracker().record_failure("d.com", browser);
            sel.failure_tracker().record_failure("d.com", browser);
        }
        assert_eq!(sel.next_browser("d.com", "chrome-h"), None);
    }

    #[test]
    fn choose_browser_picks_first_available() {
        let sel = make_selector();

        // No failures -- picks first in rotation
        assert_eq!(sel.choose_browser("d.com", "fallback"), "chrome-h");

        // Exhaust chrome-h
        sel.failure_tracker().record_failure("d.com", "chrome-h");
        sel.failure_tracker().record_failure("d.com", "chrome-h");
        assert_eq!(sel.choose_browser("d.com", "fallback"), "chrome-new");
    }

    #[test]
    fn choose_browser_falls_back_when_all_exhausted() {
        let sel = make_selector();
        for &browser in BROWSER_ROTATION {
            sel.failure_tracker().record_failure("d.com", browser);
            sel.failure_tracker().record_failure("d.com", browser);
        }
        assert_eq!(sel.choose_browser("d.com", "fallback"), "fallback");
    }

    #[test]
    fn next_browser_wraps_around() {
        let sel = make_selector();
        // Starting from the last browser, should wrap to the first
        let last = *BROWSER_ROTATION.last().unwrap();
        assert_eq!(sel.next_browser("d.com", last), Some("chrome-h"));
    }
}
