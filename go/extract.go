package spiderbrowser

import "fmt"

// Extract extracts structured data from the page using an LLM.
// The result parameter should be a pointer to the desired struct type.
func Extract(adapter *ProtocolAdapter, llm LLMProvider, instruction string, result any) error {
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

	truncatedHTML := TruncateHTML(html, 12000)

	systemPrompt := `You are a data extraction agent. Given a webpage screenshot and HTML, extract the requested information as JSON.

Return ONLY a valid JSON object. No prose, no markdown.`

	userText := fmt.Sprintf("URL: %s\nTitle: %s\nInstruction: %s\n\nHTML (truncated):\n%s",
		url, title, instruction, truncatedHTML)

	return llm.ChatJSON([]LLMMessage{
		{Role: "system", Content: systemPrompt},
		{Role: "user", Content: []LLMContentPart{
			{Type: "text", Text: userText},
			{Type: "image_url", ImageURL: &LLMImageURL{
				URL: fmt.Sprintf("data:image/png;base64,%s", screenshot),
			}},
		}},
	}, result)
}
