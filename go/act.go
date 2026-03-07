package spiderbrowser

import (
	"fmt"
	"time"
)

// Act executes a single action from natural language.
func Act(adapter *ProtocolAdapter, llm LLMProvider, instruction string) error {
	screenshot, err := adapter.CaptureScreenshot()
	if err != nil {
		return err
	}
	html, err := adapter.GetHTML()
	if err != nil {
		return err
	}
	urlVal, _ := adapter.Evaluate("window.location.href")
	titleVal, _ := adapter.Evaluate("document.title")
	url, _ := urlVal.(string)
	title, _ := titleVal.(string)

	context := fmt.Sprintf("Task: %s\nPAGE TITLE: %s", instruction, title)

	var plan AgentPlan
	err = llm.ChatJSON([]LLMMessage{
		{Role: "system", Content: SystemPrompt},
		{Role: "user", Content: BuildUserMessage(url, html, screenshot, context)},
	}, &plan)
	if err != nil {
		return err
	}

	for _, step := range plan.Steps {
		if err := ExecuteAction(adapter, step); err != nil {
			return err
		}
		time.Sleep(200 * time.Millisecond)
	}
	return nil
}
