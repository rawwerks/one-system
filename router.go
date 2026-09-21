package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

//go:embed schema/typesafe.openapi.json
var officialOpenAPI []byte

//go:embed contract/backend-selection.question.json
var backendSelectionQuestion []byte

const (
	maxBodyBytes      = 8 << 20
	selectorID        = "backend"
	officialSchemaURL = "https://one-system.invalid/typesafe.openapi.json"
)

type router struct {
	config           config
	client           *http.Client
	logger           *slog.Logger
	requestSchema    *jsonschema.Schema
	responseSchema   *jsonschema.Schema
	modelsJSON       []byte
	capabilitiesJSON []byte
	keyHash          [32]byte
	selectorTemplate map[string]json.RawMessage
}

type tokenUsage struct {
	Input  int64 `json:"input_tokens"`
	Output int64 `json:"output_tokens"`
}

type upstreamResponse struct {
	raw     map[string]json.RawMessage
	answers map[string]json.RawMessage
	usage   tokenUsage
}

type apiError struct {
	status  int
	code    string
	message string
}

func officialSchemaCompiler() (*jsonschema.Compiler, error) {
	var document any
	if err := decodeJSON(officialOpenAPI, &document); err != nil {
		return nil, err
	}
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	if err := compiler.AddResource(officialSchemaURL, document); err != nil {
		return nil, err
	}
	return compiler, nil
}

func newRouter(c config, logger *slog.Logger) (*router, error) {
	compiler, err := officialSchemaCompiler()
	if err != nil {
		return nil, err
	}
	request, err := compiler.Compile(officialSchemaURL + "#/components/schemas/SystemOneRequest")
	if err != nil {
		return nil, err
	}
	response, err := compiler.Compile(officialSchemaURL + "#/components/schemas/SystemOneResponse")
	if err != nil {
		return nil, err
	}
	models, err := compiler.Compile(officialSchemaURL + "#/components/schemas/ModelMetadataList")
	if err != nil {
		return nil, err
	}
	entries := []any{map[string]string{
		"name":         c.name,
		"description":  "A SystemOne Choice selects the configured TypeSafe-compatible backend best suited to the supplied state and questions.",
		"release_date": "2026-09-19",
	}}
	ids := make([]string, 0, len(c.backends))
	for id := range c.backends {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	profiles := make([]any, 0, len(ids))
	for _, id := range ids {
		b := c.backends[id]
		entries = append(entries, map[string]string{"name": id, "description": b.Description, "release_date": "2026-09-20"})
		profiles = append(profiles, map[string]any{"name": id, "capabilities": b.Capabilities})
	}
	catalogue, err := json.Marshal(map[string]any{"models": entries})
	if err != nil {
		return nil, err
	}
	if err := validateJSON(models, catalogue); err != nil {
		return nil, err
	}
	capabilitiesJSON, err := json.Marshal(map[string]any{"version": 1, "models": profiles})
	if err != nil {
		return nil, err
	}
	choice, err := compiler.Compile(officialSchemaURL + "#/components/schemas/ChoiceQuestion")
	if err != nil {
		return nil, err
	}
	if err := validateJSON(choice, backendSelectionQuestion); err != nil {
		return nil, err
	}
	var selectorTemplate map[string]json.RawMessage
	if err := decodeJSON(backendSelectionQuestion, &selectorTemplate); err != nil {
		return nil, err
	}
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          16,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 180 * time.Second,
	}
	return &router{
		config: c, logger: logger, requestSchema: request, responseSchema: response,
		modelsJSON: catalogue, capabilitiesJSON: capabilitiesJSON, keyHash: sha256.Sum256([]byte("Bearer " + c.publicKey)),
		selectorTemplate: selectorTemplate,
		client: &http.Client{
			Transport: transport, Timeout: 180 * time.Second,
			// Never forward any bearer key to an upstream redirect destination.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}, nil
}

func decodeJSON(data []byte, dst any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(dst); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("expected one JSON value")
	}
	return nil
}

func validateJSON(schema *jsonschema.Schema, data []byte) error {
	var value any
	if err := decodeJSON(data, &value); err != nil {
		return err
	}
	return schema.Validate(value)
}

func (r *router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	var method string
	switch req.URL.Path {
	case "/v1/models", "/v1/capabilities":
		method = http.MethodGet
	case "/v1/systemone":
		method = http.MethodPost
	default:
		writeAPIError(w, apiError{404, "not_found", "Endpoint not found"})
		return
	}
	provided := sha256.Sum256([]byte(req.Header.Get("Authorization")))
	if subtle.ConstantTimeCompare(provided[:], r.keyHash[:]) != 1 {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeAPIError(w, apiError{401, "unauthorized", "A valid bearer API key is required"})
		return
	}
	if req.Method != method {
		w.Header().Set("Allow", method)
		writeAPIError(w, apiError{405, "method_not_allowed", "Method not allowed"})
		return
	}
	if method == http.MethodGet {
		if req.URL.Path == "/v1/capabilities" {
			_, _ = w.Write(r.capabilitiesJSON)
			return
		}
		_, _ = w.Write(r.modelsJSON)
		return
	}
	r.systemOne(w, req)
}

func (r *router) systemOne(w http.ResponseWriter, req *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, req.Body, maxBodyBytes))
	if err != nil {
		writeAPIError(w, apiError{422, "invalid_body", "Request body is unreadable or exceeds 8 MiB"})
		return
	}
	if err := validateJSON(r.requestSchema, body); err != nil {
		writeAPIError(w, apiError{422, "schema_validation", "Request does not match the official SystemOneRequest schema"})
		return
	}
	var original map[string]json.RawMessage
	var model string
	var questions map[string]json.RawMessage
	if decodeJSON(body, &original) != nil || json.Unmarshal(original["model"], &model) != nil || json.Unmarshal(original["questions"], &questions) != nil {
		writeAPIError(w, apiError{422, "invalid_request", "Request could not be decoded"})
		return
	}
	if _, exists := r.config.backends[model]; model != r.config.name && !exists {
		writeAPIError(w, apiError{422, "unsupported_model", "Unknown model; see GET /v1/models"})
		return
	}
	ctx, cancel := context.WithTimeout(req.Context(), 300*time.Second)
	defer cancel()
	started := time.Now()
	decision := struct {
		Choice     string   `json:"choice"`
		Confidence *float64 `json:"confidence"`
	}{Choice: r.config.selector}
	var selectionUsage tokenUsage
	shapes := questionShapes(questions)
	var eligible []string
	if model == r.config.name {
		eligible = r.eligibleBackends(original["state"], shapes)
	} else {
		if r.config.backends[model].supports(original["state"], shapes) {
			eligible = []string{model}
		}
	}
	if len(eligible) == 0 {
		writeAPIError(w, apiError{422, "unsupported_capability", "No requested backend supports these inputs"})
		return
	}
	if len(eligible) == 1 {
		// One representable destination: selection cannot change the outcome.
		decision.Choice = eligible[0]
		decision.Confidence = nil
	}
	if len(eligible) > 1 {
		var selector map[string]any
		var selectorQuestions map[string]json.RawMessage
		if r.config.selection != nil {
			selector, selectorQuestions = r.featureRequest(questions)
		} else {
			disclose := r.config.selector == r.config.fallback
			var err error
			selector, selectorQuestions, err = r.selectionRequest(original["state"], questions, eligible, disclose)
			if err != nil {
				writeAPIError(w, apiError{500, "selector_request", "Could not construct the selector request"})
				return
			}
		}
		selectorBackend := r.config.backends[r.config.selector]
		if !selectorBackend.supports(selector["state"], questionShapes(selectorQuestions)) {
			writeAPIError(w, apiError{422, "unsupported_capability", "Selector does not support the routing request"})
			return
		}
		selected, failure := r.call(ctx, selectorBackend.BaseURL, selectorBackend.key, selector, selectorQuestions)
		if failure != nil {
			// A privacy router must not disclose the state because routing broke.
			// Failing closed onto the fallback keeps the request on the private
			// backend; without one there is no safe default, so surface the error.
			if r.config.fallback == "" {
				r.logger.Warn("selector_failed", "status", failure.status, "latency_ms", time.Since(started).Milliseconds())
				writeAPIError(w, *failure)
				return
			}
			r.logger.Warn("selector_failed_closed", "status", failure.status,
				"fallback", r.config.fallback, "latency_ms", time.Since(started).Milliseconds())
			decision.Choice = r.config.fallback
			decision.Confidence = nil
		} else if r.config.selection != nil {
			selectionUsage = selected.usage
			decision.Choice = r.config.fallback
			decision.Confidence = nil
			if fired, rule := r.escalates(selected.answers); fired {
				decision.Choice = r.config.selection.EscalateTo
				r.logger.Info("escalated", "rule", rule, "to", decision.Choice)
			}
		} else {
			if json.Unmarshal(selected.answers[selectorID], &decision) != nil || decision.Confidence == nil || *decision.Confidence < 0 || *decision.Confidence > 1 {
				writeAPIError(w, apiError{502, "invalid_selector", "Upstream returned an invalid backend selection"})
				return
			}
			selectionUsage = selected.usage
			// Escalating away from the fallback backend is irreversible: it discloses
			// the caller's state to another operator. Require positive evidence.
			if r.config.fallback != "" && decision.Choice != r.config.fallback && *decision.Confidence < r.config.escalationConfidence {
				r.logger.Info("escalation_withheld", "proposed", decision.Choice,
					"confidence", *decision.Confidence, "threshold", r.config.escalationConfidence,
					"fallback", r.config.fallback)
				decision.Choice = r.config.fallback
			}
		}
	}
	destination, exists := r.config.backends[decision.Choice]
	if !exists {
		writeAPIError(w, apiError{502, "invalid_selector", "Upstream selected an unconfigured backend"})
		return
	}
	if !destination.supports(original["state"], shapes) {
		writeAPIError(w, apiError{422, "unsupported_capability", "Selected backend does not support these inputs"})
		return
	}
	// Only model changes; opaque IDs, structured criteria, and number lexemes survive.
	original["model"], _ = json.Marshal(destination.Model)
	leaf, failure := r.call(ctx, destination.BaseURL, destination.key, original, questions)
	status := http.StatusOK
	if failure != nil {
		status = failure.status
	}
	r.logger.Info("route", "backend", decision.Choice, "selector_choice", decision.Choice,
		"selector_confidence", decision.Confidence, "selector_skipped", len(eligible) == 1,
		"eligible", eligible,
		"latency_ms", time.Since(started).Milliseconds(), "status", status)
	if failure != nil {
		writeAPIError(w, *failure)
		return
	}
	if selectionUsage.Input > math.MaxInt64-leaf.usage.Input || selectionUsage.Output > math.MaxInt64-leaf.usage.Output {
		writeAPIError(w, apiError{502, "invalid_usage", "Upstream token usage cannot be aggregated"})
		return
	}
	var usage map[string]json.RawMessage
	_ = json.Unmarshal(leaf.raw["usage"], &usage)
	usage["input_tokens"], _ = json.Marshal(selectionUsage.Input + leaf.usage.Input)
	usage["output_tokens"], _ = json.Marshal(selectionUsage.Output + leaf.usage.Output)
	leaf.raw["usage"], _ = json.Marshal(usage)
	response, err := json.Marshal(leaf.raw)
	if err != nil || validateJSON(r.responseSchema, response) != nil {
		writeAPIError(w, apiError{502, "invalid_response", "Upstream response cannot be returned as SystemOneResponse"})
		return
	}
	_, _ = w.Write(response)
}

func (r *router) selectionRequest(state json.RawMessage, questions map[string]json.RawMessage, eligible []string, disclose bool) (map[string]any, map[string]json.RawMessage, error) {
	capabilities := make(map[string]string, len(eligible))
	for _, id := range eligible {
		capabilities[id] = r.config.backends[id].Description
	}
	template := make(map[string]any, len(r.selectorTemplate))
	for key, value := range r.selectorTemplate {
		template[key] = value
	}
	template["criteria"] = capabilities
	question, err := json.Marshal(template)
	if err != nil {
		return nil, nil, err
	}
	selectorQuestions := map[string]json.RawMessage{selectorID: question}
	// A distinct selector receives definitions and a content-free state summary.
	// Definitions may still contain private criteria or interpolated instructions;
	// callers must approve those fields for the configured selector.
	// When selector and fallback coincide, use raw state alone: extra question
	// schemas can crowd out the input and overrun a small model's context budget.
	// Capability descriptions stay in criteria, not in the evidence being scored.
	var selectorState any = state
	if !disclose {
		ids := make([]string, 0, len(questions))
		for id := range questions {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		definitions := make([]json.RawMessage, 0, len(questions))
		for _, id := range ids {
			definitions = append(definitions, questions[id])
		}
		selectorState = map[string]any{
			"question_definitions": definitions,
			"input_summary":        summarizeState(state),
		}
	}
	return map[string]any{
		"model":     r.config.backends[r.config.selector].Model,
		"state":     selectorState,
		"questions": selectorQuestions,
	}, selectorQuestions, nil
}

// taskText joins caller question instructions without the original state.
// Instructions can contain interpolated private data; they are not inherently public.
func taskText(questions map[string]json.RawMessage) string {
	ids := make([]string, 0, len(questions))
	for id := range questions {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	parts := make([]string, 0, len(ids))
	for _, id := range ids {
		var q struct {
			Instructions json.RawMessage `json:"instructions"`
		}
		if json.Unmarshal(questions[id], &q) != nil || len(q.Instructions) == 0 {
			continue
		}
		var text string
		if json.Unmarshal(q.Instructions, &text) != nil {
			text = string(q.Instructions)
		}
		if text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, " ")
}

// featureRequest asks the selector the configured routing questions about the
// task. Asking a small model to name a backend is out of distribution; asking
// it concrete questions about the work is what it was trained for, so the
// routing policy itself stays in code.
func (r *router) featureRequest(questions map[string]json.RawMessage) (map[string]any, map[string]json.RawMessage) {
	return map[string]any{
		"model":     r.config.backends[r.config.selector].Model,
		"state":     map[string]any{"request": taskText(questions)},
		"questions": r.config.selection.questions,
	}, r.config.selection.questions
}

// escalates reports whether any rule fired. Unreadable answers never escalate:
// the privacy-preserving default must not depend on parsing luck.
func (r *router) escalates(answers map[string]json.RawMessage) (bool, string) {
	for _, rule := range r.config.selection.Rules {
		raw, ok := answers[rule.Question]
		if !ok {
			continue
		}
		var answer struct {
			Type          string             `json:"type"`
			Noul          float64            `json:"noul"`
			Score         float64            `json:"score"`
			Probabilities map[string]float64 `json:"probabilities"`
		}
		if json.Unmarshal(raw, &answer) != nil {
			continue
		}
		var value float64
		switch answer.Type {
		case "choice":
			value = answer.Probabilities[rule.Choice]
		case "noul":
			value = answer.Noul
		case "score":
			value = answer.Score
		default:
			continue
		}
		if value > rule.Above {
			return true, rule.Question
		}
	}
	return false, ""
}

// true-up:anchor id=hard-capability-check
type questionShape struct {
	kind     string
	criteria int
}

// Read schema-defined keys exactly once from validated questions. A struct
// decoder would let extra fields such as Type or Criteria override those keys.
// Routing uses these facts; forwarding retains the original JSON unchanged.
func questionShapes(questions map[string]json.RawMessage) []questionShape {
	shapes := make([]questionShape, 0, len(questions))
	for _, raw := range questions {
		var fields map[string]json.RawMessage
		var q questionShape
		if json.Unmarshal(raw, &fields) == nil {
			_ = json.Unmarshal(fields["type"], &q.kind)
			var named map[string]json.RawMessage
			var ordered []json.RawMessage
			if json.Unmarshal(fields["criteria"], &named) == nil {
				q.criteria = len(named)
			} else if json.Unmarshal(fields["criteria"], &ordered) == nil {
				q.criteria = len(ordered)
			}
		}
		shapes = append(shapes, q)
	}
	return shapes
}

func (b backend) supports(state any, questions []questionShape) bool {
	c := b.Capabilities
	if c == nil {
		return true
	}
	if c.MaxQuestions != nil && len(questions) > *c.MaxQuestions {
		return false
	}
	if c.StructuredState != nil && !*c.StructuredState {
		// Caller state is RawMessage; internally constructed selector state can
		// be an object. Inspect its shape without a serialization round trip.
		isString := false
		switch value := state.(type) {
		case string:
			isString = true
		case json.RawMessage:
			value = bytes.TrimSpace(value)
			isString = len(value) > 0 && value[0] == '"'
		}
		if !isString {
			return false
		}
	}
	for _, q := range questions {
		allowed := false
		for _, kind := range c.QuestionTypes {
			if kind == q.kind {
				allowed = true
			}
		}
		if !allowed {
			return false
		}
		if q.kind == "noul" {
			continue
		}
		if c.MinCriteria != nil && q.criteria < *c.MinCriteria {
			return false
		}
		if c.MaxCriteria != nil && q.criteria > *c.MaxCriteria {
			return false
		}
	}
	return true
}

// true-up:end id=hard-capability-check

// Hard constraints apply first; soft preferences can only restore capable backends.
// Sorted so the selector's option order is stable across requests.
func (r *router) eligibleBackends(state json.RawMessage, questions []questionShape) []string {
	summary := summarizeState(state)
	widest := 0
	for _, q := range questions {
		widest = max(widest, q.criteria)
	}
	eligible := make([]string, 0, len(r.config.backends))
	capable := make([]string, 0, len(r.config.backends))
	for id, b := range r.config.backends {
		if !b.supports(state, questions) {
			continue
		}
		capable = append(capable, id)
		if b.Limits != nil {
			if b.Limits.MaxCharacters != nil && summary.Characters > *b.Limits.MaxCharacters {
				continue
			}
			if f := b.Limits.MaxNonASCIILetterFraction; f != nil && summary.NonASCIILetterFraction > *f {
				continue
			}
			if b.Limits.MaxQuestions != nil && len(questions) > *b.Limits.MaxQuestions {
				continue
			}
			if b.Limits.MaxCriteria != nil && widest > *b.Limits.MaxCriteria {
				continue
			}
		}
		eligible = append(eligible, id)
	}
	if len(eligible) == 0 {
		eligible = capable
	}
	sort.Strings(eligible)
	return eligible
}

// summarizeState derives non-identifying metadata about the caller's state so
// the selector can route on size and script without ever receiving the content.
// stateSummary is non-identifying metadata: shape and size, never content.
type stateSummary struct {
	Characters             int     `json:"characters"`
	NonASCIILetterFraction float64 `json:"non_ascii_letter_fraction"`
}

func summarizeState(state json.RawMessage) stateSummary {
	// Measure the compacted form: insignificant whitespace must not change a
	// routing decision, or the same request would route differently depending
	// on how the caller happened to format its JSON.
	var compact bytes.Buffer
	text := string(state)
	if json.Compact(&compact, state) == nil {
		text = compact.String()
	}
	runes := []rune(text)
	var letters, nonASCII int
	for _, c := range runes {
		if !unicode.IsLetter(c) {
			continue
		}
		letters++
		if c > unicode.MaxASCII {
			nonASCII++
		}
	}
	fraction := 0.0
	if letters > 0 {
		fraction = math.Round(float64(nonASCII)/float64(letters)*100) / 100
	}
	return stateSummary{Characters: len(runes), NonASCIILetterFraction: fraction}
}

func (r *router) call(ctx context.Context, base, key string, payload any, questions map[string]json.RawMessage) (*upstreamResponse, *apiError) {
	body, err := json.Marshal(payload)
	if err != nil || validateJSON(r.requestSchema, body) != nil {
		return nil, &apiError{500, "invalid_internal_request", "Could not construct a valid upstream request"}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/systemone", bytes.NewReader(body))
	if err != nil {
		return nil, &apiError{500, "upstream_configuration", "Upstream configuration is invalid"}
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := r.client.Do(req)
	if err != nil {
		return nil, &apiError{502, "upstream_unavailable", "Upstream request failed"}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		status := resp.StatusCode
		// Fetch turns proxy-authentication responses into network failures.
		// Use that same public error when a host exposes the status directly.
		if status == http.StatusProxyAuthRequired {
			return nil, &apiError{502, "upstream_unavailable", "Upstream request failed"}
		}
		// Authentication failures describe our upstream credentials, not the caller's.
		// Neither does 400: every upstream request is schema-validated before it is
		// sent, so a malformed-request rejection can only mean the upstream disagrees
		// about something this router chose, such as the configured model name.
		// 422 is left alone because it genuinely describes the caller's content.
		if status < 400 || status > 599 || status == 400 || status == 401 || status == 403 {
			status = http.StatusBadGateway
		}
		return nil, &apiError{status, "upstream_rejected", "Upstream could not complete the request"}
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes+1))
	if err != nil || len(data) > maxBodyBytes || validateJSON(r.responseSchema, data) != nil {
		return nil, &apiError{502, "invalid_upstream_response", "Upstream returned an invalid SystemOneResponse"}
	}
	result := &upstreamResponse{}
	if json.Unmarshal(data, &result.raw) != nil || json.Unmarshal(result.raw["answers"], &result.answers) != nil || json.Unmarshal(result.raw["usage"], &result.usage) != nil || result.usage.Input < 0 || result.usage.Output < 0 {
		return nil, &apiError{502, "invalid_upstream_response", "Upstream returned invalid answers or token usage"}
	}
	if !answersMatch(questions, result.answers) {
		return nil, &apiError{502, "mismatched_answers", "Upstream answers do not match the requested question IDs, types, or choices"}
	}
	return result, nil
}

func answersMatch(questions, answers map[string]json.RawMessage) bool {
	if len(questions) != len(answers) {
		return false
	}
	for id, rawQuestion := range questions {
		rawAnswer, ok := answers[id]
		if !ok {
			return false
		}
		var question struct {
			Type     string          `json:"type"`
			Criteria json.RawMessage `json:"criteria"`
		}
		var answer struct {
			Type   string `json:"type"`
			Choice string `json:"choice"`
		}
		if json.Unmarshal(rawQuestion, &question) != nil || json.Unmarshal(rawAnswer, &answer) != nil || question.Type != answer.Type {
			return false
		}
		if question.Type == "choice" {
			var criteria map[string]json.RawMessage
			if json.Unmarshal(question.Criteria, &criteria) != nil {
				return false
			}
			if _, ok := criteria[answer.Choice]; !ok {
				return false
			}
		}
	}
	return true
}

func writeAPIError(w http.ResponseWriter, failure apiError) {
	w.WriteHeader(failure.status)
	// Never serialize schema diagnostics or raw upstream errors: they contain inputs.
	_ = json.NewEncoder(w).Encode(map[string]any{"detail": []any{map[string]any{
		"loc": []string{"body"}, "msg": failure.message, "type": failure.code,
	}}})
}
