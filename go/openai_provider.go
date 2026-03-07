package spiderbrowser

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// OpenAIProvider implements LLMProvider for OpenAI-compatible APIs.
type OpenAIProvider struct {
	config LLMConfig
	client *http.Client
}

// NewOpenAIProvider creates a new OpenAI-compatible provider.
func NewOpenAIProvider(config LLMConfig) *OpenAIProvider {
	baseURL := config.BaseURL
	if baseURL == "" {
		if config.Provider == "openrouter" {
			baseURL = "https://openrouter.ai/api/v1"
		} else {
			baseURL = "https://api.openai.com/v1"
		}
	}
	config.BaseURL = strings.TrimRight(baseURL, "/")
	return &OpenAIProvider{
		config: config,
		client: &http.Client{Timeout: 120 * time.Second},
	}
}

// Chat calls the LLM and returns text.
func (p *OpenAIProvider) Chat(messages []LLMMessage, jsonMode bool) (string, error) {
	body := map[string]any{
		"model":                messages[0].Role, // placeholder
		"messages":             p.convertMessages(messages),
		"max_completion_tokens": p.config.MaxTokens,
		"temperature":          p.config.Temperature,
	}
	body["model"] = p.config.Model

	if jsonMode {
		body["response_format"] = map[string]any{"type": "json_object"}
	}

	respBody, err := p.doRequest(body)
	if err != nil {
		return "", err
	}

	var resp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(respBody, &resp); err != nil {
		return "", newLLMError(fmt.Sprintf("failed to parse OpenAI response: %v", err))
	}
	if resp.Error != nil {
		return "", newLLMError(fmt.Sprintf("OpenAI API error: %s", resp.Error.Message))
	}
	if len(resp.Choices) == 0 {
		return "", newLLMError("OpenAI returned no choices")
	}
	return resp.Choices[0].Message.Content, nil
}

// ChatJSON calls the LLM and parses the response as JSON.
func (p *OpenAIProvider) ChatJSON(messages []LLMMessage, result any) error {
	text, err := p.Chat(messages, true)
	if err != nil {
		return err
	}
	// Strip markdown code fences if present
	text = strings.TrimSpace(text)
	if strings.HasPrefix(text, "```") {
		lines := strings.Split(text, "\n")
		if len(lines) > 2 {
			text = strings.Join(lines[1:len(lines)-1], "\n")
		}
	}
	if err := json.Unmarshal([]byte(text), result); err != nil {
		return newLLMError(fmt.Sprintf("failed to parse LLM JSON response: %v\nRaw: %s", err, text[:min(len(text), 200)]))
	}
	return nil
}

func (p *OpenAIProvider) convertMessages(messages []LLMMessage) []map[string]any {
	result := make([]map[string]any, len(messages))
	for i, msg := range messages {
		m := map[string]any{"role": msg.Role}
		switch content := msg.Content.(type) {
		case string:
			m["content"] = content
		case []LLMContentPart:
			parts := make([]map[string]any, len(content))
			for j, part := range content {
				p := map[string]any{"type": part.Type}
				if part.Type == "text" {
					p["text"] = part.Text
				} else if part.Type == "image_url" && part.ImageURL != nil {
					p["image_url"] = map[string]any{"url": part.ImageURL.URL}
				}
				parts[j] = p
			}
			m["content"] = parts
		}
		result[i] = m
	}
	return result
}

func (p *OpenAIProvider) doRequest(body map[string]any) ([]byte, error) {
	bodyJSON, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest("POST", p.config.BaseURL+"/chat/completions", bytes.NewReader(bodyJSON))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.config.APIKey)

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, newLLMError(fmt.Sprintf("OpenAI request failed: %v", err))
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, newLLMError(fmt.Sprintf("failed to read OpenAI response: %v", err))
	}

	if resp.StatusCode != 200 {
		return nil, newLLMError(fmt.Sprintf("OpenAI API error (%d): %s", resp.StatusCode, string(respBody[:min(len(respBody), 500)])))
	}

	return respBody, nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
