package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

// limits are legacy soft routing preferences. capabilities are hard constraints.
type limits struct {
	MaxCharacters             *int     `json:"max_characters"`
	MaxNonASCIILetterFraction *float64 `json:"max_non_ascii_letter_fraction"`
	// Capability also depends on the questions, not just the state: a backend
	// can be handed a small input with a rubric it cannot represent.
	MaxQuestions *int `json:"max_questions"`
	MaxCriteria  *int `json:"max_criteria"`
}

type backend struct {
	ID           string        `json:"id"`
	BaseURL      string        `json:"base_url"`
	Model        string        `json:"model"`
	APIKeyEnv    string        `json:"api_key_env"`
	Description  string        `json:"description"`
	Limits       *limits       `json:"limits"`
	Capabilities *capabilities `json:"capabilities"`
	key          string
}

// Omitted capabilities are unknown, not a certification of universal support.
// Tokenizer- and prompt-specific limits remain the native adapter's responsibility.
type capabilities struct {
	QuestionTypes   []string `json:"question_types"`
	MaxQuestions    *int     `json:"max_questions,omitempty"`
	MinCriteria     *int     `json:"min_criteria,omitempty"`
	MaxCriteria     *int     `json:"max_criteria,omitempty"`
	StructuredState *bool    `json:"structured_state,omitempty"`
}

func (c *capabilities) validate() error {
	if c == nil {
		return nil
	}
	seen := map[string]bool{}
	for _, kind := range c.QuestionTypes {
		if (kind != "choice" && kind != "score" && kind != "noul") || seen[kind] {
			return errors.New("capabilities require unique native question types")
		}
		seen[kind] = true
	}
	if len(seen) == 0 {
		return errors.New("capabilities require nonempty question_types")
	}
	for _, limit := range []*int{c.MaxQuestions, c.MinCriteria, c.MaxCriteria} {
		if limit != nil && *limit < 1 {
			return errors.New("capability limits must be positive integers")
		}
	}
	if c.MinCriteria != nil && c.MaxCriteria != nil && *c.MinCriteria > *c.MaxCriteria {
		return errors.New("min_criteria must not exceed max_criteria")
	}
	return nil
}

// selectionRule turns one answer from the routing questions into an escalation
// vote. Choice answers test the probability of a named choice; noul and score
// answers test their own value.
type selectionRule struct {
	Question string  `json:"question"`
	Choice   string  `json:"choice"`
	Above    float64 `json:"above"`
}

// featureSelection asks concrete questions about the caller's task instructions,
// without forwarding the original state. Callers must approve any private data
// interpolated into those instructions for the configured selector.
type featureSelection struct {
	QuestionsFile string          `json:"questions_file"`
	EscalateTo    string          `json:"escalate_to"`
	Rules         []selectionRule `json:"rules"`
	questions     map[string]json.RawMessage
}

type config struct {
	name      string
	addr      string
	publicKey string
	selector  string
	// fallback is the privacy-preserving destination. Escalating away from it
	// is the irreversible direction, so it requires positive evidence.
	fallback             string
	escalationConfidence float64
	selection            *featureSelection
	backends             map[string]backend
	cache                cacheSettings
	log                  logSettings
}

func envDefault(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func validModelID(id string) bool {
	if id == "" {
		return false
	}
	for _, char := range id {
		if !((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '-' || char == '_') {
			return false
		}
	}
	return true
}

const maxConfigBytes = 1 << 20

func readConfigFile(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxConfigBytes+1))
	if err != nil || len(data) > maxConfigBytes {
		return nil, errors.New("configuration is unreadable or exceeds 1 MiB")
	}
	return data, nil
}

func loadConfig() (config, error) {
	c := config{
		addr:      envDefault("ONE_SYSTEM_ADDR", "127.0.0.1:8090"),
		publicKey: os.Getenv("ONE_SYSTEM_API_KEY"),
		backends:  make(map[string]backend),
	}
	if !validKey(c.publicKey) {
		return config{}, errors.New("ONE_SYSTEM_API_KEY must contain a nonempty bearer key without whitespace")
	}
	var err error
	c.cache, err = loadCacheSettings()
	if err != nil {
		return config{}, err
	}
	c.log, err = loadLogSettings()
	if err != nil {
		return config{}, err
	}
	data, err := readConfigFile(envDefault("ONE_SYSTEM_CONFIG", "backends.json"))
	if err != nil {
		return config{}, errors.New("could not open ONE_SYSTEM_CONFIG")
	}
	var registry struct {
		Name                 string            `json:"name"`
		Selector             string            `json:"selector"`
		Fallback             string            `json:"fallback"`
		EscalationConfidence *float64          `json:"escalation_confidence"`
		Selection            *featureSelection `json:"selection"`
		Backends             []backend         `json:"backends"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&registry); err != nil {
		return config{}, errors.New("backend configuration must contain name, selector, and backends")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return config{}, errors.New("backend configuration must contain one JSON document")
	}
	if !validModelID(registry.Name) {
		return config{}, errors.New("configuration name must contain only ASCII letters, digits, hyphens, or underscores")
	}
	c.name = registry.Name
	if len(registry.Backends) == 0 {
		return config{}, errors.New("backend configuration requires at least one backend")
	}
	for _, b := range registry.Backends {
		if b.ID == c.name {
			return config{}, errors.New("backend ID must differ from the configuration name")
		}
		if err := b.Capabilities.validate(); err != nil {
			return config{}, err
		}
		if b.ID == "" || b.Model == "" || b.Description == "" || b.APIKeyEnv == "" {
			return config{}, errors.New("every backend requires id, model, description, and api_key_env")
		}
		if !validModelID(b.ID) {
			return config{}, errors.New("backend IDs must contain only ASCII letters, digits, hyphens, or underscores")
		}
		if _, exists := c.backends[b.ID]; exists {
			return config{}, errors.New("backend IDs must be unique")
		}
		b.key = os.Getenv(b.APIKeyEnv)
		if !validKey(b.key) {
			return config{}, errors.New("a backend api_key_env must reference a nonempty bearer key without whitespace")
		}
		u, err := url.Parse(b.BaseURL)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && u.Scheme != "http") {
			return config{}, errors.New("backend base_url must use HTTP(S) without credentials, query, or fragment")
		}
		if u.Scheme == "http" {
			ip := net.ParseIP(u.Hostname())
			if u.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback()) {
				return config{}, errors.New("backend base_url requires HTTPS except for loopback hosts")
			}
		}
		if b.Limits != nil {
			if b.Limits.MaxCharacters != nil && *b.Limits.MaxCharacters < 1 {
				return config{}, errors.New("a backend max_characters must be a positive integer")
			}
			if f := b.Limits.MaxNonASCIILetterFraction; f != nil && (*f < 0 || *f > 1) {
				return config{}, errors.New("a backend max_non_ascii_letter_fraction must fall between 0 and 1")
			}
			if b.Limits.MaxQuestions != nil && *b.Limits.MaxQuestions < 1 {
				return config{}, errors.New("a backend max_questions must be a positive integer")
			}
			if b.Limits.MaxCriteria != nil && *b.Limits.MaxCriteria < 2 {
				return config{}, errors.New("a backend max_criteria must be at least 2")
			}
		}
		b.BaseURL = strings.TrimRight(b.BaseURL, "/")
		c.backends[b.ID] = b
	}
	if _, exists := c.backends[registry.Selector]; !exists {
		return config{}, errors.New("selector must name a configured backend ID")
	}
	c.selector = registry.Selector
	if registry.Fallback != "" {
		if _, exists := c.backends[registry.Fallback]; !exists {
			return config{}, errors.New("fallback must name a configured backend ID")
		}
		c.fallback = registry.Fallback
	}
	if registry.EscalationConfidence != nil {
		if c.fallback == "" {
			return config{}, errors.New("escalation_confidence requires a fallback backend ID")
		}
		if *registry.EscalationConfidence < 0 || *registry.EscalationConfidence > 1 {
			return config{}, errors.New("escalation_confidence must fall between 0 and 1")
		}
		c.escalationConfidence = *registry.EscalationConfidence
	}
	if registry.Selection != nil {
		sel := registry.Selection
		if c.fallback == "" {
			return config{}, errors.New("selection requires a fallback backend ID")
		}
		if _, exists := c.backends[sel.EscalateTo]; !exists {
			return config{}, errors.New("selection escalate_to must name a configured backend ID")
		}
		if sel.EscalateTo == c.fallback {
			return config{}, errors.New("selection escalate_to must differ from the fallback backend")
		}
		if len(sel.Rules) == 0 {
			return config{}, errors.New("selection requires at least one rule")
		}
		raw, err := readConfigFile(sel.QuestionsFile)
		if err != nil {
			return config{}, errors.New("could not read selection questions_file")
		}
		if json.Unmarshal(raw, &sel.questions) != nil || len(sel.questions) == 0 {
			return config{}, errors.New("selection questions_file must contain a SystemOne questions object")
		}
		compiler, err := officialSchemaCompiler()
		if err != nil {
			return config{}, errors.New("could not initialize official API schemas")
		}
		questionSchema, err := compiler.Compile(officialSchemaURL + "#/components/schemas/Question")
		if err != nil {
			return config{}, errors.New("could not initialize official question schema")
		}
		for _, question := range sel.questions {
			if validateJSON(questionSchema, question) != nil {
				return config{}, errors.New("selection questions_file must contain valid SystemOne questions")
			}
		}
		for _, rule := range sel.Rules {
			question, exists := sel.questions[rule.Question]
			if !exists {
				return config{}, errors.New("every selection rule must name a question from questions_file")
			}
			var definition struct {
				Type     string                     `json:"type"`
				Criteria map[string]json.RawMessage `json:"criteria"`
			}
			// Decode criteria only for Choice questions; Score uses an array.
			var fields map[string]json.RawMessage
			_ = json.Unmarshal(question, &fields)
			_ = json.Unmarshal(fields["type"], &definition.Type)
			if definition.Type == "choice" {
				_ = json.Unmarshal(fields["criteria"], &definition.Criteria)
				if _, exists := definition.Criteria[rule.Choice]; !exists {
					return config{}, errors.New("every Choice selection rule must name a configured criterion")
				}
			}
			if rule.Above < 0 || rule.Above > 1 {
				return config{}, errors.New("every selection rule threshold must fall between 0 and 1")
			}
		}
		c.selection = sel
	}
	return c, nil
}

func validKey(key string) bool {
	return key != "" && !strings.ContainsAny(key, " \t\r\n")
}

func run(logger *slog.Logger) error {
	c, err := loadConfig()
	if err != nil {
		return err
	}
	router, err := newRouter(c, logger)
	if err != nil {
		return errors.New("could not initialize router schemas or persistence")
	}
	defer router.Close()
	server := &http.Server{
		Addr:              c.addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      310 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
		ErrorLog:          log.New(io.Discard, "", 0),
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	listener, err := net.Listen("tcp", c.addr)
	if err != nil {
		return errors.New("could not listen on ONE_SYSTEM_ADDR")
	}
	result := make(chan error, 1)
	go func() { result <- server.Serve(listener) }()
	logger.Info("listening", "service", "one-system")
	select {
	case err := <-result:
		if !errors.Is(err, http.ErrServerClosed) {
			return errors.New("HTTP server stopped unexpectedly")
		}
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			_ = server.Close()
		}
	}
	return nil
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if err := run(logger); err != nil {
		logger.Error("startup failed", "reason", err.Error())
		os.Exit(1)
	}
}
