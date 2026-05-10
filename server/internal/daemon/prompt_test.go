package daemon

import (
	"strings"
	"testing"
)

func TestBuildQuickCreatePrompt_ExplicitPriority(t *testing.T) {
	task := Task{
		QuickCreatePrompt:   "Fix the login button",
		QuickCreatePriority:  "high",
	}
	got := buildQuickCreatePrompt(task)

	for _, want := range []string{
		"`--priority high`",
		"`--priority high`.\n\n",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("prompt missing %q:\n%s", want, got)
		}
	}

	if strings.Contains(got, `\n`) {
		t.Fatalf("prompt should contain real newlines, got literal \\n:\n%s", got)
	}
	if strings.Contains(got, "Map P0/P1") {
		t.Fatalf("prompt should not include fallback priority guidance when explicit priority is set:\n%s", got)
	}
	if strings.Contains(got, "`--due-date`") || strings.Contains(got, "`--project") {
		t.Fatalf("prompt should not include removed quick-create fields:\n%s", got)
	}
}

func TestBuildQuickCreatePrompt_PriorityOnly(t *testing.T) {
	task := Task{
		QuickCreatePrompt:   "Urgent: server is down",
		QuickCreatePriority: "urgent",
	}
	got := buildQuickCreatePrompt(task)

	if !strings.Contains(got, "`--priority urgent`") {
		t.Fatalf("prompt missing explicit priority flag:\n%s", got)
	}
	if strings.Contains(got, "Map P0/P1") {
		t.Fatalf("prompt should not include fallback priority guidance when explicit priority is set:\n%s", got)
	}
	if strings.Contains(got, "`--due-date`") || strings.Contains(got, "`--project`") {
		t.Fatalf("prompt should not inject unset quick-create flags:\n%s", got)
	}
}

func TestBuildQuickCreatePrompt_NoneSet(t *testing.T) {
	task := Task{QuickCreatePrompt: "Something came up"}
	got := buildQuickCreatePrompt(task)

	if !strings.Contains(got, "Map P0/P1") {
		t.Fatalf("prompt should include fallback priority guidance when no explicit priority is set:\n%s", got)
	}
	if strings.Contains(got, `\n`) {
		t.Fatalf("prompt should contain real newlines, got literal \\n:\n%s", got)
	}
}

// TestBuildQuickCreatePromptProjectPinning verifies that when the user
// pins a project in the quick-create modal, the prompt instructs the agent
// to pass `--project <uuid>` exactly. Without this, the agent would re-read
// the workspace default and silently drop the user's selection — the same
// "I have to retype 'in project X' every time" failure mode the modal
// addition was meant to fix.
func TestBuildQuickCreatePromptProjectPinning(t *testing.T) {
	const projectID = "11111111-2222-3333-4444-555555555555"
	out := buildQuickCreatePrompt(Task{
		QuickCreatePrompt: "fix the login button color",
		ProjectID:         projectID,
		ProjectTitle:      "Web App",
	})
	mustContain := []string{
		"--project \"" + projectID + "\"",
		"Web App",
		"modal selection is authoritative",
	}
	for _, s := range mustContain {
		if !strings.Contains(out, s) {
			t.Errorf("buildQuickCreatePrompt with project missing %q\n--- output ---\n%s", s, out)
		}
	}

	// Without a project, the prompt must keep the legacy "omit" instruction
	// so the agent doesn't accidentally start passing --project on plain
	// quick-create runs.
	plain := buildQuickCreatePrompt(Task{QuickCreatePrompt: "fix the login button color"})
	if !strings.Contains(plain, "**project**: omit") {
		t.Errorf("buildQuickCreatePrompt without project must keep the omit instruction, got:\n%s", plain)
	}
	if strings.Contains(plain, "--project") {
		t.Errorf("buildQuickCreatePrompt without project must NOT mention --project, got:\n%s", plain)
	}
}
