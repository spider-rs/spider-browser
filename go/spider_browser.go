package spiderbrowser

import (
	"fmt"
	"time"
)

// SpiderBrowserOptions configures a SpiderBrowser instance.
type SpiderBrowserOptions struct {
	// APIKey is the Spider API key (required).
	APIKey string
	// ServerURL is the WebSocket server URL (default: wss://browser.spider.cloud).
	ServerURL string
	// Browser to use: "auto", "chrome", "firefox" (default: "auto").
	Browser string
	// URL hint for server browser+proxy selection.
	URL string
	// Captcha handling: "off", "detect", "solve" (default: "solve").
	Captcha string
	// SmartRetry enables smart retry with browser switching (default: true).
	SmartRetry *bool
	// MaxRetries is the max retry attempts across all browsers (default: 12).
	MaxRetries int
	// Stealth level (1-3). 0 = auto-escalate on failure.
	Stealth int
	// MaxStealthLevels is the maximum stealth level to auto-escalate to (default: 3).
	MaxStealthLevels int
	// Country code for geo-located proxy (e.g. "US", "GB", "DE").
	Country string
	// ProxyURL is a custom proxy URL (e.g. "http://user:pass@proxy:8080").
	ProxyURL string
	// ConnectTimeout is the WebSocket connect timeout (default: 30s).
	ConnectTimeout time.Duration
	// CommandTimeout is the CDP/BiDi command timeout (default: 30s).
	CommandTimeout time.Duration
	// RetryTimeout is the timeout for retry attempts (default: 15s).
	RetryTimeout time.Duration
	// Hedge marks this session as a hedge (parallel attempt).
	Hedge bool
	// Record enables screencast recording (default: false).
	Record bool
	// Mode is the browser mode: "scraping" or "cua".
	Mode string
	// LLM is the LLM configuration for AI methods (optional).
	LLM *LLMConfig
	// LogLevel sets the log level (default: LogInfo).
	LogLevel *LogLevel
}

func (o *SpiderBrowserOptions) defaults() {
	if o.ServerURL == "" {
		o.ServerURL = "wss://browser.spider.cloud"
	}
	if o.Browser == "" {
		o.Browser = "auto"
	}
	if o.Captcha == "" {
		o.Captcha = "solve"
	}
	if o.SmartRetry == nil {
		t := true
		o.SmartRetry = &t
	}
	if o.MaxRetries == 0 {
		o.MaxRetries = 12
	}
	if o.MaxStealthLevels == 0 {
		o.MaxStealthLevels = 3
	}
	if o.ConnectTimeout == 0 {
		o.ConnectTimeout = 30 * time.Second
	}
	if o.CommandTimeout == 0 {
		o.CommandTimeout = 30 * time.Second
	}
	if o.RetryTimeout == 0 {
		o.RetryTimeout = 15 * time.Second
	}
}

// SpiderBrowser is the main entry point for spider-browser.
//
// Connects to Spider's pre-warmed browser fleet via WebSocket.
// Provides deterministic page control (via SpiderPage) and
// AI-powered automation (Act, Observe, Extract, Agent).
type SpiderBrowser struct {
	opts        SpiderBrowserOptions
	transport   *Transport
	adapter     *ProtocolAdapter
	retryEngine *RetryEngine
	emitter     *EventEmitter
	page        *SpiderPage
	llmProvider LLMProvider
	currentURL  string
}

// New creates a new SpiderBrowser instance.
func New(opts SpiderBrowserOptions) *SpiderBrowser {
	opts.defaults()
	if opts.LogLevel != nil {
		SetLogLevel(*opts.LogLevel)
	}

	sb := &SpiderBrowser{
		opts:    opts,
		emitter: NewEventEmitter(),
	}

	if opts.LLM != nil {
		sb.llmProvider = CreateProvider(*opts.LLM)
	}

	return sb
}

// Page returns the active page instance for deterministic browser control.
func (sb *SpiderBrowser) Page() *SpiderPage {
	if sb.page == nil {
		panic("SpiderBrowser not initialized — call Init() first")
	}
	return sb.page
}

// Browser returns the current browser type.
func (sb *SpiderBrowser) Browser() string {
	if sb.transport != nil {
		return sb.transport.Browser()
	}
	return sb.opts.Browser
}

// Connected returns whether the WebSocket is connected.
func (sb *SpiderBrowser) Connected() bool {
	if sb.transport != nil {
		return sb.transport.Connected()
	}
	return false
}

// StealthLevel returns the active stealth level.
func (sb *SpiderBrowser) StealthLevel() int {
	if sb.retryEngine != nil {
		return sb.retryEngine.StealthLevel()
	}
	if sb.transport != nil {
		return sb.transport.StealthLevel()
	}
	return sb.opts.Stealth
}

// Credits returns credits remaining from the last upgrade response.
func (sb *SpiderBrowser) Credits() *float64 {
	if sb.transport != nil {
		return sb.transport.UpgradeCredits()
	}
	return nil
}

// SessionCreditsUsed returns credits consumed during this session.
func (sb *SpiderBrowser) SessionCreditsUsed() *float64 {
	if sb.transport != nil {
		return sb.transport.SessionCreditsUsed()
	}
	return nil
}

// GetSessionCredits requests the exact session cost from the server.
func (sb *SpiderBrowser) GetSessionCredits() (float64, error) {
	if sb.transport == nil {
		return 0, nil
	}
	return sb.transport.RequestMetering(3 * time.Second)
}

// On subscribes to events.
func (sb *SpiderBrowser) On(event string, handler EventHandler) *SpiderBrowser {
	sb.emitter.On(event, handler)
	return sb
}

// Off unsubscribes from events.
func (sb *SpiderBrowser) Off(event string, handler EventHandler) *SpiderBrowser {
	sb.emitter.Off(event, handler)
	return sb
}

// Once subscribes to an event for a single firing.
func (sb *SpiderBrowser) Once(event string, handler EventHandler) *SpiderBrowser {
	sb.emitter.Once(event, handler)
	return sb
}

// Init connects to the browser server and initializes the protocol.
func (sb *SpiderBrowser) Init() error {
	transportOpts := TransportOptions{
		APIKey:         sb.opts.APIKey,
		ServerURL:      sb.opts.ServerURL,
		Browser:        sb.opts.Browser,
		URL:            sb.opts.URL,
		Captcha:        sb.opts.Captcha,
		StealthLevel:   sb.opts.Stealth,
		ConnectTimeout: sb.opts.ConnectTimeout,
		CommandTimeout: sb.opts.CommandTimeout,
		Hedge:          sb.opts.Hedge,
		Record:         sb.opts.Record,
		Mode:           sb.opts.Mode,
		Country:        sb.opts.Country,
		ProxyURL:       sb.opts.ProxyURL,
	}

	sb.transport = NewTransport(transportOpts, sb.emitter)
	if err := sb.transport.Connect(3); err != nil {
		return err
	}

	activeBrowser := sb.transport.Browser()
	sb.adapter = NewProtocolAdapter(sb.transport, sb.emitter, activeBrowser, sb.opts.CommandTimeout)
	if err := sb.adapter.Init(); err != nil {
		return err
	}

	sb.page = NewSpiderPage(sb.adapter)

	if *sb.opts.SmartRetry {
		sb.retryEngine = NewRetryEngine(RetryEngineOptions{
			MaxRetries:     sb.opts.MaxRetries,
			Emitter:        sb.emitter,
			MaxStealthLevel: sb.opts.MaxStealthLevels,
			InitialStealth: sb.opts.Stealth,
			RetryTimeout:   sb.opts.RetryTimeout,
			CommandTimeout: sb.opts.CommandTimeout,
		})
	}

	sb.currentURL = sb.opts.URL
	defaultLogger.info(fmt.Sprintf("SpiderBrowser initialized (browser=%s)", activeBrowser))
	return nil
}

// WithRetry executes an action with smart retry.
func (sb *SpiderBrowser) WithRetry(fn func() error) error {
	if sb.retryEngine == nil || sb.transport == nil || sb.adapter == nil {
		return fn()
	}
	return sb.retryEngine.Execute(fn, &RetryContext{
		Transport:  sb.transport,
		Adapter:    sb.adapter,
		CurrentURL: sb.currentURL,
		Emitter:    sb.emitter,
		OnAdapterChanged: func(newAdapter *ProtocolAdapter) {
			sb.adapter = newAdapter
			sb.page.SetAdapter(newAdapter)
		},
	})
}

// Goto navigates to a URL with smart retry.
func (sb *SpiderBrowser) Goto(url string) error {
	sb.currentURL = url
	return sb.WithRetry(func() error {
		return sb.page.Goto(url)
	})
}

// Act executes a single action from natural language.
func (sb *SpiderBrowser) Act(instruction string) error {
	if sb.llmProvider == nil {
		return ErrLLMNotConfigured
	}
	return sb.WithRetry(func() error {
		return Act(sb.adapter, sb.llmProvider, instruction)
	})
}

// Observe discovers interactive elements on the page.
func (sb *SpiderBrowser) Observe(instruction string) ([]ObserveResult, error) {
	var results []ObserveResult
	err := sb.WithRetry(func() error {
		var e error
		results, e = Observe(sb.adapter, instruction, sb.llmProvider)
		return e
	})
	return results, err
}

// Extract extracts structured data from the page.
func (sb *SpiderBrowser) Extract(instruction string, result any) error {
	if sb.llmProvider == nil {
		return ErrLLMNotConfigured
	}
	return sb.WithRetry(func() error {
		return Extract(sb.adapter, sb.llmProvider, instruction, result)
	})
}

// NewAgent creates an autonomous agent for multi-step tasks.
func (sb *SpiderBrowser) NewAgent(opts *AgentOptions) *Agent {
	if sb.llmProvider == nil {
		panic("LLM not configured — pass LLM option to SpiderBrowserOptions for AI methods")
	}
	return NewAgent(sb.adapter, sb.llmProvider, sb.emitter, opts)
}

// Close closes the connection and cleans up resources.
func (sb *SpiderBrowser) Close() {
	if sb.adapter != nil {
		sb.adapter.Destroy()
	}
	if sb.transport != nil {
		sb.transport.Close()
	}
	sb.emitter.RemoveAllListeners()
	sb.page = nil
	sb.adapter = nil
	sb.transport = nil
	defaultLogger.info("SpiderBrowser closed")
}
