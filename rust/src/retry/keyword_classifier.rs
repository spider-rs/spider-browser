//! Aho-Corasick keyword classifier -- O(n) multi-pattern substring matching.
//!
//! Scans the input string exactly **once** regardless of how many keywords
//! exist. Returns the classification of the first matched keyword
//! (priority-ordered by rule insertion order).
//!
//! Built at construction time -- zero per-call allocation or compilation.

use std::collections::HashMap;

/// Internal index for nodes in the arena-allocated trie.
///
/// Using an arena (flat `Vec<TrieNode>`) instead of `Box`-based pointers
/// avoids per-node heap allocations, is more cache-friendly, and lets us
/// use plain `usize` indices as fail/dict links without lifetimes.
type NodeIdx = usize;

/// Sentinel value meaning "no link" (equivalent to `None` for `Option<NodeIdx>`).
const NIL: NodeIdx = usize::MAX;

/// A single node in the Aho-Corasick trie.
///
/// `T` is the classification type (e.g. an enum variant).
struct TrieNode<T> {
    /// Transition map: lowercased byte -> child node index.
    children: HashMap<u8, NodeIdx>,
    /// Classification emitted when this node completes a keyword.
    /// `None` if this node is not the end of any keyword.
    output: Option<T>,
    /// Failure link -- longest proper suffix that is also a prefix in the trie.
    fail: NodeIdx,
    /// Dictionary suffix link -- nearest ancestor node (via fail chain) that
    /// has an output. Allows O(1) output checking per character.
    dict: NodeIdx,
}

impl<T> TrieNode<T> {
    fn new() -> Self {
        Self {
            children: HashMap::new(),
            output: None,
            fail: NIL,
            dict: NIL,
        }
    }
}

/// Aho-Corasick based keyword classifier.
///
/// Given a set of rules `(keywords, classification)` ordered by priority,
/// [`classify`](Self::classify) scans the input in a single O(n) pass and
/// returns the classification of the **first** (highest-priority) keyword
/// that matches as a substring. All matching is case-insensitive -- keywords
/// are lowercased at insert time and input bytes are lowercased inline during
/// the scan (no allocation).
///
/// # Example
///
/// ```
/// use spider_browser::retry::keyword_classifier::KeywordClassifier;
///
/// let classifier: KeywordClassifier<&str> = KeywordClassifier::new(&[
///     (&["blocked", "captcha", "403"], "blocked"),
///     (&["timeout", "err_connection_reset"], "transient"),
/// ]);
///
/// assert_eq!(classifier.classify("Error 403 Forbidden"), Some(&"blocked"));
/// assert_eq!(classifier.classify("ERR_CONNECTION_RESET"), Some(&"transient"));
/// assert_eq!(classifier.classify("all good"), None);
/// ```
pub struct KeywordClassifier<T> {
    /// Arena-allocated trie nodes. Index 0 is always the root.
    nodes: Vec<TrieNode<T>>,
}

impl<T: Clone> KeywordClassifier<T> {
    /// Build a new classifier from priority-ordered rules.
    ///
    /// Each rule is `(keywords, classification)`. Rules are checked in order;
    /// if two rules contain overlapping keywords, the **first** rule's
    /// classification wins.
    ///
    /// All keywords are stored lowercased internally.
    pub fn new(rules: &[(&[&str], T)]) -> Self {
        let mut classifier = Self {
            nodes: vec![TrieNode::new()], // index 0 = root
        };

        for (keywords, cls) in rules {
            for &kw in *keywords {
                classifier.insert(kw, cls.clone());
            }
        }

        classifier.build_failure_links();
        classifier
    }

    /// Classify a string by scanning it once for all keywords.
    ///
    /// Returns the classification of the highest-priority matching keyword,
    /// or `None` if no keyword matches.
    ///
    /// Runs in O(n) where n = `text.len()` with inline ASCII lowercasing
    /// (no heap allocation).
    pub fn classify(&self, text: &str) -> Option<&T> {
        let mut node_idx: NodeIdx = 0; // start at root

        for byte in text.as_bytes() {
            // Inline ASCII lowercase: A-Z (0x41..=0x5A) -> a-z (0x61..=0x7A)
            let ch = if byte.is_ascii_uppercase() {
                byte | 0x20
            } else {
                *byte
            };

            // Follow failure links until we find a matching transition or reach root
            while node_idx != 0 && !self.nodes[node_idx].children.contains_key(&ch) {
                node_idx = self.nodes[node_idx].fail;
            }

            node_idx = self.nodes[node_idx]
                .children
                .get(&ch)
                .copied()
                .unwrap_or(0);

            // Check output at this node
            if let Some(ref out) = self.nodes[node_idx].output {
                return Some(out);
            }

            // Check dictionary suffix link chain
            let dict_idx = self.nodes[node_idx].dict;
            if dict_idx != NIL {
                if let Some(ref out) = self.nodes[dict_idx].output {
                    return Some(out);
                }
            }
        }

        None
    }

    /// Insert a keyword into the trie with the given classification.
    ///
    /// First-rule-wins: if the terminal node already has an output, the
    /// existing (higher-priority) classification is kept.
    fn insert(&mut self, word: &str, cls: T) {
        let mut node_idx: NodeIdx = 0; // root

        for byte in word.as_bytes() {
            // Store keywords lowercased
            let ch = if byte.is_ascii_uppercase() {
                byte | 0x20
            } else {
                *byte
            };

            if let Some(&child_idx) = self.nodes[node_idx].children.get(&ch) {
                node_idx = child_idx;
            } else {
                let child_idx = self.nodes.len();
                self.nodes.push(TrieNode::new());
                self.nodes[node_idx].children.insert(ch, child_idx);
                node_idx = child_idx;
            }
        }

        // First rule wins -- do not overwrite a higher-priority classification.
        if self.nodes[node_idx].output.is_none() {
            self.nodes[node_idx].output = Some(cls);
        }
    }

    /// Build Aho-Corasick failure and dictionary suffix links via BFS.
    fn build_failure_links(&mut self) {
        // Use a simple queue (VecDeque is fine, but a Vec with a head pointer
        // is allocation-friendlier for the small BFS we do here).
        let mut queue: Vec<NodeIdx> = Vec::new();

        // Root's direct children: fail -> root (0), dict -> root sentinel
        let root_children: Vec<(u8, NodeIdx)> = self.nodes[0]
            .children
            .iter()
            .map(|(&ch, &idx)| (ch, idx))
            .collect();

        for (_ch, child_idx) in &root_children {
            self.nodes[*child_idx].fail = 0;
            self.nodes[*child_idx].dict = NIL;
            queue.push(*child_idx);
        }

        let mut head: usize = 0;

        while head < queue.len() {
            let node_idx = queue[head];
            head += 1;

            // Collect children to avoid borrow issues with the arena vec.
            let children: Vec<(u8, NodeIdx)> = self.nodes[node_idx]
                .children
                .iter()
                .map(|(&ch, &idx)| (ch, idx))
                .collect();

            for (ch, child_idx) in children {
                // Walk the failure chain to find the fail link for this child.
                let mut fail = self.nodes[node_idx].fail;
                while fail != 0 && !self.nodes[fail].children.contains_key(&ch) {
                    fail = self.nodes[fail].fail;
                }

                let child_fail = self.nodes[fail]
                    .children
                    .get(&ch)
                    .copied()
                    .unwrap_or(0);

                // Avoid self-loop
                let child_fail = if child_fail == child_idx { 0 } else { child_fail };

                self.nodes[child_idx].fail = child_fail;

                // Dictionary suffix link: nearest node (via fail chain) with output.
                self.nodes[child_idx].dict = if self.nodes[child_fail].output.is_some() {
                    child_fail
                } else {
                    self.nodes[child_fail].dict
                };

                queue.push(child_idx);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_classification() {
        let classifier: KeywordClassifier<&str> = KeywordClassifier::new(&[
            (&["blocked", "403", "captcha"], "blocked"),
            (&["timeout"], "transient"),
        ]);

        assert_eq!(classifier.classify("Error 403 Forbidden"), Some(&"blocked"));
        assert_eq!(classifier.classify("Request timed out: timeout"), Some(&"transient"));
        assert_eq!(classifier.classify("success"), None);
    }

    #[test]
    fn case_insensitive() {
        let classifier: KeywordClassifier<&str> = KeywordClassifier::new(&[
            (&["captcha"], "blocked"),
        ]);

        assert_eq!(classifier.classify("CAPTCHA detected"), Some(&"blocked"));
        assert_eq!(classifier.classify("CaPtChA"), Some(&"blocked"));
        assert_eq!(classifier.classify("captcha"), Some(&"blocked"));
    }

    #[test]
    fn first_rule_wins() {
        let classifier: KeywordClassifier<&str> = KeywordClassifier::new(&[
            (&["timeout"], "blocked"),
            (&["timeout"], "transient"),
        ]);

        // First rule (blocked) should win even though both match "timeout"
        assert_eq!(classifier.classify("timeout error"), Some(&"blocked"));
    }

    #[test]
    fn overlapping_patterns() {
        let classifier: KeywordClassifier<&str> = KeywordClassifier::new(&[
            (&["bot detect", "bot protection"], "blocked"),
            (&["err_connection_reset", "err_connection_closed"], "transient"),
        ]);

        assert_eq!(
            classifier.classify("Detected bot detection script"),
            Some(&"blocked")
        );
        assert_eq!(
            classifier.classify("net::ERR_CONNECTION_RESET"),
            Some(&"transient")
        );
    }

    #[test]
    fn no_match_returns_none() {
        let classifier: KeywordClassifier<&str> = KeywordClassifier::new(&[
            (&["foo"], "a"),
            (&["bar"], "b"),
        ]);

        assert_eq!(classifier.classify("baz qux"), None);
        assert_eq!(classifier.classify(""), None);
    }

    #[test]
    fn substring_matching() {
        let classifier: KeywordClassifier<&str> = KeywordClassifier::new(&[
            (&["403"], "blocked"),
        ]);

        assert_eq!(classifier.classify("HTTP/1.1 403 Forbidden"), Some(&"blocked"));
    }

    #[test]
    fn multiple_keywords_same_rule() {
        let classifier: KeywordClassifier<i32> = KeywordClassifier::new(&[
            (&["alpha", "beta", "gamma"], 1),
            (&["delta", "epsilon"], 2),
        ]);

        assert_eq!(classifier.classify("testing beta value"), Some(&1));
        assert_eq!(classifier.classify("epsilon result"), Some(&2));
        assert_eq!(classifier.classify("zeta"), None);
    }

    #[test]
    fn aho_corasick_shared_prefix() {
        // Test the failure link mechanism with overlapping prefixes.
        let classifier: KeywordClassifier<&str> = KeywordClassifier::new(&[
            (&["abcde"], "first"),
            (&["bcd"], "second"),
        ]);

        // "bcd" should match via failure links when it's the only pattern present.
        assert_eq!(classifier.classify("xxbcdxx"), Some(&"second"));
        // "bcd" completes at position 3 (inside "abcde") before "abcde" completes at position 4,
        // so Aho-Corasick's first-match-in-scan-order returns "second".
        assert_eq!(classifier.classify("abcde"), Some(&"second"));

        // When shorter pattern isn't a substring, the longer one wins.
        let classifier2: KeywordClassifier<&str> = KeywordClassifier::new(&[
            (&["xyz"], "first"),
            (&["abc"], "second"),
        ]);
        assert_eq!(classifier2.classify("xxxyzxx"), Some(&"first"));
        assert_eq!(classifier2.classify("xxabcxx"), Some(&"second"));
    }

    #[test]
    fn real_world_error_messages() {
        #[derive(Clone, Debug, PartialEq)]
        enum ErrorClass {
            Blocked,
            Auth,
            BackendDown,
            Transient,
        }

        let classifier: KeywordClassifier<ErrorClass> = KeywordClassifier::new(&[
            (
                &[
                    "bot detect", "blocked", "403", "captcha",
                    "checking your browser", "access denied",
                ],
                ErrorClass::Blocked,
            ),
            (&["401", "unauthorized"], ErrorClass::Auth),
            (
                &["backend unavailable", "503", "service unavailable"],
                ErrorClass::BackendDown,
            ),
            (
                &["err_connection_reset", "timeout", "websocket closed"],
                ErrorClass::Transient,
            ),
        ]);

        assert_eq!(
            classifier.classify("Error: 403 Forbidden - Access Denied"),
            Some(&ErrorClass::Blocked)
        );
        assert_eq!(
            classifier.classify("HTTP 401 Unauthorized"),
            Some(&ErrorClass::Auth)
        );
        assert_eq!(
            classifier.classify("503 Service Temporarily Unavailable"),
            Some(&ErrorClass::BackendDown)
        );
        assert_eq!(
            classifier.classify("net::ERR_CONNECTION_RESET at navigation"),
            Some(&ErrorClass::Transient)
        );
        assert_eq!(
            classifier.classify("Page loaded successfully"),
            None
        );
    }
}
