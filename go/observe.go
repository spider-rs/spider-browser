package spiderbrowser

import (
	"encoding/json"
	"fmt"
	"strings"
)

// ObserveResult represents an observed interactive element on the page.
type ObserveResult struct {
	Selector    string `json:"selector"`
	Tag         string `json:"tag"`
	Type        string `json:"type"`
	Text        string `json:"text"`
	AriaLabel   string `json:"ariaLabel"`
	Placeholder string `json:"placeholder"`
	Href        string `json:"href"`
	Value       string `json:"value"`
	Rect        struct {
		X      int `json:"x"`
		Y      int `json:"y"`
		Width  int `json:"width"`
		Height int `json:"height"`
	} `json:"rect"`
	Score float64 `json:"score,omitempty"`
}

// Observe discovers interactive elements on the page.
// Works without an LLM. When instruction is provided + LLM is available, adds ranking.
func Observe(adapter *ProtocolAdapter, instruction string, llm LLMProvider) ([]ObserveResult, error) {
	val, err := adapter.Evaluate(getInteractiveElementsJS)
	if err != nil {
		return nil, err
	}

	// Convert the result to ObserveResult slice
	var elements []ObserveResult
	data, err := json.Marshal(val)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &elements); err != nil {
		return nil, nil // No elements found
	}

	if len(elements) == 0 {
		return nil, nil
	}

	// If no instruction or no LLM, return all elements
	if instruction == "" || llm == nil {
		return elements, nil
	}

	// Use LLM to rank/filter
	var summary strings.Builder
	for i, el := range elements {
		fmt.Fprintf(&summary, "[%d] <%s>", i, el.Tag)
		if el.Text != "" {
			fmt.Fprintf(&summary, " text=%q", el.Text)
		}
		if el.AriaLabel != "" {
			fmt.Fprintf(&summary, " aria=%q", el.AriaLabel)
		}
		if el.Placeholder != "" {
			fmt.Fprintf(&summary, " placeholder=%q", el.Placeholder)
		}
		if el.Href != "" {
			fmt.Fprintf(&summary, " href=%q", el.Href)
		}
		if el.Type != "" {
			fmt.Fprintf(&summary, " type=%q", el.Type)
		}
		summary.WriteString("\n")
	}

	var result struct {
		Indices []int `json:"indices"`
	}
	err = llm.ChatJSON([]LLMMessage{
		{
			Role: "system",
			Content: "You are an element selector. Given a list of page elements and an instruction, " +
				"return a JSON object with an \"indices\" array of element indices that match the instruction. " +
				"Order by relevance (most relevant first). Return {\"indices\": []} if none match.",
		},
		{
			Role:    "user",
			Content: fmt.Sprintf("Instruction: %s\n\nElements:\n%s", instruction, summary.String()),
		},
	}, &result)
	if err != nil {
		return elements, nil // Fall back to all elements on LLM error
	}

	filtered := make([]ObserveResult, 0, len(result.Indices))
	for rank, idx := range result.Indices {
		if idx >= 0 && idx < len(elements) {
			el := elements[idx]
			el.Score = 1.0 - float64(rank)/float64(max(len(result.Indices), 1))
			filtered = append(filtered, el)
		}
	}
	return filtered, nil
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
