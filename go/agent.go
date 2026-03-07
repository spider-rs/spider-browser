package spiderbrowser

import (
	"encoding/json"
	"fmt"
	"time"
)

// AgentOptions configures an autonomous agent.
type AgentOptions struct {
	// MaxRounds is the max automation rounds (default: 30).
	MaxRounds int
	// StepDelayMs is the delay after actions for page settle (default: 1500).
	StepDelayMs int
	// Instruction is extra context for each round.
	Instruction string
}

// AgentResult is the result of an agent execution.
type AgentResult struct {
	Done      bool   `json:"done"`
	Rounds    int    `json:"rounds"`
	Extracted any    `json:"extracted,omitempty"`
	Label     string `json:"label"`
}

// AgentPlan is the parsed LLM response for each agent round.
type AgentPlan struct {
	Label     string           `json:"label"`
	Done      bool             `json:"done"`
	Steps     []map[string]any `json:"steps"`
	Extracted any              `json:"extracted,omitempty"`
}

// Agent is an autonomous multi-step agent.
type Agent struct {
	adapter  *ProtocolAdapter
	llm      LLMProvider
	emitter  *EventEmitter
	opts     AgentOptions
}

// NewAgent creates a new autonomous agent.
func NewAgent(adapter *ProtocolAdapter, llm LLMProvider, emitter *EventEmitter, opts *AgentOptions) *Agent {
	o := AgentOptions{
		MaxRounds:   30,
		StepDelayMs: 1500,
	}
	if opts != nil {
		if opts.MaxRounds > 0 {
			o.MaxRounds = opts.MaxRounds
		}
		if opts.StepDelayMs > 0 {
			o.StepDelayMs = opts.StepDelayMs
		}
		o.Instruction = opts.Instruction
	}
	return &Agent{
		adapter: adapter,
		llm:     llm,
		emitter: emitter,
		opts:    o,
	}
}

// Execute runs the agent loop until the task is done or max rounds reached.
func (a *Agent) Execute(instruction string) (*AgentResult, error) {
	var extracted any
	lastLabel := ""

	time.Sleep(500 * time.Millisecond)

	for round := 0; round < a.opts.MaxRounds; round++ {
		// 1. Capture screenshot
		screenshot, err := a.adapter.CaptureScreenshot()
		if err != nil {
			defaultLogger.warn(fmt.Sprintf("agent: screenshot failed round %d: %v", round, err))
			break
		}

		// 2. Get page HTML
		html, err := a.adapter.GetHTML()
		if err != nil {
			defaultLogger.warn(fmt.Sprintf("agent: get HTML failed round %d: %v", round, err))
			break
		}

		// 3. Get URL and title
		urlVal, _ := a.adapter.Evaluate("window.location.href")
		titleVal, _ := a.adapter.Evaluate("document.title")
		url, _ := urlVal.(string)
		title, _ := titleVal.(string)

		// 4. Call LLM
		context := fmt.Sprintf("Round %d/%d. Task: %s\nPAGE TITLE: %s",
			round+1, a.opts.MaxRounds, instruction, title)

		var plan AgentPlan
		err = a.llm.ChatJSON([]LLMMessage{
			{Role: "system", Content: SystemPrompt},
			{Role: "user", Content: BuildUserMessage(url, html, screenshot, context)},
		}, &plan)
		if err != nil {
			defaultLogger.warn(fmt.Sprintf("agent: LLM call failed round %d: %v", round, err))
			time.Sleep(2 * time.Second)
			continue
		}

		lastLabel = plan.Label
		if plan.Extracted != nil {
			extracted = plan.Extracted
		}

		defaultLogger.info(fmt.Sprintf("agent: round %d label=%q done=%v steps=%d",
			round+1, plan.Label, plan.Done, len(plan.Steps)))

		a.emitter.Emit("agent.step", map[string]any{
			"round":      round + 1,
			"label":      plan.Label,
			"stepsCount": len(plan.Steps),
		})

		// 5. Check if done
		if plan.Done {
			a.emitter.Emit("agent.done", map[string]any{
				"rounds": round + 1,
				"result": extracted,
			})
			return &AgentResult{
				Done:      true,
				Rounds:    round + 1,
				Extracted: extracted,
				Label:     lastLabel,
			}, nil
		}

		if len(plan.Steps) == 0 {
			defaultLogger.info("agent: no steps, retrying")
			time.Sleep(time.Duration(a.opts.StepDelayMs) * time.Millisecond)
			continue
		}

		// 6. Execute each step
		for i, action := range plan.Steps {
			if err := ExecuteAction(a.adapter, action); err != nil {
				actionJSON, _ := json.Marshal(action)
				s := string(actionJSON)
				if len(s) > 100 {
					s = s[:100]
				}
				defaultLogger.warn(fmt.Sprintf("agent: action failed round %d step %d: %s: %v", round, i, s, err))
				break
			}
			time.Sleep(200 * time.Millisecond)
		}

		// 7. Wait for page to settle
		time.Sleep(time.Duration(a.opts.StepDelayMs) * time.Millisecond)
	}

	defaultLogger.warn("agent: max rounds exceeded")
	a.emitter.Emit("agent.error", map[string]any{
		"error": "max rounds exceeded",
		"round": a.opts.MaxRounds,
	})
	return &AgentResult{
		Done:      false,
		Rounds:    a.opts.MaxRounds,
		Extracted: extracted,
		Label:     lastLabel,
	}, nil
}

// ExecuteAction executes a single agent action via the protocol adapter.
func ExecuteAction(adapter *ProtocolAdapter, action map[string]any) error {
	// Click actions
	if sel, ok := action["Click"].(string); ok {
		return clickBySelector(adapter, sel)
	}
	if sel, ok := action["ClickAll"].(string); ok {
		return clickAllBySelector(adapter, sel)
	}
	if pt, ok := action["ClickPoint"].(map[string]any); ok {
		x, _ := toFloat64(pt["x"])
		y, _ := toFloat64(pt["y"])
		return adapter.ClickPoint(x, y)
	}
	if data, ok := action["ClickHold"].(map[string]any); ok {
		sel, _ := data["selector"].(string)
		holdMs := toIntVal(data["hold_ms"])
		x, y, err := getElementCenterForAction(adapter, sel)
		if err != nil {
			return err
		}
		return adapter.ClickHoldPoint(x, y, holdMs)
	}
	if data, ok := action["ClickHoldPoint"].(map[string]any); ok {
		x, _ := toFloat64(data["x"])
		y, _ := toFloat64(data["y"])
		holdMs := toIntVal(data["hold_ms"])
		return adapter.ClickHoldPoint(x, y, holdMs)
	}
	if sel, ok := action["DoubleClick"].(string); ok {
		x, y, err := getElementCenterForAction(adapter, sel)
		if err != nil {
			return err
		}
		return adapter.DoubleClickPoint(x, y)
	}
	if pt, ok := action["DoubleClickPoint"].(map[string]any); ok {
		x, _ := toFloat64(pt["x"])
		y, _ := toFloat64(pt["y"])
		return adapter.DoubleClickPoint(x, y)
	}
	if sel, ok := action["RightClick"].(string); ok {
		x, y, err := getElementCenterForAction(adapter, sel)
		if err != nil {
			return err
		}
		return adapter.RightClickPoint(x, y)
	}
	if pt, ok := action["RightClickPoint"].(map[string]any); ok {
		x, _ := toFloat64(pt["x"])
		y, _ := toFloat64(pt["y"])
		return adapter.RightClickPoint(x, y)
	}
	if sel, ok := action["WaitForAndClick"].(string); ok {
		waitForElement(adapter, sel, 5000)
		return clickBySelector(adapter, sel)
	}

	// Drag
	if data, ok := action["ClickDrag"].(map[string]any); ok {
		from, _ := data["from"].(string)
		to, _ := data["to"].(string)
		fx, fy, err := getElementCenterForAction(adapter, from)
		if err != nil {
			return err
		}
		tx, ty, err := getElementCenterForAction(adapter, to)
		if err != nil {
			return err
		}
		return adapter.DragPoint(fx, fy, tx, ty)
	}
	if data, ok := action["ClickDragPoint"].(map[string]any); ok {
		fx, _ := toFloat64(data["from_x"])
		fy, _ := toFloat64(data["from_y"])
		tx, _ := toFloat64(data["to_x"])
		ty, _ := toFloat64(data["to_y"])
		return adapter.DragPoint(fx, fy, tx, ty)
	}

	// Input
	if data, ok := action["Type"].(map[string]any); ok {
		value, _ := data["value"].(string)
		return adapter.InsertText(value)
	}
	if data, ok := action["Fill"].(map[string]any); ok {
		sel, _ := data["selector"].(string)
		value, _ := data["value"].(string)
		adapter.Evaluate(fmt.Sprintf(`(function(){var el=document.querySelector(%s);if(el){el.focus();el.value='';}})()`, jsonString(sel)))
		x, y, err := getElementCenterForAction(adapter, sel)
		if err == nil {
			adapter.ClickPoint(x, y)
		}
		adapter.InsertText(value)
		adapter.Evaluate(fmt.Sprintf(`(function(){var el=document.querySelector(%s);if(el){el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}})()`, jsonString(sel)))
		return nil
	}
	if sel, ok := action["Clear"].(string); ok {
		adapter.Evaluate(fmt.Sprintf("document.querySelector(%s).value=''", jsonString(sel)))
		return nil
	}
	if key, ok := action["Press"].(string); ok {
		return adapter.PressKey(key)
	}
	if key, ok := action["KeyDown"].(string); ok {
		return adapter.KeyDown(key)
	}
	if key, ok := action["KeyUp"].(string); ok {
		return adapter.KeyUp(key)
	}

	// Select & Focus
	if data, ok := action["Select"].(map[string]any); ok {
		sel, _ := data["selector"].(string)
		value, _ := data["value"].(string)
		adapter.Evaluate(fmt.Sprintf(`(function(){var el=document.querySelector(%s);if(el){el.value=%s;el.dispatchEvent(new Event('change',{bubbles:true}));}})()`, jsonString(sel), jsonString(value)))
		return nil
	}
	if sel, ok := action["Focus"].(string); ok {
		adapter.Evaluate(fmt.Sprintf("document.querySelector(%s)?.focus()", jsonString(sel)))
		return nil
	}
	if sel, ok := action["Blur"].(string); ok {
		adapter.Evaluate(fmt.Sprintf("document.querySelector(%s)?.blur()", jsonString(sel)))
		return nil
	}
	if sel, ok := action["Hover"].(string); ok {
		x, y, err := getElementCenterForAction(adapter, sel)
		if err != nil {
			return err
		}
		return adapter.HoverPoint(x, y)
	}
	if pt, ok := action["HoverPoint"].(map[string]any); ok {
		x, _ := toFloat64(pt["x"])
		y, _ := toFloat64(pt["y"])
		return adapter.HoverPoint(x, y)
	}

	// Scroll
	if pixels, ok := action["ScrollY"]; ok {
		px, _ := toFloat64(pixels)
		adapter.Evaluate(fmt.Sprintf("window.scrollBy(0,%d)", int(px)))
		return nil
	}
	if pixels, ok := action["ScrollX"]; ok {
		px, _ := toFloat64(pixels)
		adapter.Evaluate(fmt.Sprintf("window.scrollBy(%d,0)", int(px)))
		return nil
	}
	if data, ok := action["ScrollTo"].(map[string]any); ok {
		sel, _ := data["selector"].(string)
		adapter.Evaluate(fmt.Sprintf("document.querySelector(%s)?.scrollIntoView({behavior:'smooth',block:'center'})", jsonString(sel)))
		return nil
	}
	if data, ok := action["ScrollToPoint"].(map[string]any); ok {
		x, _ := toFloat64(data["x"])
		y, _ := toFloat64(data["y"])
		adapter.Evaluate(fmt.Sprintf("window.scrollTo(%d,%d)", int(x), int(y)))
		return nil
	}
	if n, ok := action["InfiniteScroll"]; ok {
		count, _ := toFloat64(n)
		for i := 0; i < int(count); i++ {
			adapter.Evaluate("window.scrollTo(0,document.body.scrollHeight)")
			time.Sleep(500 * time.Millisecond)
		}
		return nil
	}

	// Wait
	if ms, ok := action["Wait"]; ok {
		d, _ := toFloat64(ms)
		time.Sleep(time.Duration(d) * time.Millisecond)
		return nil
	}
	if sel, ok := action["WaitFor"].(string); ok {
		return waitForElement(adapter, sel, 5000)
	}
	if data, ok := action["WaitForWithTimeout"].(map[string]any); ok {
		sel, _ := data["selector"].(string)
		timeout := toIntVal(data["timeout"])
		return waitForElement(adapter, sel, timeout)
	}
	if _, ok := action["WaitForNavigation"]; ok {
		time.Sleep(1 * time.Second)
		return nil
	}
	if data, ok := action["WaitForDom"].(map[string]any); ok {
		timeout := toIntVal(data["timeout"])
		if timeout == 0 {
			timeout = 5000
		}
		time.Sleep(time.Duration(timeout) * time.Millisecond)
		return nil
	}

	// Navigation
	if url, ok := action["Navigate"].(string); ok {
		return adapter.Navigate(url)
	}
	if _, ok := action["GoBack"]; ok {
		adapter.Evaluate("window.history.back()")
		return nil
	}
	if _, ok := action["GoForward"]; ok {
		adapter.Evaluate("window.history.forward()")
		return nil
	}
	if _, ok := action["Reload"]; ok {
		adapter.Evaluate("window.location.reload()")
		return nil
	}

	// Viewport
	if data, ok := action["SetViewport"].(map[string]any); ok {
		w := toIntVal(data["width"])
		h := toIntVal(data["height"])
		dsf := 2.0
		if v, ok := toFloat64(data["device_scale_factor"]); ok {
			dsf = v
		}
		mobile := false
		if v, ok := data["mobile"].(bool); ok {
			mobile = v
		}
		return adapter.SetViewport(w, h, dsf, mobile)
	}

	// JavaScript
	if expr, ok := action["Evaluate"].(string); ok {
		adapter.Evaluate(expr)
		return nil
	}

	// Screenshot (no-op)
	if _, ok := action["Screenshot"]; ok {
		return nil
	}

	defaultLogger.warn(fmt.Sprintf("agent: unknown action: %v", action))
	return nil
}

func clickBySelector(adapter *ProtocolAdapter, selector string) error {
	x, y, err := getElementCenterForAction(adapter, selector)
	if err != nil {
		return err
	}
	return adapter.ClickPoint(x, y)
}

func clickAllBySelector(adapter *ProtocolAdapter, selector string) error {
	val, err := adapter.Evaluate(fmt.Sprintf(`
		(function(){var els=document.querySelectorAll(%s);return Array.from(els).map(function(el){var r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};});})()
	`, jsonString(selector)))
	if err != nil {
		return err
	}
	if points, ok := val.([]any); ok {
		for _, pt := range points {
			if m, ok := pt.(map[string]any); ok {
				x, _ := toFloat64(m["x"])
				y, _ := toFloat64(m["y"])
				adapter.ClickPoint(x, y)
				time.Sleep(100 * time.Millisecond)
			}
		}
	}
	return nil
}

func getElementCenterForAction(adapter *ProtocolAdapter, selector string) (float64, float64, error) {
	val, err := adapter.Evaluate(fmt.Sprintf(`
		(function(){var el=document.querySelector(%s);if(!el)return null;el.scrollIntoView({block:'center',behavior:'instant'});var r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()
	`, jsonString(selector)))
	if err != nil {
		return 0, 0, err
	}
	if m, ok := val.(map[string]any); ok {
		x, _ := toFloat64(m["x"])
		y, _ := toFloat64(m["y"])
		return x, y, nil
	}
	return 0, 0, fmt.Errorf("element not found: %s", selector)
}

func waitForElement(adapter *ProtocolAdapter, selector string, timeoutMs int) error {
	interval := 100 * time.Millisecond
	maxIter := timeoutMs / 100
	checkJS := fmt.Sprintf("!!document.querySelector(%s)", jsonString(selector))
	for i := 0; i < maxIter; i++ {
		found, _ := adapter.Evaluate(checkJS)
		if b, ok := found.(bool); ok && b {
			return nil
		}
		time.Sleep(interval)
	}
	return newTimeoutError(fmt.Sprintf("timeout waiting for element: %s", selector))
}
