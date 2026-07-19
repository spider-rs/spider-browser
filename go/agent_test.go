package spiderbrowser

import (
	"strings"
	"testing"
)

func TestAgentOptionsDefaultScopeIsEmpty(t *testing.T) {
	o := AgentOptions{}
	if o.Scope != "" {
		t.Fatalf("expected zero-value Scope to be empty, got %q", o.Scope)
	}
	if o.Scope == AgentScopePage {
		t.Fatalf("zero-value Scope must not equal AgentScopePage")
	}
}

func TestBuildSystemPromptBrowserScopeUnchanged(t *testing.T) {
	if got := buildSystemPrompt(AgentScopeBrowser); got != SystemPrompt {
		t.Fatalf("browser scope should return SystemPrompt unchanged")
	}
	if got := buildSystemPrompt(""); got != SystemPrompt {
		t.Fatalf("zero-value scope should behave as browser scope")
	}
}

func TestBuildSystemPromptPageScopeAppendsAddendum(t *testing.T) {
	got := buildSystemPrompt(AgentScopePage)
	if len(got) <= len(SystemPrompt) {
		t.Fatalf("page scope should append to SystemPrompt")
	}
	if !strings.Contains(got, "Page Scope") {
		t.Fatalf("page scope prompt missing addendum heading")
	}
}

func TestGuardrailJSIsIdempotentGuarded(t *testing.T) {
	if !strings.Contains(GuardrailJS, "__spiderPageScopeGuard") {
		t.Fatalf("guardrail script missing idempotency guard")
	}
	if !strings.Contains(GuardrailJS, "window.open") {
		t.Fatalf("guardrail script missing window.open override")
	}
	if !strings.Contains(GuardrailJS, `target="_blank"`) {
		t.Fatalf("guardrail script missing target=_blank handling")
	}
}
