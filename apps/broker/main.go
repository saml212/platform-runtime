// Package main implements the per-tenant PTY-WebSocket broker for
// Rockielab / Pebble ML.
//
// The broker runs inside the rockielab-runtime-multitenant container and
// listens on :7681. It accepts WebSocket connections, validates a
// per-tenant token (constant-time compare), and bridges stdin/stdout/stderr
// of a binary spawned in a PTY (claude / codex / bash) to the WebSocket
// using a small framing protocol described in apps/broker/README.md.
//
// It also exposes /healthz for liveness probes and /spawn for headless
// (non-PTY) one-shot invocations.
package main

import (
	"context"
	"crypto/subtle"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

// Framing scheme (binary WebSocket frames):
//
//   client -> server:
//     0x01 <bytes...>            stdin write
//     0x02 <rows:uint16><cols:uint16>   TTY resize (network byte order)
//
//   server -> client:
//     0x01 <bytes...>            stdout/stderr (combined)
//     0x03 <code:int32>          process exit (network byte order, signed)
const (
	frameStdin  = 0x01
	frameResize = 0x02
	frameStdout = 0x01
	frameExit   = 0x03
)

// allowedBinaries enumerates what /ws will spawn. Anything else is rejected.
var allowedBinaries = map[string]struct{}{
	"claude": {},
	"codex":  {},
	"bash":   {},
}

func brokerToken() string {
	return os.Getenv("BROKER_TENANT_TOKEN")
}

func brokerPort() string {
	if p := os.Getenv("BROKER_PORT"); p != "" {
		return p
	}
	return "7681"
}

// constantTimeStringEq compares two strings without leaking length-equal
// timing differences once both sides are the same length. We tolerate the
// length-mismatch fast-path because callers feed the expected token first.
func constantTimeStringEq(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// jsonError writes the platform's structured error envelope.
func jsonError(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": code, "message": msg},
	})
}

// redact returns a length-only summary, never the value itself.
func redact(s string) string {
	if s == "" {
		return "<empty>"
	}
	return "<redacted len=" + itoa(len(s)) + ">"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// healthHandler returns 200 {"status":"ok"}.
func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"status":"ok"}`))
}

// upgrader is shared across /ws calls.
var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		// The broker sits behind the platform-context proxy; cross-origin
		// is checked there. Accept all here.
		return true
	},
}

// wsHandler accepts a WebSocket, validates the token, and bridges to a PTY.
func wsHandler(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	expected := brokerToken()
	if expected == "" {
		jsonError(w, http.StatusInternalServerError, "broker_token_unset",
			"BROKER_TENANT_TOKEN is not set on this machine")
		return
	}
	if !constantTimeStringEq(token, expected) {
		jsonError(w, http.StatusUnauthorized, "invalid_token",
			"missing or invalid token")
		return
	}

	binary := r.URL.Query().Get("binary")
	if binary == "" {
		binary = "claude"
	}
	if _, ok := allowedBinaries[binary]; !ok {
		jsonError(w, http.StatusBadRequest, "invalid_binary",
			"binary must be one of claude, codex, bash")
		return
	}

	cwd := r.URL.Query().Get("cwd")
	if cwd == "" {
		cwd = os.Getenv("HOME")
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		// Upgrade already wrote a response.
		return
	}
	defer conn.Close()

	cmd := exec.Command(binary)
	cmd.Dir = cwd

	// Avoid leaking parent secrets into the child if requested. We pass
	// through the parent env intentionally so claude / codex can find their
	// auth state under HOME, but we strip BROKER_TENANT_TOKEN so the child
	// process never sees it.
	cmd.Env = filteredEnv(os.Environ(), []string{"BROKER_TENANT_TOKEN"})

	ptmx, err := pty.Start(cmd)
	if err != nil {
		_ = conn.WriteMessage(websocket.TextMessage,
			[]byte(`{"error":{"code":"pty_start_failed","message":"failed to start PTY"}}`))
		return
	}
	defer func() {
		_ = ptmx.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	}()

	// We deliberately log without secrets.
	log("ws: started binary=%s cwd=%s pid=%d token=%s", binary, cwd, cmd.Process.Pid, redact(token))

	bridgePTY(conn, ptmx, cmd)
}

// bridgePTY shovels frames between the WS client and the PTY until either
// side closes or the child exits.
func bridgePTY(conn *websocket.Conn, ptmx interface {
	io.Reader
	io.Writer
	io.Closer
}, cmd *exec.Cmd) {
	var wg sync.WaitGroup
	done := make(chan struct{})
	closeOnce := sync.Once{}
	closeDone := func() { closeOnce.Do(func() { close(done) }) }

	// PTY -> WebSocket
	wg.Add(1)
	go func() {
		defer wg.Done()
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				frame := append([]byte{frameStdout}, buf[:n]...)
				if werr := conn.WriteMessage(websocket.BinaryMessage, frame); werr != nil {
					closeDone()
					return
				}
			}
			if err != nil {
				closeDone()
				return
			}
		}
	}()

	// WebSocket -> PTY
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			mt, data, err := conn.ReadMessage()
			if err != nil {
				closeDone()
				return
			}
			if mt != websocket.BinaryMessage || len(data) < 1 {
				continue
			}
			switch data[0] {
			case frameStdin:
				if _, werr := ptmx.Write(data[1:]); werr != nil {
					closeDone()
					return
				}
			case frameResize:
				if len(data) >= 5 {
					rows := binary.BigEndian.Uint16(data[1:3])
					cols := binary.BigEndian.Uint16(data[3:5])
					if f, ok := ptmx.(interface {
						Fd() uintptr
					}); ok {
						_ = pty.Setsize(asFile(f.Fd()), &pty.Winsize{
							Rows: rows,
							Cols: cols,
						})
					}
				}
			default:
				// Unknown frame type — ignore, don't crash.
			}
		}
	}()

	// Reap child. The exit frame should always be emitted if the child
	// exits, even if the PTY-read goroutine has already returned (which
	// would otherwise close `done` first when the PTY closes).
	exitCh := make(chan int, 1)
	go func() {
		err := cmd.Wait()
		code := 0
		if err != nil {
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				code = ee.ExitCode()
			} else {
				code = -1
			}
		}
		exitCh <- code
	}()

	// Wait up to 2s after the PTY closes for the child to be reaped, so
	// we can include the exit code in the frame. If the WS dies first,
	// we just bail without an exit frame.
	select {
	case code := <-exitCh:
		var frame [5]byte
		frame[0] = frameExit
		binary.BigEndian.PutUint32(frame[1:5], uint32(int32(code)))
		_ = conn.WriteMessage(websocket.BinaryMessage, frame[:])
	case <-done:
		// PTY/WS closed before we saw cmd.Wait; give the reaper a brief
		// grace period to deliver the exit code.
		select {
		case code := <-exitCh:
			var frame [5]byte
			frame[0] = frameExit
			binary.BigEndian.PutUint32(frame[1:5], uint32(int32(code)))
			_ = conn.WriteMessage(websocket.BinaryMessage, frame[:])
		case <-time.After(2 * time.Second):
		}
	}

	wg.Wait()
}

// asFile is a tiny helper so the non-portable os.NewFile call stays in one
// place. The PTY's Fd() returns the underlying file descriptor and pty.Setsize
// actually wants an *os.File. We construct it without taking ownership.
func asFile(fd uintptr) *os.File {
	return os.NewFile(fd, "pty")
}

// filteredEnv returns parent env with the named keys removed.
func filteredEnv(env []string, drop []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		i := indexByte(kv, '=')
		if i < 0 {
			out = append(out, kv)
			continue
		}
		k := kv[:i]
		skip := false
		for _, d := range drop {
			if k == d {
				skip = true
				break
			}
		}
		if !skip {
			out = append(out, kv)
		}
	}
	return out
}

func indexByte(s string, c byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return i
		}
	}
	return -1
}

// spawnRequest is the body of POST /spawn.
type spawnRequest struct {
	Binary string   `json:"binary"`
	Args   []string `json:"args"`
	Cwd    string   `json:"cwd"`
	// TimeoutSec optionally bounds the run; defaults to 60s.
	TimeoutSec int `json:"timeout_sec"`
}

// spawnResponse is the JSON envelope returned by /spawn.
type spawnResponse struct {
	ExitCode int    `json:"exit_code"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	TimedOut bool   `json:"timed_out"`
}

// spawnHandler runs a binary headless and returns combined output.
func spawnHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method_not_allowed",
			"only POST is allowed on /spawn")
		return
	}
	// /spawn requires the same broker token, supplied as Bearer auth or
	// as ?token=, to keep it useful for both interactive and CI contexts.
	tok := r.URL.Query().Get("token")
	if tok == "" {
		ah := r.Header.Get("Authorization")
		if strings.HasPrefix(ah, "Bearer ") {
			tok = strings.TrimPrefix(ah, "Bearer ")
		}
	}
	expected := brokerToken()
	if expected == "" {
		jsonError(w, http.StatusInternalServerError, "broker_token_unset",
			"BROKER_TENANT_TOKEN is not set on this machine")
		return
	}
	if !constantTimeStringEq(tok, expected) {
		jsonError(w, http.StatusUnauthorized, "invalid_token",
			"missing or invalid token")
		return
	}

	var req spawnRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "bad_request",
			"invalid JSON body")
		return
	}
	if _, ok := allowedBinaries[req.Binary]; !ok {
		jsonError(w, http.StatusBadRequest, "invalid_binary",
			"binary must be one of claude, codex, bash")
		return
	}
	if req.TimeoutSec <= 0 {
		req.TimeoutSec = 60
	}
	if req.Cwd == "" {
		req.Cwd = os.Getenv("HOME")
	}

	ctx, cancel := context.WithTimeout(r.Context(),
		time.Duration(req.TimeoutSec)*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, req.Binary, req.Args...)
	cmd.Dir = req.Cwd
	cmd.Env = filteredEnv(os.Environ(), []string{"BROKER_TENANT_TOKEN"})

	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	resp := spawnResponse{
		Stdout: stdout.String(),
		Stderr: stderr.String(),
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		resp.TimedOut = true
	}
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			resp.ExitCode = ee.ExitCode()
		} else {
			resp.ExitCode = -1
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)

	log("spawn: binary=%s args=%v exit=%d timed_out=%v", req.Binary, req.Args, resp.ExitCode, resp.TimedOut)
}

// log writes to stderr without ever including secrets. We intentionally
// keep this tiny rather than pulling in a logging library.
func log(format string, args ...any) {
	_, _ = os.Stderr.WriteString(time.Now().UTC().Format(time.RFC3339) + " [broker] " + fmt.Sprintf(format, args...) + "\n")
}

// run starts the HTTP server with graceful shutdown on SIGTERM/SIGINT.
func run() error {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", healthHandler)
	mux.HandleFunc("/ws", wsHandler)
	mux.HandleFunc("/spawn", spawnHandler)

	srv := &http.Server{
		Addr:              ":" + brokerPort(),
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	idleConnsClosed := make(chan struct{})
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		log("shutdown: signal received")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
		close(idleConnsClosed)
	}()

	log("listening on %s (token=%s)", srv.Addr, redact(brokerToken()))
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	<-idleConnsClosed
	return nil
}

func main() {
	if err := run(); err != nil {
		log("fatal: %v", err)
		os.Exit(1)
	}
}
