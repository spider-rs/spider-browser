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

// AnthropicProvider implements LLMProvider for the Anthropic API.
type AnthropicProvider struct {
	config LLMConfig
	client *http.Client
}

// NewAnthropicProvider creates a new Anthropic provider.
func NewAnthropicProvider(config LLMConfig) *AnthropicProvider {
	if config.BaseURL == "" {
		config.BaseURL = "https://api.anthropic.com"
	}
	config.BaseURL = strings.TrimRight(config.BaseURL, "/")
	return &AnthropicProvider{
		config: config,
		client: &http.Client{Timeout: 120 * time.Second},
	}
}

// Chat calls the Anthropic API and returns text.
func (p *AnthropicProvider) Chat(messages []LLMMessage, jsonMode bool) (string, error) {
	// Extract system message
	var system string
	var userMessages []LLMMessage
	for _, msg := range messages {
		if msg.Role == "system" {
			if s, ok := msg.Content.(string); ok {
				system = s
			}
		} else {
			userMessages = append(userMessages, msg)
		}
	}

	body := map[string]any{
		"model":      p.config.Model,
		"max_tokens": p.config.MaxTokens,
		"temperature": p.config.Temperature,
		"messages":   p.convertMessages(userMessages),
	}
	if system != "" {
		body["system"] = system
	}

	respBody, err := p.doRequest(body)
	if err != nil {
		return "", err
	}

	var resp struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		Error *struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(respBody, &resp); err != nil {
		return "", newLLMError(fmt.Sprintf("failed to parse Anthropic response: %v", err))
	}
	if resp.Error != nil {
		return "", newLLMError(fmt.Sprintf("Anthropic API error: %s: %s", resp.Error.Type, resp.Error.Message))
	}
	if len(resp.Content) == 0 {
		return "", newLLMError("Anthropic returned no content")
	}

	var text string
	for _, block := range resp.Content {
		if block.Type == "text" {
			text += block.Text
		}
	}
	return text, nil
}

// ChatJSON calls the LLM and parses the response as JSON.
func (p *AnthropicProvider) ChatJSON(messages []LLMMessage, result any) error {
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

func (p *AnthropicProvider) convertMessages(messages []LLMMessage) []map[string]any {
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
					// Convert to Anthropic format
					p["type"] = "image"
					// Extract base64 from data URL
					url := part.ImageURL.URL
					mediaType := "image/png"
					data := url
					if strings.HasPrefix(url, "data:") {
						parts := strings.SplitN(url, ",", 2)
						if len(parts) == 2 {
							data = parts[1]
							mt := strings.TrimPrefix(parts[0], "data:")
							mt = strings.TrimSuffix(mt, ";base64")
							mediaType = mt
						}
					}
					p["source"] = map[string]any{
						"type":       "base64",
						"media_type": mediaType,
						"data":       data,
					}
				}
				parts[j] = p
			}
			m["content"] = parts
		}
		result[i] = m
	}
	return result
}

func (p *AnthropicProvider) doRequest(body map[string]any) ([]byte, error) {
	bodyJSON, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest("POST", p.config.BaseURL+"/v1/messages", bytes.NewReader(bodyJSON))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", p.config.APIKey)
	req.Header.Set("Anthropic-Version", "2023-06-01")

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, newLLMError(fmt.Sprintf("Anthropic request failed: %v", err))
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, newLLMError(fmt.Sprintf("failed to read Anthropic response: %v", err))
	}

	if resp.StatusCode != 200 {
		return nil, newLLMError(fmt.Sprintf("Anthropic API error (%d): %s", resp.StatusCode, string(respBody[:min(len(respBody), 500)])))
	}

	return respBody, nil
}
