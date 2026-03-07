package spiderbrowser

// CDPCommand is a CDP JSON-RPC request.
type CDPCommand struct {
	ID        int            `json:"id"`
	Method    string         `json:"method"`
	Params    map[string]any `json:"params,omitempty"`
	SessionID string         `json:"sessionId,omitempty"`
}

// CDPResponse is a CDP JSON-RPC response.
type CDPResponse struct {
	ID        int            `json:"id"`
	Result    map[string]any `json:"result,omitempty"`
	Error     *CDPError      `json:"error,omitempty"`
	SessionID string         `json:"sessionId,omitempty"`
}

// CDPError is an error in a CDP response.
type CDPError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    string `json:"data,omitempty"`
}

// CDPEvent is a CDP event (no id).
type CDPEvent struct {
	Method    string         `json:"method"`
	Params    map[string]any `json:"params,omitempty"`
	SessionID string         `json:"sessionId,omitempty"`
}

// BiDiCommand is a WebDriver BiDi command.
type BiDiCommand struct {
	ID     int            `json:"id"`
	Method string         `json:"method"`
	Params map[string]any `json:"params"`
}

// BiDiResponse is a WebDriver BiDi response.
type BiDiResponse struct {
	ID      int            `json:"id"`
	Type    string         `json:"type"` // "success" or "error"
	Result  map[string]any `json:"result,omitempty"`
	Error   string         `json:"error,omitempty"`
	Message string         `json:"message,omitempty"`
}

// KeyParams holds the key, code, and keyCode for keyboard events.
type KeyParams struct {
	Key     string
	Code    string
	KeyCode int
}

// keyMap maps key names to their CDP dispatch parameters.
var keyMap = map[string]KeyParams{
	"Enter":      {Key: "Enter", Code: "Enter", KeyCode: 13},
	"Tab":        {Key: "Tab", Code: "Tab", KeyCode: 9},
	"Escape":     {Key: "Escape", Code: "Escape", KeyCode: 27},
	"Backspace":  {Key: "Backspace", Code: "Backspace", KeyCode: 8},
	"Delete":     {Key: "Delete", Code: "Delete", KeyCode: 46},
	"Space":      {Key: " ", Code: "Space", KeyCode: 32},
	" ":          {Key: " ", Code: "Space", KeyCode: 32},
	"ArrowLeft":  {Key: "ArrowLeft", Code: "ArrowLeft", KeyCode: 37},
	"ArrowUp":    {Key: "ArrowUp", Code: "ArrowUp", KeyCode: 38},
	"ArrowRight": {Key: "ArrowRight", Code: "ArrowRight", KeyCode: 39},
	"ArrowDown":  {Key: "ArrowDown", Code: "ArrowDown", KeyCode: 40},
	"Home":       {Key: "Home", Code: "Home", KeyCode: 36},
	"End":        {Key: "End", Code: "End", KeyCode: 35},
	"PageUp":     {Key: "PageUp", Code: "PageUp", KeyCode: 33},
	"PageDown":   {Key: "PageDown", Code: "PageDown", KeyCode: 34},
}

// getKeyParams returns the KeyParams for a named key.
func getKeyParams(keyName string) KeyParams {
	if p, ok := keyMap[keyName]; ok {
		return p
	}
	return KeyParams{Key: keyName, Code: keyName, KeyCode: 0}
}
