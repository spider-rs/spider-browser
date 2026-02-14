/**
 * Aho-Corasick keyword classifier — O(n) multi-pattern substring matching.
 *
 * Scans the input string exactly ONCE regardless of how many keywords exist.
 * Returns the classification of the first matched keyword (priority-ordered).
 *
 * Built at module load time — zero per-call allocation or compilation.
 */

interface TrieNode<T> {
  children: Map<number, TrieNode<T>>; // char code → child
  output: T | undefined;              // classification if this node ends a keyword
  fail: TrieNode<T> | undefined;      // failure link (longest proper suffix in trie)
  dict: TrieNode<T> | undefined;      // dictionary suffix link (nearest ancestor with output)
}

export class KeywordClassifier<T> {
  private root: TrieNode<T>;

  constructor(rules: [string[], T][]) {
    this.root = { children: new Map(), output: undefined, fail: undefined, dict: undefined };

    // Insert keywords — rules are in priority order (first match wins)
    for (const [keywords, cls] of rules) {
      for (const kw of keywords) {
        this.insert(kw.toLowerCase(), cls);
      }
    }

    this.buildFailureLinks();
  }

  /**
   * Classify a string by scanning it once for all keywords.
   * Returns the classification of the highest-priority matching keyword, or undefined.
   */
  classify(text: string): T | undefined {
    let node = this.root;
    for (let i = 0; i < text.length; i++) {
      // lowercase inline (avoids allocating a new string)
      let ch = text.charCodeAt(i);
      if (ch >= 65 && ch <= 90) ch += 32; // A-Z → a-z

      // Follow failure links until we find a matching transition or reach root
      while (node !== this.root && !node.children.has(ch)) {
        node = node.fail!;
      }
      node = node.children.get(ch) ?? this.root;

      // Check output chain for matches
      if (node.output !== undefined) return node.output;
      if (node.dict !== undefined && node.dict.output !== undefined) {
        return node.dict.output;
      }
    }
    return undefined;
  }

  private insert(word: string, cls: T): void {
    let node = this.root;
    for (let i = 0; i < word.length; i++) {
      const ch = word.charCodeAt(i);
      let child = node.children.get(ch);
      if (!child) {
        child = { children: new Map(), output: undefined, fail: undefined, dict: undefined };
        node.children.set(ch, child);
      }
      node = child;
    }
    // First rule wins — don't overwrite higher-priority classification
    if (node.output === undefined) {
      node.output = cls;
    }
  }

  private buildFailureLinks(): void {
    const queue: TrieNode<T>[] = [];

    // Root's children have fail → root
    for (const child of this.root.children.values()) {
      child.fail = this.root;
      child.dict = this.root;
      queue.push(child);
    }

    // BFS to build failure and dictionary links
    let head = 0;
    while (head < queue.length) {
      const node = queue[head++]!;

      for (const [ch, child] of node.children) {
        // Find failure link for child
        let fail = node.fail!;
        while (fail !== this.root && !fail.children.has(ch)) {
          fail = fail.fail!;
        }
        child.fail = fail.children.get(ch) ?? this.root;
        if (child.fail === child) child.fail = this.root; // avoid self-loop

        // Dictionary suffix link — nearest ancestor node with output
        child.dict = child.fail.output !== undefined
          ? child.fail
          : (child.fail.dict ?? undefined);

        queue.push(child);
      }
    }
  }
}
