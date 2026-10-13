package conn

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// ErrTransferNotFound: the panel answered 404 to the transfer_id (expired, already used or from another node).
var ErrTransferNotFound = errors.New("the panel does not recognize the transfer (expired, already used or from another node)")

// errTransferAuth: the panel rejected the node token (401/403). It is not retried: the same
// token would fail again.
var errTransferAuth = errors.New("the panel rejected the node token")

// transferIDRe: 32 random bytes in unpadded base64url, as the panel generates them.
var transferIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

const (
	// transferHeaderTimeout bounds the wait for the response once the whole request has been sent
	// (in a PUT, after the last byte of the body). Bodies have no deadline: a large upload
	// can take as long as it needs and only the context cuts it off.
	transferHeaderTimeout = 60 * time.Second
	panelErrBodyMax       = 4 << 10 // bytes read from the body of an error response
	panelErrMsgMax        = 300     // bytes of the panel's message that go into the error
)

// newTransferHTTP creates the transfer client. Deadlines only for connecting and for waiting for
// headers; never for the whole body.
func newTransferHTTP(headerTimeout time.Duration) *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}).DialContext,
			TLSHandshakeTimeout:   dialTimeout,
			ResponseHeaderTimeout: headerTimeout,
			// One connection per transfer (they are few and long): without reused connections
			// net/http does not retry on its own a request the panel may have received (a repeated
			// GET would find the transfer already consumed) and no idle goroutines are left.
			DisableKeepAlives: true,
			// Bytes as they are: Content-Length is the real size and there is no uncapped decompression.
			DisableCompression: true,
		},
		// No redirects: a 302 would turn the PUT into a body-less GET that would "work" and
		// would carry the request, with the token, to another path.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

var transferHTTP = newTransferHTTP(transferHeaderTimeout)

// TransferClient makes the agent's outbound HTTP transfers (spec §5.1): GET and PUT
// /agent/transfer/{id} against the panel with the node token. It writes no logs and its errors
// never carry the token.
type TransferClient struct {
	base  string
	token string
	http  *http.Client
}

// NewTransferClient creates a client for the panel at panelURL with the node token.
func NewTransferClient(panelURL, token string) *TransferClient {
	return &TransferClient{base: strings.TrimRight(panelURL, "/"), token: token, http: transferHTTP}
}

// do sends the request and returns the response only if it is 2xx (the caller closes its body).
func (c *TransferClient) do(ctx context.Context, method, id string, body io.Reader, size int64) (*http.Response, error) {
	if !transferIDRe.MatchString(id) {
		return nil, errors.New("invalid transfer_id")
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+"/agent/transfer/"+id, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.ContentLength = size
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, netCause(err)
	}
	if err := c.statusErr(resp); err != nil {
		resp.Body.Close()
		return nil, err
	}
	return resp, nil
}

func (c *TransferClient) statusErr(resp *http.Response) error {
	switch code := resp.StatusCode; {
	case code >= 200 && code < 300:
		return nil
	case code == http.StatusNotFound:
		return ErrTransferNotFound
	case code == http.StatusUnauthorized || code == http.StatusForbidden:
		return fmt.Errorf("%w (%d)", errTransferAuth, code)
	default:
		return fmt.Errorf("the panel responded %d: %s", code, c.panelMessage(resp))
	}
}

// panelMessage extracts the message from a panel error response ({"error": "…"}), without the
// token and as valid UTF-8. Any other body (a proxy's page, for example) is not copied: the
// HTTP status text remains.
func (c *TransferClient) panelMessage(resp *http.Response) string {
	msg := http.StatusText(resp.StatusCode)
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, panelErrBodyMax))
	var body struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(raw, &body) == nil && strings.TrimSpace(body.Error) != "" {
		msg = strings.TrimSpace(body.Error)
	}
	if c.token != "" {
		msg = strings.ReplaceAll(msg, c.token, "[token]")
	}
	if len(msg) > panelErrMsgMax {
		msg = msg[:panelErrMsgMax] + "…"
	}
	if msg == "" {
		msg = "no detail"
	}
	return strings.ToValidUTF8(msg, "�")
}

// Get opens a panel → agent transfer. It returns the body as a stream (the caller closes
// it) and its size, or -1 if the panel did not send Content-Length. With Content-Length the body
// delivers exactly those bytes: if the panel cuts off early, the read fails with
// io.ErrUnexpectedEOF. Cancelling ctx also cuts the body read.
func (c *TransferClient) Get(ctx context.Context, id string) (io.ReadCloser, int64, error) {
	resp, err := c.do(ctx, http.MethodGet, id, nil, 0)
	if err != nil {
		return nil, 0, err
	}
	return scrubBody{resp.Body}, resp.ContentLength, nil
}

// netCause leaves a network error with only its cause: without the *url.Error URL (it carries the
// transfer_id) or the addresses of *net.OpError and *net.DNSError. The message ends up in the
// browser (agent Error → 502 with its text). errors.Is still sees the cause
// (context.Canceled, ECONNREFUSED, io.ErrUnexpectedEOF…).
func netCause(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) && ue.Err != nil {
		err = ue.Err
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return fmt.Errorf("cannot resolve the panel's name: %s", dns.Err)
	}
	var op *net.OpError
	if errors.As(err, &op) && op.Err != nil {
		return op.Err
	}
	return err
}

// scrubBody cleans body read errors with netCause (a RST from the panel midway
// brings the connection's addresses).
type scrubBody struct{ io.ReadCloser }

func (b scrubBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if err != nil && err != io.EOF {
		err = netCause(err)
	}
	return n, err
}

// readerOnly hides Close (and any other method) of the caller's body.
type readerOnly struct{ io.Reader }

// Put sends body in an agent → panel transfer and returns when the panel answers 2xx
// (it has received and handed over all of it). size >= 0 sets Content-Length (0 sends an empty body)
// and the request fails if body does not carry exactly size bytes; -1 uses chunked. Put does not close
// body; as in net/http, after an error body may still be read for a moment in another
// goroutine: the caller must not reuse it, only close it (*os.File and io.Pipe support this).
func (c *TransferClient) Put(ctx context.Context, id string, body io.Reader, size int64) error {
	if body == nil {
		body = http.NoBody
	}
	switch {
	case size == 0:
		body = http.NoBody // with ContentLength 0 and a non-nil body, net/http would use chunked
	case size > 0 && size+1 > 0:
		// If body carries too much, net/http would read the rest in full to measure it (with a source that
		// never ends, forever); one extra byte is enough to fail.
		body = io.LimitReader(body, size+1)
	default:
		if size < 0 {
			size = -1
		}
		body = readerOnly{body}
	}
	resp, err := c.do(ctx, http.MethodPut, id, body, size)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}
