package spiderbrowser

// LLMConfig configures an LLM provider for AI methods.
type LLMConfig struct {
	// Provider: "openai", "anthropic", or "openrouter".
	Provider string
	// Model name (e.g. "gpt-4o", "claude-sonnet-4-5-20250929").
	Model string
	// APIKey for the provider.
	APIKey string
	// BaseURL override (e.g. for OpenRouter or local vLLM).
	BaseURL string
	// MaxTokens (default: 4096).
	MaxTokens int
	// Temperature (default: 0.1).
	Temperature float64
}

func (c *LLMConfig) defaults() {
	if c.MaxTokens == 0 {
		c.MaxTokens = 4096
	}
	if c.Temperature == 0 {
		c.Temperature = 0.1
	}
}

// LLMMessage is a message for LLM calls.
type LLMMessage struct {
	Role    string       `json:"role"` // "system", "user", "assistant"
	Content any          `json:"content"` // string or []LLMContentPart
}

// LLMContentPart is a part of a multimodal message.
type LLMContentPart struct {
	Type     string        `json:"type"` // "text" or "image_url"
	Text     string        `json:"text,omitempty"`
	ImageURL *LLMImageURL  `json:"image_url,omitempty"`
}

// LLMImageURL is an image URL in a content part.
type LLMImageURL struct {
	URL string `json:"url"`
}

// LLMProvider is the interface for LLM providers.
type LLMProvider interface {
	// Chat calls the LLM with messages and returns a text response.
	Chat(messages []LLMMessage, jsonMode bool) (string, error)
	// ChatJSON calls the LLM and parses the response as JSON into result.
	ChatJSON(messages []LLMMessage, result any) error
}

// CreateProvider creates an LLM provider from config.
func CreateProvider(config LLMConfig) LLMProvider {
	config.defaults()
	switch config.Provider {
	case "openai", "openrouter":
		return NewOpenAIProvider(config)
	case "anthropic":
		return NewAnthropicProvider(config)
	default:
		panic("unknown LLM provider: " + config.Provider)
	}
}
