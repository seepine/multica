package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/service"
)

func setHandlerTestRuntimeCLIVersion(t *testing.T, version string) {
	t.Helper()
	if _, err := testPool.Exec(context.Background(), `
		UPDATE agent_runtime
		SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{cli_version}', to_jsonb($2::text), true)
		WHERE id = $1
	`, handlerTestRuntimeID(t), version); err != nil {
		t.Fatalf("set runtime cli_version: %v", err)
	}
}

func TestQuickCreateIssue_StoresProjectID(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	setHandlerTestRuntimeCLIVersion(t, "0.2.24")
	agentID := createHandlerTestAgent(t, "Quick Create Test Agent", nil)

	// Create a test project in the workspace
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/projects?workspace_id="+testWorkspaceID, map[string]any{
		"title": "Quick Create Test Project",
	})
	testHandler.CreateProject(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateProject: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var createdProject struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(w.Body).Decode(&createdProject); err != nil {
		t.Fatalf("decode project response: %v", err)
	}
	projectID := createdProject.ID
	t.Cleanup(func() {
		req := newRequest("DELETE", "/api/projects/"+projectID, nil)
		req = withURLParam(req, "id", projectID)
		testHandler.DeleteProject(httptest.NewRecorder(), req)
	})

	w = httptest.NewRecorder()
	req = newRequest(http.MethodPost, "/api/issues/quick-create", map[string]any{
		"agent_id":   agentID,
		"prompt":     "Create a follow-up issue",
		"project_id": projectID,
	})
	testHandler.QuickCreateIssue(w, req)
	if w.Code != http.StatusAccepted {
		t.Fatalf("QuickCreateIssue: expected 202, got %d: %s", w.Code, w.Body.String())
	}

	var resp QuickCreateIssueResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	var contextJSON []byte
	if err := testPool.QueryRow(ctx, `SELECT context FROM agent_task_queue WHERE id = $1`, resp.TaskID).Scan(&contextJSON); err != nil {
		t.Fatalf("load queued task context: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE id = $1`, resp.TaskID)
	})

	var qc service.QuickCreateContext
	if err := json.Unmarshal(contextJSON, &qc); err != nil {
		t.Fatalf("unmarshal quick-create context: %v", err)
	}
	if qc.Type != service.QuickCreateContextType {
		t.Fatalf("context type = %q, want %q", qc.Type, service.QuickCreateContextType)
	}
	if qc.ProjectID != projectID {
		t.Fatalf("context project_id = %q, want %s", qc.ProjectID, projectID)
	}
}

func TestQuickCreateIssue_RejectsInvalidProjectID(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	setHandlerTestRuntimeCLIVersion(t, "0.2.24")
	agentID := createHandlerTestAgent(t, "Quick Create Validation Agent", nil)

	tests := []struct {
		name string
		body map[string]any
		want string
	}{
		{
			name: "invalid project id",
			body: map[string]any{
				"agent_id":   agentID,
				"prompt":     "Create something",
				"project_id": "not-a-uuid",
			},
			want: "invalid project_id",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			req := newRequest(http.MethodPost, "/api/issues/quick-create", tc.body)
			testHandler.QuickCreateIssue(w, req)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("QuickCreateIssue: expected 400, got %d: %s", w.Code, w.Body.String())
			}
			if body := w.Body.String(); body == "" || !strings.Contains(body, tc.want) {
				t.Fatalf("response body %q does not contain %q", body, tc.want)
			}
		})
	}
}
