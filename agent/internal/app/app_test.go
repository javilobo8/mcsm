package app

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/store"
)

const specJSON = `{"imageTag":"java21","type":"PAPER","version":"1.21.4","memory":"2G","ports":{"game":25565},"restartPolicy":"unless-stopped","rconPassword":"abcdefgh"}`

type sink struct {
	mu   sync.Mutex
	envs []*mcsmv1.Envelope
	ch   chan *mcsmv1.Envelope
}

func newSink() *sink { return &sink{ch: make(chan *mcsmv1.Envelope, 64)} }

func (s *sink) send(e *mcsmv1.Envelope) error {
	s.mu.Lock()
	s.envs = append(s.envs, e)
	s.mu.Unlock()
	s.ch <- e
	return nil
}

func (s *sink) next(t *testing.T) *mcsmv1.Envelope {
	t.Helper()
	select {
	case e := <-s.ch:
		return e
	case <-time.After(3 * time.Second):
		t.Fatal("no response")
		return nil
	}
}

// waitID discards messages until receiving the response with that id.
func (s *sink) waitID(t *testing.T, id uint64) *mcsmv1.Envelope {
	t.Helper()
	for {
		if e := s.next(t); e.Id == id {
			return e
		}
	}
}

func newApp(t *testing.T) (*App, *docker.Fake, *store.Store) {
	t.Helper()
	fake := docker.NewFake()
	a, st := newAppEngine(t, fake)
	return a, fake, st
}

// newAppEngine builds the App over any Engine (fake wrappers).
func newAppEngine(t *testing.T, eng docker.Engine) (*App, *store.Store) {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	cfg := Config{DataRoot: filepath.Join(dir, "data"), Network: "mcsm", Version: "test"}
	a := New(cfg, st, eng, slog.Default())
	a.status = func(context.Context, string, uint16) *mcsmv1.McStatus { return &mcsmv1.McStatus{Online: true} }
	// Background tasks finish before closing the store.
	t.Cleanup(a.bg.Wait)
	return a, st
}

// waitBackground waits for the background tasks (synchronization and dispatches) to finish.
func waitBackground(t *testing.T, a *App) {
	t.Helper()
	done := make(chan struct{})
	go func() { a.bg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the background tasks did not finish")
	}
}

// runEventLoop starts the event loop and, when the test ends, stops it and waits for it to exit. The cleanup is
// registered after newApp's, so it runs before its bg.Wait: a dispatch from the loop (bg.Add) at the same time
// as that Wait is a race.
func runEventLoop(t *testing.T, a *App) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		a.eventLoop(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
}

func specMsg(id, slug string, v uint64) *mcsmv1.ServerSpec {
	return &mcsmv1.ServerSpec{ServerId: id, Slug: slug, Version: v, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(specJSON)}
}

func TestSyncSpecsAndObserved(t *testing.T) {
	a, fake, st := newApp(t)
	s := newSink()
	a.send = s.send
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 7, Body: &mcsmv1.Envelope_SyncSpecs{SyncSpecs: &mcsmv1.SyncSpecs{Servers: []*mcsmv1.ServerSpec{specMsg("a", "alpha", 1)}}}}, s.send)
	var sawObserved, sawAck bool
	// The Ack goes out after storing the spec; the reconciliation (and its ServerObserved) runs in the background.
	for !sawObserved || !sawAck {
		e := s.next(t)
		if e.GetServerObserved() != nil && e.GetServerObserved().ServerId == "a" && e.GetServerObserved().Observed.State == "running" {
			sawObserved = true
		}
		if e.Id == 7 && e.GetAck() != nil {
			sawAck = true
		}
	}
	if !sawObserved || !sawAck {
		t.Fatalf("observed=%v ack=%v", sawObserved, sawAck)
	}
	if list, _ := fake.ListManaged(context.Background()); len(list) != 1 {
		t.Fatal("it must have created the container")
	}
	if sp, _ := st.GetSpec("a"); sp == nil {
		t.Fatal("the spec must remain in the store")
	}
	// removed_ids deletes container and spec
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 8, Body: &mcsmv1.Envelope_SyncSpecs{SyncSpecs: &mcsmv1.SyncSpecs{RemovedIds: []string{"a"}}}}, s.send)
	s.waitID(t, 8)
	if sp, _ := st.GetSpec("a"); sp != nil {
		t.Fatal("the withdrawn spec is deleted before the Ack")
	}
	waitBackground(t, a)
	if list, _ := fake.ListManaged(context.Background()); len(list) != 0 {
		t.Fatal("it must have deleted the container")
	}
	if sp, _ := st.GetSpec("a"); sp != nil {
		t.Fatal("the spec must be deleted")
	}
}

func TestApplySpecErrorIsReported(t *testing.T) {
	a, fake, _ := newApp(t)
	s := newSink()
	a.send = s.send
	fake.CreateErr = context.DeadlineExceeded
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 9, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: specMsg("a", "alpha", 1)}}}, s.send)
	e := s.waitID(t, 9)
	if e.GetError() == nil || e.GetError().Code != "apply_failed" {
		t.Fatalf("resp = %+v", e)
	}
}

func TestApplySpecInvalidSlugRejected(t *testing.T) {
	a, fake, st := newApp(t)
	s := newSink()
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 3, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: specMsg("a", "../etc", 1)}}}, s.send)
	e := s.waitID(t, 3)
	if e.GetError() == nil || e.GetError().Code != "invalid_spec" {
		t.Fatalf("resp = %+v", e)
	}
	if list, _ := fake.ListManaged(context.Background()); len(list) != 0 {
		t.Fatal("it must not create containers")
	}
	if sp, _ := st.GetSpec("a"); sp != nil {
		t.Fatal("it must not store the spec")
	}
}

func TestRemoveServerDeletesContainerAndSpec(t *testing.T) {
	a, fake, st := newApp(t)
	s := newSink()
	a.send = s.send
	ctx := context.Background()
	a.Handle(ctx, &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: specMsg("a", "alpha", 1)}}}, s.send)
	s.waitID(t, 1)
	a.Handle(ctx, &mcsmv1.Envelope{Id: 2, Body: &mcsmv1.Envelope_RemoveServer{RemoveServer: &mcsmv1.RemoveServer{ServerId: "a"}}}, s.send)
	if e := s.waitID(t, 2); e.GetAck() == nil {
		t.Fatalf("resp = %+v", e)
	}
	if list, _ := fake.ListManaged(ctx); len(list) != 0 {
		t.Fatal("container not deleted")
	}
	if sp, _ := st.GetSpec("a"); sp != nil {
		t.Fatal("spec not deleted")
	}
}

func TestSendCommandUsesRcon(t *testing.T) {
	a, _, st := newApp(t)
	_ = st.PutSpec(specMsg("a", "alpha", 1))
	var gotHost, gotPw, gotCmd string
	var gotPort uint16
	a.rcon = func(_ context.Context, host string, port uint16, pw, cmd string) (string, error) {
		gotHost, gotPort, gotPw, gotCmd = host, port, pw, cmd
		return "ok", nil
	}
	s := newSink()
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 4, Body: &mcsmv1.Envelope_SendCommand{SendCommand: &mcsmv1.SendCommand{ServerId: "a", Command: "list"}}}, s.send)
	e := s.waitID(t, 4)
	if e.GetCommandResult() == nil || e.GetCommandResult().Output != "ok" {
		t.Fatalf("resp = %+v", e)
	}
	if gotHost != "mcsm-alpha" || gotPort != 25575 || gotPw != "abcdefgh" || gotCmd != "list" {
		t.Fatalf("rcon args: %s %d %s %s", gotHost, gotPort, gotPw, gotCmd)
	}
}

// startStream opens a log stream and waits for the follower to be subscribed
// rewriting a line until it arrives (the fake drops lines without a reader).
func startStream(t *testing.T, a *App, fake *docker.Fake, s *sink, ctx context.Context, id uint64, serverID string) *logStream {
	t.Helper()
	a.Handle(ctx, &mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_SubscribeLogs{SubscribeLogs: &mcsmv1.SubscribeLogs{ServerId: serverID, Tail: 50}}}, s.send)
	ack := s.next(t)
	if ack.Id != id || ack.StreamId != id || ack.GetAck() == nil {
		t.Fatalf("ack = %+v", ack)
	}
	a.mu.Lock()
	ls := a.streams[id]
	a.mu.Unlock()
	if ls == nil {
		t.Fatal("stream not registered")
	}
	cid := a.rec.ContainerID(ctx, serverID)
	deadline := time.After(3 * time.Second)
	for {
		fake.WriteLog(cid, "2026-10-12T10:00:00Z Done!\n")
		select {
		case e := <-s.ch:
			if e.GetLogLine() != nil {
				if e.StreamId != id || e.GetLogLine().Line != "Done!" || e.GetLogLine().ServerId != serverID {
					t.Fatalf("line = %+v", e)
				}
				return ls
			}
		case <-time.After(10 * time.Millisecond):
		case <-deadline:
			t.Fatal("the stream delivered no lines")
		}
	}
}

func waitDone(t *testing.T, ls *logStream) {
	t.Helper()
	select {
	case <-ls.done:
	case <-time.After(3 * time.Second):
		t.Fatal("the stream's goroutine did not finish")
	}
}

// noMoreLogLines drains what was already sent and checks that a new line does not arrive.
func noMoreLogLines(t *testing.T, s *sink, fake *docker.Fake, cid string) {
	t.Helper()
	for len(s.ch) > 0 {
		<-s.ch
	}
	fake.WriteLog(cid, "2026-10-12T10:00:01Z Late\n")
	select {
	case e := <-s.ch:
		if e.GetLogLine() != nil {
			t.Fatalf("no LogLine must come out after closing: %+v", e)
		}
	case <-time.After(100 * time.Millisecond):
	}
}

func applyAndWait(t *testing.T, a *App, s *sink, id, slug string) {
	t.Helper()
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: specMsg(id, slug, 1)}}}, s.send)
	s.waitID(t, 1)
}

func TestSubscribeLogsStream(t *testing.T) {
	a, fake, _ := newApp(t)
	s := newSink()
	a.send = s.send
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	applyAndWait(t, a, s, "a", "alpha")
	ls := startStream(t, a, fake, s, ctx, 5, "a")
	a.Handle(ctx, &mcsmv1.Envelope{StreamId: 5, Body: &mcsmv1.Envelope_StreamClose{StreamClose: &mcsmv1.StreamClose{}}}, s.send)
	waitDone(t, ls)
	a.mu.Lock()
	_, open := a.streams[5]
	a.mu.Unlock()
	if open {
		t.Fatal("StreamClose must cancel the stream")
	}
	noMoreLogLines(t, s, fake, a.rec.ContainerID(ctx, "a"))
}

// Proto3 rejects strings with invalid UTF-8: without sanitizing, proto.Marshal fails and the line
// (or the command's response) is silently lost.
func TestLogLineAndCommandResultAreValidUTF8(t *testing.T) {
	a, fake, _ := newApp(t)
	s := newSink()
	a.send = s.send
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	applyAndWait(t, a, s, "a", "alpha")
	startStream(t, a, fake, s, ctx, 5, "a")
	fake.WriteLog(a.rec.ContainerID(ctx, "a"), "2026-10-12T10:00:02Z caf\xc3 \xff fin\n")
	for {
		e := s.next(t)
		if ll := e.GetLogLine(); ll != nil {
			if !utf8.ValidString(ll.Line) || ll.Line != "caf\uFFFD \uFFFD fin" {
				t.Fatalf("line = %q", ll.Line)
			}
			if _, err := proto.Marshal(e); err != nil {
				t.Fatal(err)
			}
			break
		}
	}
	a.rcon = func(context.Context, string, uint16, string, string) (string, error) { return "ok \xfe", nil }
	a.Handle(ctx, &mcsmv1.Envelope{Id: 40, Body: &mcsmv1.Envelope_SendCommand{SendCommand: &mcsmv1.SendCommand{ServerId: "a", Command: "list"}}}, s.send)
	e := s.waitID(t, 40)
	if out := e.GetCommandResult().GetOutput(); out != "ok \uFFFD" {
		t.Fatalf("output = %q", out)
	}
	if _, err := proto.Marshal(e); err != nil {
		t.Fatal(err)
	}
}

func TestCancelAllStreamsStopsGoroutinesAndLines(t *testing.T) {
	a, fake, _ := newApp(t)
	s := newSink()
	a.send = s.send
	ctx := context.Background()
	applyAndWait(t, a, s, "a", "alpha")
	ls := startStream(t, a, fake, s, ctx, 5, "a")
	a.cancelAllStreams()
	waitDone(t, ls)
	noMoreLogLines(t, s, fake, a.rec.ContainerID(ctx, "a"))
}

func TestSubscribeLogsUnknownServer(t *testing.T) {
	a, _, _ := newApp(t)
	s := newSink()
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 5, Body: &mcsmv1.Envelope_SubscribeLogs{SubscribeLogs: &mcsmv1.SubscribeLogs{ServerId: "nope"}}}, s.send)
	e := s.next(t)
	if e.Id != 5 || e.GetError() == nil || e.GetError().Code != "unknown_server" {
		t.Fatalf("resp = %+v", e)
	}
	a.mu.Lock()
	n := len(a.streams)
	a.mu.Unlock()
	if n != 0 {
		t.Fatal("it must not open a stream")
	}
}

// A newer panel may send a body this agent does not know: protobuf leaves it
// in unknown fields and Body arrives nil. It answers unsupported asking to update.
func TestUnknownBodyGetsUnsupportedError(t *testing.T) {
	a, _, _ := newApp(t)
	s := newSink()
	raw := protowire.AppendTag(nil, 1, protowire.VarintType)
	raw = protowire.AppendVarint(raw, 12)
	raw = protowire.AppendTag(raw, 99, protowire.BytesType) // oneof field this agent does not have
	raw = protowire.AppendBytes(raw, []byte{0x0a, 0x01, 'x'})
	env := &mcsmv1.Envelope{}
	if err := proto.Unmarshal(raw, env); err != nil || env.Body != nil {
		t.Fatalf("env = %+v err = %v", env, err)
	}
	a.Handle(context.Background(), env, s.send)
	e := s.next(t)
	if e.Id != 12 || e.GetError() == nil || e.GetError().Code != errcode.Unsupported || !strings.Contains(e.GetError().Message, "update the agent") {
		t.Fatalf("resp = %+v", e)
	}
}

// The panel's Ack and Error are never answered: the agent makes no requests and replying to
// an Error with another Error could chain into a loop.
func TestAckAndErrorFromPanelAreNotAnswered(t *testing.T) {
	a, _, _ := newApp(t)
	s := newSink()
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 12, Body: &mcsmv1.Envelope_Ack{Ack: &mcsmv1.Ack{}}}, s.send)
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 13, Body: &mcsmv1.Envelope_Error{Error: &mcsmv1.Error{Code: "x", Message: "y"}}}, s.send)
	select {
	case e := <-s.ch:
		t.Fatalf("it must not respond: %+v", e)
	case <-time.After(50 * time.Millisecond):
	}
}

// A known body that the panel must not send (Hello) is rejected as unsupported.
func TestUnexpectedKnownBodyGetsUnsupported(t *testing.T) {
	a, _, _ := newApp(t)
	s := newSink()
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 14, Body: &mcsmv1.Envelope_Hello{Hello: &mcsmv1.Hello{}}}, s.send)
	if e := s.next(t); e.Id != 14 || e.GetError().GetCode() != errcode.Unsupported {
		t.Fatalf("resp = %+v", e)
	}
}

func syncMsg(id uint64, servers []*mcsmv1.ServerSpec, removed ...string) *mcsmv1.Envelope {
	return &mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_SyncSpecs{SyncSpecs: &mcsmv1.SyncSpecs{Servers: servers, RemovedIds: removed}}}
}

func applyMsg(id uint64, sp *mcsmv1.ServerSpec) *mcsmv1.Envelope {
	return &mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: sp}}}
}

func withMemory(sp *mcsmv1.ServerSpec, mem string) *mcsmv1.ServerSpec {
	sp.SpecJson = []byte(strings.Replace(specJSON, `"memory":"2G"`, `"memory":"`+mem+`"`, 1))
	return sp
}

// containerEnv reads the server container's env. Only after waitBackground: without
// live background tasks nobody else touches the fake.
func containerEnv(t *testing.T, fake *docker.Fake, serverID string) map[string]string {
	t.Helper()
	list, _ := fake.ListManaged(context.Background())
	for _, c := range list {
		if c.Labels["mcsm.server_id"] == serverID {
			env := fake.Containers[c.ID].Config.Env
			m := map[string]string{}
			for _, kv := range env {
				k, v, _ := strings.Cut(kv, "=")
				m[k] = v
			}
			return m
		}
	}
	t.Fatalf("no container for %s", serverID)
	return nil
}

// Within a session, the version guard still applies between ApplySpecs: an
// ApplySpec v6 after a SyncSpecs v5 wins, and a v4 one is ignored.
func TestApplySpecAfterSyncSpecsKeepsNewer(t *testing.T) {
	a, fake, st := newApp(t)
	s := newSink()
	a.send = s.send
	ctx := context.Background()
	a.Handle(ctx, syncMsg(1, []*mcsmv1.ServerSpec{specMsg("a", "alpha", 5)}), s.send)
	if e := s.waitID(t, 1); e.GetAck() == nil {
		t.Fatalf("resp = %+v", e)
	}
	a.Handle(ctx, applyMsg(2, withMemory(specMsg("a", "alpha", 6), "3G")), s.send)
	s.waitID(t, 2)
	a.Handle(ctx, applyMsg(3, withMemory(specMsg("a", "alpha", 4), "4G")), s.send)
	s.waitID(t, 3)
	waitBackground(t, a)
	if sp, _ := st.GetSpec("a"); sp.Version != 6 {
		t.Fatalf("version = %d, want 6", sp.Version)
	}
	if v, _ := st.Applied("a"); v != 6 {
		t.Fatalf("applied = %d, want 6", v)
	}
	if mem := containerEnv(t, fake, "a")["MEMORY"]; mem != "3G" {
		t.Fatalf("the container must end up with spec v6, MEMORY=%s", mem)
	}
}

// In a new session, SyncSpecs forces the panel's snapshot even if it is older than
// the store's (restored panel database).
func TestSyncSpecsForcesOlderSpecOnNewSession(t *testing.T) {
	a, fake, st := newApp(t)
	s := newSink()
	a.send = s.send
	if err := st.PutSpec(withMemory(specMsg("a", "alpha", 6), "3G")); err != nil {
		t.Fatal(err)
	}
	a.Handle(context.Background(), syncMsg(1, []*mcsmv1.ServerSpec{specMsg("a", "alpha", 5)}), s.send)
	s.waitID(t, 1)
	if sp, _ := st.GetSpec("a"); sp.Version != 5 {
		t.Fatalf("SyncSpecs is the panel's truth, version=%d", sp.Version)
	}
	waitBackground(t, a)
	if v, _ := st.Applied("a"); v != 5 {
		t.Fatalf("applied = %d, want 5", v)
	}
	if mem := containerEnv(t, fake, "a")["MEMORY"]; mem != "2G" {
		t.Fatalf("MEMORY=%s, want 2G", mem)
	}
}

// gateEngine blocks EnsureImage until gate is closed.
type gateEngine struct {
	*docker.Fake
	gate chan struct{}
}

func (e gateEngine) EnsureImage(ctx context.Context, ref string) error {
	select {
	case <-e.gate:
	case <-ctx.Done():
		return ctx.Err()
	}
	return e.Fake.EnsureImage(ctx, ref)
}

// SyncSpecs's Ack does not wait for Docker: the panel holds nothing back during a pull.
func TestSyncSpecsAcksBeforeTouchingDocker(t *testing.T) {
	fake := docker.NewFake()
	gate := make(chan struct{})
	a, st := newAppEngine(t, gateEngine{fake, gate})
	s := newSink()
	a.send = s.send
	a.Handle(context.Background(), syncMsg(1, []*mcsmv1.ServerSpec{specMsg("a", "alpha", 1)}), s.send)
	if e := s.waitID(t, 1); e.GetAck() == nil {
		t.Fatalf("resp = %+v", e)
	}
	if sp, _ := st.GetSpec("a"); sp == nil {
		t.Fatal("the spec is stored before the Ack")
	}
	if list, _ := fake.ListManaged(context.Background()); len(list) != 0 {
		t.Fatal("the container cannot exist yet: the pull is blocked")
	}
	close(gate)
	waitBackground(t, a)
	if list, _ := fake.ListManaged(context.Background()); len(list) != 1 || list[0].State != "running" {
		t.Fatalf("after the pull it must be created and started: %+v", list)
	}
}

// A slug deleted and recreated while the node was disconnected: removed_ids is processed first,
// so the new server's Create does not clash with the old container's name.
func TestSyncSpecsReusedSlugAfterOfflineDelete(t *testing.T) {
	a, fake, st := newApp(t)
	s := newSink()
	a.send = s.send
	ctx := context.Background()
	a.Handle(ctx, applyMsg(1, specMsg("old", "alpha", 1)), s.send)
	s.waitID(t, 1)
	a.Handle(ctx, syncMsg(2, []*mcsmv1.ServerSpec{specMsg("new", "alpha", 1)}, "old"), s.send)
	s.waitID(t, 2)
	waitBackground(t, a)
	list, _ := fake.ListManaged(ctx)
	if len(list) != 1 || list[0].Labels["mcsm.server_id"] != "new" || list[0].State != "running" {
		t.Fatalf("only the new container must remain running: %+v (calls %v)", list, fake.Calls)
	}
	if sp, _ := st.GetSpec("old"); sp != nil {
		t.Fatal("the withdrawn spec must not remain")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.envs {
		if o := e.GetServerObserved(); o != nil && o.ServerId == "new" && o.Observed.Error != "" {
			t.Fatalf("the new server must not publish errors: %s", o.Observed.Error)
		}
	}
}

func TestSyncSpecsSkipsInvalidAndStillAcks(t *testing.T) {
	a, _, st := newApp(t)
	s := newSink()
	a.send = s.send
	a.Handle(context.Background(), syncMsg(1, []*mcsmv1.ServerSpec{specMsg("bad", "../x", 1), nil, specMsg("a", "alpha", 1)}), s.send)
	if e := s.waitID(t, 1); e.GetAck() == nil {
		t.Fatalf("resp = %+v", e)
	}
	if sp, _ := st.GetSpec("bad"); sp != nil {
		t.Fatal("a spec with an invalid slug is not stored")
	}
	if sp, _ := st.GetSpec("a"); sp == nil {
		t.Fatal("the valid ones are")
	}
	waitBackground(t, a)
}

func TestPowerAction(t *testing.T) {
	a, _, _ := newApp(t)
	s := newSink()
	ctx := context.Background()
	a.Handle(ctx, &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_PowerAction{PowerAction: &mcsmv1.PowerAction{ServerId: "nope", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP}}}, s.send)
	if e := s.next(t); e.GetError() == nil || e.GetError().Code != "power_failed" {
		t.Fatalf("resp = %+v", e)
	}
	applyAndWait(t, a, s, "a", "alpha")
	a.Handle(ctx, &mcsmv1.Envelope{Id: 2, Body: &mcsmv1.Envelope_PowerAction{PowerAction: &mcsmv1.PowerAction{ServerId: "a", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP}}}, s.send)
	if e := s.waitID(t, 2); e.GetAck() == nil {
		t.Fatalf("resp = %+v", e)
	}
}

func TestSendCommandErrors(t *testing.T) {
	a, _, st := newApp(t)
	s := newSink()
	ctx := context.Background()
	a.Handle(ctx, &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_SendCommand{SendCommand: &mcsmv1.SendCommand{ServerId: "nope", Command: "x"}}}, s.send)
	if e := s.next(t); e.GetError() == nil || e.GetError().Code != "unknown_server" {
		t.Fatalf("resp = %+v", e)
	}
	_ = st.PutSpec(specMsg("a", "alpha", 1))
	a.rcon = func(context.Context, string, uint16, string, string) (string, error) {
		return "", context.DeadlineExceeded
	}
	a.Handle(ctx, &mcsmv1.Envelope{Id: 2, Body: &mcsmv1.Envelope_SendCommand{SendCommand: &mcsmv1.SendCommand{ServerId: "a", Command: "x"}}}, s.send)
	if e := s.next(t); e.GetError() == nil || e.GetError().Code != "rcon_failed" {
		t.Fatalf("resp = %+v", e)
	}
}

// A server blocked in a long operation must not hold back the observation of the others.
func TestBlockedServerDoesNotStallOthers(t *testing.T) {
	a, fake, _ := newApp(t)
	s := newSink()
	a.send = s.send
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	slowSpec := specMsg("slow", "slow", 1)
	fastSpec := specMsg("fast", "fast", 1)
	for i, sp := range []*mcsmv1.ServerSpec{slowSpec, fastSpec} {
		a.Handle(ctx, &mcsmv1.Envelope{Id: uint64(i + 1), Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: sp}}}, s.send)
		s.waitID(t, uint64(i+1))
	}
	// Different Ports do not matter: the fake only clashes on start and both are already running or failed.
	release := make(chan struct{})
	entered := make(chan struct{}, 8)
	a.status = func(_ context.Context, host string, _ uint16) *mcsmv1.McStatus {
		if host == "mcsm-slow" {
			entered <- struct{}{}
			<-release
		}
		return &mcsmv1.McStatus{Online: true}
	}
	defer close(release)
	runEventLoop(t, a)
	slowEv := docker.Event{Action: "die", Labels: map[string]string{"mcsm.server_id": "slow"}}
	fastEv := docker.Event{Action: "die", Labels: map[string]string{"mcsm.server_id": "fast"}}
	deadline := time.After(3 * time.Second)
	slowIn := false
	for {
		fake.EmitEvent(slowEv)
		if slowIn {
			fake.EmitEvent(fastEv)
		}
		select {
		case <-entered:
			slowIn = true
		case e := <-s.ch:
			if o := e.GetServerObserved(); o != nil && o.ServerId == "fast" && slowIn {
				return
			}
		case <-time.After(10 * time.Millisecond):
		case <-deadline:
			t.Fatalf("slowIn=%v: the slow server blocks the rest", slowIn)
		}
	}
}

func TestEventTriggersObserve(t *testing.T) {
	a, fake, _ := newApp(t)
	s := newSink()
	a.send = s.send
	applyAndWait(t, a, s, "a", "alpha")
	runEventLoop(t, a)
	deadline := time.After(3 * time.Second)
	for {
		fake.EmitEvent(docker.Event{Action: "die", Labels: map[string]string{"mcsm.server_id": "a"}})
		select {
		case e := <-s.ch:
			if e.GetServerObserved() != nil {
				return
			}
		case <-time.After(10 * time.Millisecond):
		case <-deadline:
			t.Fatal("the event did not trigger Observe")
		}
	}
}

func TestHelloCarriesVersionsAndDesiredStates(t *testing.T) {
	a, _, st := newApp(t)
	_ = st.PutSpec(specMsg("a", "alpha", 4))
	b := specMsg("b", "beta", 2)
	b.DesiredState = mcsmv1.DesiredState_DESIRED_STATE_STOPPED
	_ = st.PutSpec(b)
	h := a.hello(context.Background())
	if h.SpecVersions["a"] != 4 || h.SpecVersions["b"] != 2 || h.AgentVersion != "test" {
		t.Fatalf("hello = %+v", h)
	}
	if h.DesiredStates["a"] != mcsmv1.DesiredState_DESIRED_STATE_RUNNING || h.DesiredStates["b"] != mcsmv1.DesiredState_DESIRED_STATE_STOPPED {
		t.Fatalf("desired_states = %v", h.DesiredStates)
	}
}

func TestLoadConfigValidation(t *testing.T) {
	t.Setenv("PANEL_URL", "panel:3000")
	if _, err := LoadConfig("x"); err == nil {
		t.Fatal("PANEL_URL without an http/https scheme must fail")
	}
	t.Setenv("PANEL_URL", "http://p")
	t.Setenv("DATA_ROOT", "relative/path")
	if _, err := LoadConfig("x"); err == nil {
		t.Fatal("a relative DATA_ROOT must fail")
	}
}

func TestLoadConfigRequiresPanelURL(t *testing.T) {
	t.Setenv("PANEL_URL", "")
	if _, err := LoadConfig("x"); err == nil {
		t.Fatal("it must require PANEL_URL")
	}
	t.Setenv("PANEL_URL", "http://p")
	cfg, err := LoadConfig("x")
	if err != nil || cfg.DataRoot != "/srv/minecraft" || cfg.Network != "mcsm" {
		t.Fatalf("cfg=%+v err=%v", cfg, err)
	}
}

// ctxEngine imitates Moby: operations fail if the context is cancelled.
type ctxEngine struct{ *docker.Fake }

func (e ctxEngine) EnsureImage(ctx context.Context, ref string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return e.Fake.EnsureImage(ctx, ref)
}

func (e ctxEngine) ListManaged(ctx context.Context) ([]docker.Container, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return e.Fake.ListManaged(ctx)
}

func (e ctxEngine) Stop(ctx context.Context, id string, t time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return e.Fake.Stop(ctx, id, t)
}

func (e ctxEngine) Remove(ctx context.Context, id string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return e.Fake.Remove(ctx, id)
}

// A WS session drop must not cancel the operations that mutate Docker: they use the
// agent's life context, not the session's.
func TestMutatingHandlersSurviveSessionCancel(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	fake := docker.NewFake()
	a := New(Config{DataRoot: filepath.Join(dir, "data"), Network: "mcsm", Version: "test"}, st, ctxEngine{fake}, slog.Default())
	a.status = func(context.Context, string, uint16) *mcsmv1.McStatus { return &mcsmv1.McStatus{Online: true} }
	s := newSink()
	a.send = s.send
	session, cancel := context.WithCancel(context.Background())
	cancel() // the session was already cut when the handler reaches Docker

	a.Handle(session, &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: specMsg("a", "alpha", 1)}}}, s.send)
	if e := s.waitID(t, 1); e.GetAck() == nil {
		t.Fatalf("ApplySpec with the session cut: %+v", e)
	}
	if list, _ := fake.ListManaged(context.Background()); len(list) != 1 || list[0].State != "running" {
		t.Fatalf("the container must be created and started: %+v", list)
	}
	a.Handle(session, &mcsmv1.Envelope{Id: 2, Body: &mcsmv1.Envelope_PowerAction{PowerAction: &mcsmv1.PowerAction{ServerId: "a", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP}}}, s.send)
	if e := s.waitID(t, 2); e.GetAck() == nil {
		t.Fatalf("PowerAction with the session cut: %+v", e)
	}
	a.Handle(session, &mcsmv1.Envelope{Id: 3, Body: &mcsmv1.Envelope_RemoveServer{RemoveServer: &mcsmv1.RemoveServer{ServerId: "a"}}}, s.send)
	if e := s.waitID(t, 3); e.GetAck() == nil {
		t.Fatalf("RemoveServer with the session cut: %+v", e)
	}
	if list, _ := fake.ListManaged(context.Background()); len(list) != 0 {
		t.Fatalf("the container must be deleted: %+v", list)
	}
}

// failRemoveEngine makes Remove fail while fail is active.
type failRemoveEngine struct {
	*docker.Fake
	mu   sync.Mutex
	fail bool
}

func (e *failRemoveEngine) setFail(v bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.fail = v
}

func (e *failRemoveEngine) Remove(ctx context.Context, id string) error {
	e.mu.Lock()
	fail := e.fail
	e.mu.Unlock()
	if fail {
		return errors.New("docker: could not delete")
	}
	return e.Fake.Remove(ctx, id)
}

// If the background deletion of a server withdrawn by SyncSpecs fails, the reconciliation tick
// retries it even though its spec no longer exists (the reconciler's tombstone).
func TestSyncSpecsFailedRemovalIsRetriedByTick(t *testing.T) {
	fake := docker.NewFake()
	eng := &failRemoveEngine{Fake: fake}
	a, st := newAppEngine(t, eng)
	s := newSink()
	a.send = s.send
	ctx := context.Background()
	a.Handle(ctx, applyMsg(1, specMsg("a", "alpha", 1)), s.send)
	s.waitID(t, 1)
	eng.setFail(true)
	a.Handle(ctx, syncMsg(2, nil, "a"), s.send)
	s.waitID(t, 2)
	waitBackground(t, a)
	if list, _ := fake.ListManaged(ctx); len(list) != 1 {
		t.Fatalf("the deletion failed: the container remains: %+v", list)
	}
	if vers, _ := st.SpecVersions(); len(vers) != 0 {
		t.Fatalf("the withdrawn server does not return to the Hello: %v", vers)
	}
	eng.setFail(false)
	a.reconcileAll(ctx) // tick
	waitBackground(t, a)
	if list, _ := fake.ListManaged(ctx); len(list) != 0 {
		t.Fatalf("the tick must retry the deletion: %+v", list)
	}
	if calls := strings.Join(fake.Calls, ";"); strings.Count(calls, "Create") != 1 {
		t.Fatalf("it must not resurrect: %v", fake.Calls)
	}
}

func powerMsg(id uint64, serverID string, act mcsmv1.PowerActionType) *mcsmv1.Envelope {
	return &mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_PowerAction{PowerAction: &mcsmv1.PowerAction{ServerId: serverID, Action: act}}}
}

func removeMsg(id uint64, serverID string, deleteData bool) *mcsmv1.Envelope {
	return &mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_RemoveServer{RemoveServer: &mcsmv1.RemoveServer{ServerId: serverID, DeleteData: deleteData}}}
}

// Power and Remove on a reserved server (backup or restore in progress) answer
// busy, which the panel translates to 409, not power_failed/remove_failed (502).
func TestPowerAndRemoveOnHeldServerAreBusy(t *testing.T) {
	a, fake, st := newApp(t)
	s := newSink()
	a.send = s.send
	ctx := context.Background()
	a.Handle(ctx, applyMsg(1, specMsg("a", "alpha", 1)), s.send)
	if e := s.waitID(t, 1); e.GetAck() == nil {
		t.Fatalf("resp = %+v", e)
	}
	release, err := a.rec.Hold("a", "backup")
	if err != nil {
		t.Fatal(err)
	}
	a.Handle(ctx, powerMsg(2, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP), s.send)
	if e := s.waitID(t, 2); e.GetError().GetCode() != errcode.Busy {
		t.Fatalf("Power reserved = %+v, want busy", e)
	}
	a.Handle(ctx, removeMsg(3, "a", false), s.send)
	if e := s.waitID(t, 3); e.GetError().GetCode() != errcode.Busy {
		t.Fatalf("Remove reserved = %+v, want busy", e)
	}
	if sp, _ := st.GetSpec("a"); sp == nil {
		t.Fatal("the spec remains")
	}
	if list, _ := fake.ListManaged(ctx); len(list) != 1 || list[0].State != "running" {
		t.Fatalf("the container is not touched: %+v", list)
	}
	release(ctx)
	a.Handle(ctx, powerMsg(4, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP), s.send)
	if e := s.waitID(t, 4); e.GetAck() == nil {
		t.Fatalf("after releasing, Power = %+v", e)
	}
}

// ApplySpec with the server reserved does not fail: it stores the spec, answers Ack and applies it
// when the reservation is released.
func TestApplySpecOnHeldServerIsDeferred(t *testing.T) {
	a, fake, st := newApp(t)
	s := newSink()
	a.send = s.send
	ctx := context.Background()
	a.Handle(ctx, applyMsg(1, specMsg("a", "alpha", 1)), s.send)
	s.waitID(t, 1)
	release, err := a.rec.Hold("a", "restore")
	if err != nil {
		t.Fatal(err)
	}
	a.Handle(ctx, applyMsg(2, withMemory(specMsg("a", "alpha", 2), "3G")), s.send)
	if e := s.waitID(t, 2); e.GetAck() == nil {
		t.Fatalf("ApplySpec reserved = %+v, want Ack", e)
	}
	waitBackground(t, a)
	if mem := containerEnv(t, fake, "a")["MEMORY"]; mem != "2G" {
		t.Fatalf("during the reservation it is not recreated: MEMORY=%s", mem)
	}
	release(ctx)
	if mem := containerEnv(t, fake, "a")["MEMORY"]; mem != "3G" {
		t.Fatalf("on release the deferred spec is applied: MEMORY=%s", mem)
	}
	if v, _ := st.Applied("a"); v != 2 {
		t.Fatalf("applied = %d, want 2", v)
	}
}

// A withdrawn slug (with its container still to be deleted) recreated with another id: the tick deletes
// the old container first and then reconciles the new one, which does not clash with the name
// nor fall into backoff.
func TestTickRemovesTombstonesBeforeReconciling(t *testing.T) {
	fake := docker.NewFake()
	eng := &failRemoveEngine{Fake: fake}
	a, st := newAppEngine(t, eng)
	s := newSink()
	a.send = s.send
	ctx := context.Background()
	a.Handle(ctx, applyMsg(1, specMsg("old", "alpha", 1)), s.send)
	s.waitID(t, 1)
	eng.setFail(true)
	a.Handle(ctx, syncMsg(2, nil, "old"), s.send)
	s.waitID(t, 2)
	waitBackground(t, a)
	eng.setFail(false)
	if err := a.rec.StoreForce(specMsg("new", "alpha", 1)); err != nil {
		t.Fatal(err)
	}
	a.reconcileAll(ctx) // tick
	waitBackground(t, a)
	list, _ := fake.ListManaged(ctx)
	if len(list) != 1 || list[0].Labels["mcsm.server_id"] != "new" || list[0].State != "running" {
		t.Fatalf("only the new container must remain running: %+v (calls %v)", list, fake.Calls)
	}
	if v, _ := st.Applied("new"); v != 1 {
		t.Fatalf("the new server is applied in the same tick: applied = %d", v)
	}
}
